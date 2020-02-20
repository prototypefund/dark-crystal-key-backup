const secrets = require('secret-sharing')
const s = require('key-backup-crypto')
const log = require('debug')('key-backup')
const pull = require('pull-stream')
const schemas = require('key-backup-message-schemas')
const assert = require('assert')
const util = require('util')
const maybe = require('call-me-maybe')
const homeDir = require('os').homedir()
const path = require('path')
const EphemeralKeys = require('ephemeral-keys')

const version = '1.0.0'

module.exports = (options) => new Member(options)

class Member {
  constructor (options = {}) {
    this.keypair = options.keypair || s.keypair()
    this.id = this.keypair.publicKey.toString('hex')
    this.publish = options.publish // ||
    this.publishCB = options.publishCB
    this.query = options.query // ||
    this.encoder = options.encoder || jsonEncoder
    this.messageToId = options.messageToId || this._defaultMessageToId
    this.options = options

    const ephemeralKeysOpts = {}
    if (options.ephemeral) {
      this.storage = options.storage || path.join(homeDir, '.key-backup')
      ephemeralKeysOpts.dir = path.join(options.storage, 'ephemeral-keys')
    }
    this.ephemeralKeys = EphemeralKeys(ephemeralKeysOpts)
  }

  share (options, callback) {
    const self = this
    return maybe(callback, sharePromise(options))

    async function sharePromise (options) {
      const { secret, label, shards, quorum, custodians, name } = options

      const packedSecret = s.packLabel(secret, label)

      const rawShards = await secrets.share(packedSecret, shards, quorum)
      const signedShards = s.signShards(rawShards, self.keypair)

      const boxedShards = signedShards.map((shard, i) => {
        return s.oneWayBox(shard, custodians[i])
      })

      const rootMessage = self._buildMessage('root', { label, shards, quorum, tool: 'sss' })
      assert(schemas.isRoot(rootMessage), schemas.errorParser(schemas.isRoot))
      const root = self.messageToId(rootMessage)
      const shardMessages = boxedShards.map((shard, i) => {
        return self._buildMessage('shard', {
          root,
          name,
          shard: shard.toString('hex'),
          recipient: custodians[i].toString('hex')
        })
      })
      shardMessages.forEach((s) => {
        assert(schemas.isShard(s))
      })

      log(rootMessage)
      log(JSON.stringify(shardMessages, null, 4))

      const boxedShardMessages = shardMessages.map((shardMessage, i) => {
        return self.encodeAndBox(shardMessage, custodians[i])
      })

      const boxedRootMessage = self.encodeAndBox(rootMessage, self.keypair.publicKey)

      // Publish all messages at once
      await self._bulkPublish(boxedShardMessages.concat([boxedRootMessage]))
      return root
    }
  }

  combine (root, secretOwnerId, callback) {
    if (typeof secretOwnerId === 'function' && !callback) {
      callback = secretOwnerId
      secretOwnerId = undefined
    }
    const self = this
    return callback
      ? combineCB(root, secretOwnerId, callback)
      : util.promisify(combineCB)(root, secretOwnerId)

    function combineCB (root, secretOwnerId, callback) {
      pull(
        self.messagesByType(['reply', 'forward']),
        pull.filter((msg) => {
          return schemas.isReply(msg) || schemas.isForward(msg)
        }),
        pull.filter(msg => msg.root === root),
        pull.asyncMap((msg, cb) => {
          const rawShard = Buffer.from(msg.shard, 'hex')

          // TODO check if shard is ephemeral encrypted
          // if it is, find the key for that shard and decrypt
          if (self.ephemeralKeys.isBoxedMessage(rawShard)) {
            const dbKey = { root, recipient: msg.author }
            self.ephemeralKeys.unBoxMessage(dbKey, rawShard, Buffer.from(JSON.stringify({})), (err, shard) => {
              if (err) return cb(err)
              processShard(shard)
            })
          } else {
            processShard(rawShard)
          }

          function processShard (signedShard) {
            const isReplyMsg = schemas.isReply(msg)
            let shard
            if (!isReplyMsg && !secretOwnerId) {
              // we cannot verify because we do not know who it is from
              shard = false
            } else {
              const secretOwnersKey = isReplyMsg
                ? self.keypair.publicKey
                : Buffer.from(secretOwnerId, 'hex')

              shard = s.openShard(signedShard, secretOwnersKey)
            }

            if (!shard) {
              log(`Warning: Shard from ${msg.author} could not be verified`)
              // TODO we should only attempt to use this shard if we cannot
              // meet the quorum otherwise
              shard = s.removeSignature(signedShard)
            }

            cb(null, shard)
          }
        }),
        pull.filter(Boolean),
        pull.collect((err, shards) => {
          if (err) return callback(err)
          if (!shards.length) return callback(new Error('No shards'))
          secrets.combine(shards).then((packedSecret) => {
            let secretObject
            try {
              secretObject = s.unpackLabel(packedSecret)
            } catch (err) {
              return callback(err)
            }
            callback(null, secretObject)
          }).catch(callback)
        })
      )
    }
  }

