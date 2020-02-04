const secrets = require('secret-sharing')
const s = require('key-backup-crypto')
const log = require('debug')('key-backup')
const pull = require('pull-stream')
const schemas = require('key-backup-message-schemas')
const assert = require('assert')
const util = require('util')
const maybe = require('call-me-maybe')

const version = '1.0.0'

module.exports = (options) => new Member(options)

class Member {
  constructor (options = {}) {
    this.keypair = options.keypair || s.keypair()
    this.id = this.keypair.publicKey.toString('hex')
    this.publish = options.publish // ||
    this.query = options.query // ||
    this.encoder = options.encoder || jsonEncoder
    this.messageToId = options.messageToId || this._defaultMessageToId
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
      self._bulkPublish(boxedShardMessages.concat([boxedRootMessage]))
      return root
    }
  }

  combine (root, callback) {
    const self = this
    return callback
      ? combineCB(root, callback)
      : util.promisify(combineCB)(root)

    function combineCB (root, callback) {
      pull(
        self.messagesByType('reply'), // or 'forward'
        pull.filter(schemas.isReply),
        pull.filter(relpy => relpy.root === root),
        pull.map(reply => {
          const signedShard = Buffer.from(reply.shard, 'hex')
          // TODO for forwards, we need to know the public key of the secret owner
          const shard = s.openShard(signedShard, self.keypair.publicKey)
          if (!shard) log(`Warning: Shard from ${reply.author} could not be verified`) // TODO
          return shard
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

  request (root, singleRecipient, callback) {
    if (typeof singleRecipient === 'function' && !callback) {
      callback = singleRecipient
      singleRecipient = null
    }
    const self = this
    return callback
      ? requestCB(root, singleRecipient, callback)
      : util.promisify(requestCB)(root, singleRecipient)

    function requestCB (root, singleRecipient, callback) {
      // if a recipeint is given, only publish a request to that recipient.
      // otherwise, publish requests to all recipients
      // find all own shards for this rootId
      pull(
        self.ownShards(),
        pull.filter(s => s.root === root),
        pull.map(s => s.recipient),
        pull.filter(r => singleRecipient ? r === singleRecipient : true),
        // pull.asyncMap()
        pull.map((recipient) => {
          const reqMessage = self._buildMessage('request', {
            recipient,
            root
          })
          if (!schemas.isRequest(reqMessage)) return callback(new Error('Request message badly formed'))
          return self.encodeAndBox(reqMessage, Buffer.from(recipient, 'hex'))
        }),
        pull.collect((err, messagesToPublish) => {
          if (err) return callback(err)
          self._bulkPublish(messagesToPublish)
          callback(null, messagesToPublish.length)
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
            const reply = self._buildMessage('reply', {
              recipient: request.author,
              branch: self.messageToId(request),
              root: request.root,
              shard: shard.toString('hex')
            })
            if (!schemas.isReply(reply)) return callback(new Error('Reply message badly formed'))
            cb(null, self.encodeAndBox(reply, Buffer.from(request.author, 'hex')))
          })
        }),
        pull.collect((err, messagesToPublish) => {
          if (err) return callback(err)
          self._bulkPublish(messagesToPublish)
          callback(null, messagesToPublish.length)
        })
      )
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

  messagesByType (type) {
    const self = this
    return pull(
      this.query(),
      pull.map((message) => {
        // const { message, publicKey } = messageObj
        return self.decodeAndUnbox(message)
      }),
      pull.filter(m => m.type === `dark-crystal/${type}`)
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

  _bulkPublish (messages) {
    const self = this
    messages.forEach((message) => { self.publish(message) })
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
    return message.author === this.id
  }

  queryOwnSecrets () {
    return pull(
      this.messagesByType('root'),
      pull.filter(schemas.isRoot),
      pull.filter(this.isMine)
    )
  }

  ownShards () {
    return pull(
      this.messagesByType('shard'),
      pull.filter(schemas.isShard)
      // pull.filter(self.isMine) // TODO
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
