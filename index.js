const secrets = require('secret-sharing')
const s = require('key-backup-crypto')
const log = require('debug')('key-backup')
const pull = require('pull-stream')

const version = '1.0.0'

module.exports = (options) => new Member(options)

class Member {
  constructor (options = {}) {
    this.keypair = options.keypair || s.signingKeypair()
    this.id = this.keypair.publicKey.toString('hex')
    // encryptionkeypair
    this.encryptionKeypair = s.signingKeypairToEncryptionKeypair(this.keypair)
    this.publish = options.publish // ||
    this.query = options.query // ||
    this.encoder = options.encoder || jsonEncoder
    this.messageToId = options.messageToId || defaultMessageToId
  }

  async share (options) {
    const { secret, label, shards, quorum, custodians } = options

    const packedSecret = s.packLabel(secret, label)

    // TODO convert public keys of custodians to encryption keys

    const rawShards = await secrets.share(packedSecret, shards, quorum)
    const signedShards = s.signShards(rawShards, this.keypair)

    const boxedShards = signedShards.map((shard, i) => {
      return s.oneWayBox(shard, custodians[i])
    })

    const rootMessage = this._buildMessage('root', { label, shards, quorum, tool: 'sss' })
    const shardMessages = boxedShards.map((shard, i) => {
      return this._buildMessage('shard', {
        root: 'TODO',
        shard: shard.toString('hex'),
        recipient: custodians[i].toString('hex')
      })
    })

    // TODO check isRootMessage, isShardMessage

    log(rootMessage)
    log(JSON.stringify(shardMessages, null, 4))

    const boxedShardMessages = shardMessages.map((shardMessage, i) => {
      return this.encodeAndBox(shardMessage, custodians[i])
    })

    const boxedRootMessage = s.oneWayBox(this.encoder.encode(rootMessage), this.encryptionKeypair.publicKey)

    // Publish all messages at once
    boxedShardMessages.concat([boxedRootMessage]).forEach(this.publish)
  }

  encodeAndBox(message, recipient) {
    return s.box(this.encoder.encode(message), recipient, this.encryptionKeypair.secretKey)
  }
  _buildMessage (type, properties) {
    return Object.assign({
      author: this.keypair.publicKey.toString('hex'),
      type: `dark-crystal/${type}`,
      version,
      timestamp: Date.now()
    }, properties)
  }

  buildIndex () {
    pull(
      this.query(),
      pull.map(this.receiveMessage),
      pull.collect((err) => {
        if (err) throw err // TODO
      })
    )
  }

  decryptMessage (message, senderPublicKey) {
    const plainText = s.unbox(message, senderPublicKey, this.encryptionSecretKey)
    return this.encoder.decode(plainText || message)
  }

  messagesByType (type) {
    return pull(
      this.query(),
      // pull.map(decode/unbox)
      pull.filter(`dark-crystal/${type}`)
    )
  }

  isMine(message) {
    return message.author === this.id
  }

  queryOwnSecrets () {
    pull(
      this.messagesByType('root'),
      // pull.filter(isRoot),
      pull.filter(this.isMine)
    )
  }

  ownShards () {
    pull(
      this.messagesByType('shard'),
      // pull.filter(isShard),
      pull.filter(this.isMine)
    )
  }

  combine (shardsHex) {
    const shards = shardsHex.map(s => Buffer.from(s, 'hex'))
  }

  request (rootId, singleRecipient) {
    // if a recipeint is given, only publish a request to that recipient.
    // otherwise, publish requests to all recipients
    // find all own shards for this rootId
    pull(
      this.ownShards(),
      pull.filter(s => s.rootId === rootId),
      pull.map(s => s.recipient),
      pull.filter(r => singleRecipient ? r === singleRecipient : true),
      // pull.asyncMap()
      pull.map((recipient) => {
        const reqMessage = this._buildMessage('request', {
          recipient,
          rootId
        })
        return this.encodeAndBox(reqMessage, recipient)
      }),
      pull.collect((err, messagesToPublish) => {
        if (err) throw (err) // TODO
        messagesToPublish.forEach(this.publish) // await
      })
    )
  }

  reply () {
    // find all requests TO me
    // find all replies FROM me for those request messages
    pull(
      this.messagesByType('request'),
      // pull.filter(isRequest),
      pull.filter(!this.isMine),
      pull.asyncMap((request, callback) => { // TODO asyncmap
        pull(
          this.messagesByType('reply'),
          // pull.filter(isReply),
          pull.filter(this.isMine),
          pull.filter(reply => reply.branch === this.messageToId(request)),
          pull.collect((err, replies) => {
            if (err) return callback(err)
            callback(null, replies.length ? false : request)
          })
        )
      }),
      pull.filter(Boolean),
      pull.asyncMap((request, callback) => {
        this._getShard(request.rootId, (err, shard) => {
          if (err) return callback(err)
          const reply = this._buildMessage('reply', {
            recipient: request.author,
            branch: this.messageToId(request),
            root: request.rootId,
            shard
          })
          callback(null, this.encodeAndBox(reply, request.author))
        })
      }),
      pull.collect((err, messagesToPublish) => {
        if (err) throw (err) // TODO
        messagesToPublish.forEach(this.publish) // await
      })
    )
  }

  _getShard (rootId, cb) {
    pull(
      this.messagesByType('shard'),
      // pull.filter('isShard')
      pull.filter(s => s.rootId === rootId),
      pull.map(s => s.oneWayUnbox(Buffer.from(s.shard, 'hex'), this.encryptionKeypair.secretKey)),
      pull.collect((err, shards) => {
        if (err) return cb(err)
        if (!shards[0]) return cb(new Error('Shard not found, or decryption error'))
        // TODO assert shards.length === 1
        cb(null, shards[0])
      })
    )
  }

}

function shardMessagesToShards (shardMessages) {
  return shardMessages.filter(s => s.shard).map(s => s.shard)
}

const jsonEncoder = {
  encode (object) {
    // TODO protobuf
    return Buffer.from(JSON.stringify(object))
  },

  decode (buffer) {
    if (typeof buffer === 'object') return buffer
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
