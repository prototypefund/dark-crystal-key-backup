const { describe } = require('tape-plus')
const { share } = require('..')
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
    share(sObj).then((boxedMessages) => {
      console.log(boxedMessages.length)
    }).catch((err) => {
      console.log(err)
    })
  })
})
