const { describe } = require('tape-plus')
const keyBackup = require('..')
const s = require('key-backup-crypto')

const custodians = []
for (let i = 0; i < 5; i++) {
  custodians.push(s.encryptionKeypair())
}

const sObj = {
  secret: s.randomBytes(32),
  label: 'My private key',
  shards: 5,
  quorum: 3,
  signingKeypair: s.signingKeypair(),
  custodians: custodians.map(c => c.publicKey)
}

describe('share', (context) => {
  context('basic', (assert, next) => {
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
})