  request (root, options = {}, callback) {
    if (typeof options === 'function' && !callback) {
      callback = options
      options = {}
    }
    const self = this
    return callback
      ? requestCB(root, options, callback)
      : util.promisify(requestCB)(root, options)

    function requestCB (root, options, callback) {
      const singleRecipient = options.singleRecipient
      // if a recipeint is given, only publish a request to that recipient.
      // otherwise, publish requests to all recipients
      // find all own shards for this rootId
      pull(
        self.ownShards(),
        pull.filter(s => s.root === root),
        pull.map(s => s.recipient),
        pull.filter(r => singleRecipient ? r === singleRecipient : true),
        pull.asyncMap((recipient, cb) => {
          const reqMessage = self._buildMessage('request', {
            recipient,
            root
          })

          if (self.options.ephemeral) {
            const dbKey = { root, recipient }
            self.ephemeralKeys.generateAndStore(dbKey, (err, publicKey) => {
              if (err) return cb(err)
              reqMessage['ephemeral-key'] = publicKey.toString('hex')
              finishRequest()
            })
          } else {
            finishRequest()
          }

          function finishRequest () {
            if (!schemas.isRequest(reqMessage)) return cb(new Error('Request message badly formed'))
            cb(null, self.encodeAndBox(reqMessage, Buffer.from(recipient, 'hex')))
          }
        }),
        pull.collect((err, messagesToPublish) => {
          if (err) return callback(err)
          self._bulkPublish(messagesToPublish, callback)
        })
      )
    }
  }

  reply (callback) {
    const self = this

    return callback
      ? replyCB(callback)
      : util.promisify(replyCB)()

    function replyCB (callback) {
      // find all requests TO me
      // find all replies FROM me for those request messages
      pull(
        self.messagesByType('request'),
        pull.filter(schemas.isRequest),
        pull.filter(!self.isMine),
        pull.asyncMap((request, callback) => { // TODO asyncmap
          pull(
            self.messagesByType('reply'),
            // pull.filter(isReply),
            pull.filter(self.isMine),
            pull.filter(reply => reply.branch === self.messageToId(request)),
            pull.collect((err, replies) => {
              if (err) return callback(err)
              callback(null, replies.length ? false : request)
            })
          )
        }),
        pull.filter(Boolean),
        pull.asyncMap((request, cb) => {
          self.getShard(request.root, (err, shard) => {
            if (err) return callback(err)
            // ephemeral key in request?
            const shardToPublish = request['ephemeral-key']
              ? self.ephemeralKeys.boxMessage(shard, Buffer.from(request['ephemeral-key'], 'hex'), Buffer.from(JSON.stringify({})))
              : shard
            const reply = self._buildMessage('reply', {
              recipient: request.author,
              branch: self.messageToId(request),
              root: request.root,
              shard: shardToPublish.toString('hex')
            })
            if (!schemas.isReply(reply)) return callback(new Error('Reply message badly formed'))
            cb(null, self.encodeAndBox(reply, Buffer.from(request.author, 'hex')))
          })
        }),
        pull.collect((err, messagesToPublish) => {
          if (err) return callback(err)
          self._bulkPublish(messagesToPublish, callback)
        })
      )
    }
  }

