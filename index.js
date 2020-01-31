const secrets = require('secret-sharing')
const s = require('key-backup-crypto')
const log = require('debug')('key-backup')
const pull = require('pull-stream')
const schemas = require('key-backup-message-schemas')
const assert = require('assert')

const version = '1.0.0'

module.exports = (options) => new Member(options)

class Member {
  constructor (options = {}) {
    this.keypair = options.keypair || s.keypair()
    this.id = this.keypair.publicKey.toString('hex')
    this.publish = options.publish // ||
    this.query = options.query // ||
    this.encoder = options.encoder || jsonEncoder
    this.messageToId = options.messageToId || defaultMessageToId
  }

  async share (options) {
    const { secret, label, shards, quorum, custodians, name } = options

    const packedSecret = s.packLabel(secret, label)

    const rawShards = await secrets.share(packedSecret, shards, quorum)
    const signedShards = s.signShards(rawShards, this.keypair)

    const boxedShards = signedShards.map((shard, i) => {
      return s.oneWayBox(shard, custodians[i])
    })

    const rootMessage = this._buildMessage('root', { label, shards, quorum, tool: 'sss' })
    assert(schemas.isRoot(rootMessage), schemas.errorParser(schemas.isRoot))
    const root = this.messageToId(rootMessage)
    const shardMessages = boxedShards.map((shard, i) => {
      return this._buildMessage('shard', {
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
      return this.encodeAndBox(shardMessage, custodians[i])
    })

    const boxedRootMessage = this.encodeAndBox(rootMessage, this.keypair.publicKey)

    // Publish all messages at once
    this._bulkPublish(boxedShardMessages.concat([boxedRootMessage]))
    return root
  }

  combine (root, callback) {
    const self = this
    pull(
      self.messagesByType('reply'), // or 'forward'
      pull.filter(schemas.isReply),
      pull.filter(relpy => relpy.root === root),
      pull.map(reply => {
        const signedShard = Buffer.from(reply.shard, 'hex')
        // TODO for forwards, we need to know the public key of the secret owner
        const shard = s.openShard(signedShard, this.keypair.publicKey)
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

  _bulkPublish (messages) {
    const self = this
    messages.forEach((message) => { self.publish({ message, publicKey: self.keypair.publicKey }) })
  }

  encodeAndBox (message, recipient) {
    return s.privateBox(this.encoder.encode(message), [recipient, this.keypair.publicKey])
  }

  decodeAndUnbox (message) {
    assert(Buffer.isBuffer(message), 'message must be a buffer')
    const plainText = s.privateUnbox(message, this.keypair.secretKey)
    return this.encoder.decode(plainText || message)
  }

  _buildMessage (type, properties) {
    return Object.assign({
      author: this.keypair.publicKey.toString('hex'),
      type: `dark-crystal/${type}`,
      version,
      timestamp: Date.now()
    }, properties)
  }

  messagesByType (type) {
    const self = this
    return pull(
      this.query(),
      pull.map((messageObj) => {
        const { message, publicKey } = messageObj
        return self.decodeAndUnbox(message, publicKey)
      }),
      pull.filter(m => m.type === `dark-crystal/${type}`)
    )
  }

  isMine (message) {
    return message.author === this.id
  }

  queryOwnSecrets () {
    return pull(
      this.messagesByType('root'),
      // pull.filter(isRoot),
      pull.filter(this.isMine)
    )
  }

  ownShards () {
    return pull(
      this.messagesByType('shard')
      // pull.filter(isShard),
      // pull.filter(this.isMine)
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


  request (root, singleRecipient, callback) {
    // if a recipeint is given, only publish a request to that recipient.
    // otherwise, publish requests to all recipients
    // find all own shards for this rootId
    const self = this
    pull(
      this.ownShards(),
      pull.filter(s => s.root === root),
      pull.map(s => s.recipient),
      pull.filter(r => singleRecipient ? r === singleRecipient : true),
      // pull.asyncMap()
      pull.map((recipient) => {
        const reqMessage = this._buildMessage('request', {
          recipient,
          root
        })
        return self.encodeAndBox(reqMessage, Buffer.from(recipient, 'hex'))
      }),
      pull.collect((err, messagesToPublish) => {
        if (err) return callback(err)
        self._bulkPublish(messagesToPublish)
        callback(null, messagesToPublish.length)
      })
    )
  }

  reply (callback) {
    // find all requests TO me
    // find all replies FROM me for those request messages
    const self = this
    pull(
      self.messagesByType('request'),
      // pull.filter(isRequest),
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
        self._getShard(request.root, (err, shard) => {
          if (err) return callback(err)
          const reply = self._buildMessage('reply', {
            recipient: request.author,
            branch: self.messageToId(request),
            root: request.root,
            shard: shard.toString('hex')
          })
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

  _getShard (root, cb) {
    const self = this
    pull(
      self.messagesByType('shard'),
      // pull.filter('isShard')
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

const jsonEncoder = {
  encode (object) {
    // TODO protobuf
    return Buffer.from(JSON.stringify(object))
  },

  decode (buffer) {
    // if (typeof buffer === 'object') return buffer
    let object
    try {
      object = JSON.parse(buffer.toString())
    } catch (err) {
      return false
    }
    return object
  }
}

function defaultMessageToId (message) {
  return s.genericHash(this.encoder.encode(message)).toString('hex')
}
