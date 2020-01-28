const { describe } = require('tape-plus')
const keyBackup = require('..')
const s = require('key-backup-crypto')
const pull = require('pull-stream')

describe('share', (context) => {
  context('basic', (assert, next) => {
    const custodians = []
    for (let i = 0; i < 5; i++) {
      custodians.push(s.encryptionKeypair())
    }

    const sObj = {
      secret: s.randomBytes(32),
      label: 'My private key',
      shards: 5,
      quorum: 3,
      custodians: custodians.map(c => c.publicKey)
    }
    const member = keyBackup()
    assert.ok(member.keypair, 'has keypair')
    member.share(sObj).then((boxedMessages) => {
      assert.equal(boxedMessages.length, 6, 'Gives expected number of messages')
      next()
    }).catch((err) => {
      console.log(err)
      next()
    })
  })

  context('multiple actors', (assert, next) => {
    const feeds = {}
    const custodians = []
    const numMembers = 5
    for (let i = 0; i < numMembers; i++) {
      custodians.push(keyBackup())
    }
    const secretOwner = keyBackup()
    const sObj = {
      secret: s.randomBytes(32),
      label: 'My private key',
      shards: 5,
      quorum: 3,
      custodians: custodians.map(c => c.encryptionKeypair.publicKey),
      publish (message) {
        messages.push(message)
      },
      query () {
        return pull(pull.values(messages))
      }
    }
    secretOwner.share(sObj).then((boxedMessages) => {
      assert.equal(boxedMessages.length, 6, 'Gives expected number of messages')
        
      next()
    }).catch((err) => {
      console.log(err)
      next()
    })
    next()
  })
})