  forward (root, recipient, callback) {
    const self = this
    return callback
      ? forwardCB(root, recipient, callback)
      : util.promisify(forwardCB)(root, recipient)

    function forwardCB (root, recipient, callback) {
      if (Buffer.isBuffer(recipient)) recipient = recipient.toString('hex')
      self.getShard(root, (err, shard) => {
        if (err) return callback(err)
        const forwardMsg = self._buildMessage('forward', {
          root,
          shard: shard.toString('hex'),
          recipient
        })
        if (!schemas.isForward(forwardMsg)) return callback(new Error('forward message badly formed'))

        self._bulkPublish([self.encodeAndBox(forwardMsg, Buffer.from(recipient, 'hex'))], callback)
      })
    }
  }

  getShard (root, callback) {
    const self = this
    return callback
      ? getShardCB(root, callback)
      : util.promisify(getShardCB)(root)

    function getShardCB (root, cb) {
      pull(
        self.messagesByType('shard'),
        pull.filter(schemas.isShard),
        pull.filter(s => s.root === root),
        pull.map(shardMsg => s.oneWayUnbox(Buffer.from(shardMsg.shard, 'hex'), self.keypair.secretKey)),
        pull.collect((err, shards) => {
          if (err) return cb(err)
          if (!shards[0]) return cb(new Error('Shard not found, or decryption error'))
          // TODO assert shards.length === 1
          cb(null, shards[0])
        })
      )
    }
  }

  messagesByType (types) {
    const self = this
    if (typeof types === 'string') types = [types]
    const fullTypes = types.map(type => `dark-crystal/${type}`)

    return pull(
      this.query(),
      pull.map((message) => {
        return self.decodeAndUnbox(message)
      }),
      pull.filter(m => fullTypes.includes(m.type))
    )
  }

  _buildMessage (type, properties) {
    return Object.assign({
      author: this.keypair.publicKey.toString('hex'),
      type: `dark-crystal/${type}`,
      version,
      timestamp: Date.now()
    }, properties)
  }

  _bulkPublish (messages, callback) {
    const self = this
    return callback
      ? bulkPublishCB(messages, callback)
      : util.promisify(bulkPublishCB)(messages)

    function bulkPublishCB (messages, callback) {
      if (self.publish && !self.publishCB) {
        self.publishCB = function (message, cb) {
          self.publish(message).then(() => cb()).catch(cb)
        }
      }

      if (typeof messages === 'string') messages = [messages]

      pull(
        pull.values(messages),
        pull.asyncMap(self.publish),
        pull.collect((err) => {
          if (err) return callback(err)
          callback(null, messages.length)
        })
      )
    }
  }

  encodeAndBox (message, recipient) {
    return s.privateBox(this.encoder.encode(message), [recipient, this.keypair.publicKey])
  }

  decodeAndUnbox (message) {
    assert(Buffer.isBuffer(message), 'message must be a buffer')
    const plainText = s.privateUnbox(message, this.keypair.secretKey)
    return this.encoder.decode(plainText || message)
  }

  isMine (message) {
    // TODO
    return message.author === this.id
  }

  // Currently unused
  queryOwnSecrets () {
    return pull(
      this.messagesByType('root'),
      pull.filter(schemas.isRoot),
      pull.filter(this.isMine)
    )
  }

  ownShards () {
    const self = this
    return pull(
      this.messagesByType('shard'),
      pull.filter(schemas.isShard),
      // pull.filter(this.isMine) // TODO
      pull.filter(message => message.author === self.id)
    )
  }

  // gatherAllShards (callback) {
  //   const self = this
  //   pull(
  //     self.messagesByType('root'),
  //     //pull.filter(isRoot),
  //     pull.filter(self.isMine),
  //     pull.asyncMap((err, ))
  //   )
  // }

  _defaultMessageToId (message) {
    return s.genericHash(this.encoder.encode(message)).toString('hex')
  }
}

const jsonEncoder = {
  encode (object) {
    return Buffer.from(JSON.stringify(object))
  },

  decode (buffer) {
    let object
    try {
      object = JSON.parse(buffer.toString())
    } catch (err) {
      return false
    }
    return object
  }
}
