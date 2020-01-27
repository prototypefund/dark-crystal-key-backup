const secrets = require('secret-sharing')
const s = require('key-backup-crypto')

const version = '1.0.0'
const log = console.log

module.exports = (options) => new Member(options)

class Member {
  constructor (options = {}) {
    this.keypair = options.keypair || s.signingKeypair()
    // encryptionkeypair
    this.encryptionKeypair = s.signingKeypairToEncryptionKeypair(this.keypair)
  }

  async share (options) {
    const { secret, label, shards, quorum, signingKeypair, custodians } = options

    const packedSecret = s.packLabel(secret, label)

    // TODO convert public keys of custodians to encryption keys

    const rawShards = await secrets.share(packedSecret, shards, quorum)
    const signedShards = s.signShards(rawShards, signingKeypair)

    const boxedShards = signedShards.map((shard, i) => {
      return s.oneWayBox(shard, custodians[i])
    })

    const rootMessage = buildMessage('root', { label, shards, quorum, tool: 'sss' })
    const shardMessages = boxedShards.map((shard, i) => {
      return buildMessage('shard', {
        root: 'TODO',
        shard: shard.toString('hex'),
        recipient: custodians[i].toString('hex')
      })
    })

    // TODO check isRootMessage, isShardMessage

    log(rootMessage)
    log(JSON.stringify(shardMessages, null, 4))

    const encryptionKeypair = s.signingKeypairToEncryptionKeypair(signingKeypair)
    const boxedShardMessages = shardMessages.map((shardMessage, i) => {
      return s.box(encode(shardMessage), custodians[i], encryptionKeypair.secretKey)
    })

    const boxedRootMessage = s.oneWayBox(encode(rootMessage), encryptionKeypair.publicKey)
    return boxedShardMessages.concat([boxedRootMessage])
  }

  combine (shardsHex) {
    const shards = shardsHex.map(s => Buffer.from(s, 'hex'))
  }
}

function shardMessagesToShards (shardMessages) {
  return shardMessages.filter(s => s.shard).map(s => s.shard)
}

function encode (object) {
  // TODO protobuf
  return Buffer.from(JSON.stringify(object))
}

function buildMessage (type, properties) {
  return Object.assign({ type: `dark-crystal/${type}`, version }, properties)
}
