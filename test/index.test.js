const { describe } = require('tape-plus')
const keyBackup = require('..')
const s = require('key-backup-crypto')
const pull = require('pull-stream')
const tmpDir = require('tmp').dirSync

describe('share', (context) => {
  let messages
  function publish (message, callback) {
    messages.push(message)
    callback()
    // return new Promise(function (resolve, reject) {
    //   messages.push(message)
    //   resolve()
    // })
  }

  function pullStreamAllMessages () {
    return pull(pull.values(messages))
  }

  context.beforeEach(() => {
    messages = []
  })

  context('basic', (assert, next) => {
    const custodians = []
    for (let i = 0; i < 5; i++) {
      custodians.push(s.keypair())
    }

    const sObj = {
      secret: s.randomBytes(32),
      label: 'My private key',
      shards: 5,
      quorum: 3,
      custodians: custodians.map(c => c.publicKey)
    }
    const member = keyBackup({ publish, pullStreamAllMessages })
    assert.ok(member.keypair, 'has keypair')
    member.share(sObj).then((root) => {
      assert.ok(root, 'gives a root id')
      next()
    }).catch((err) => {
      assert.error(err)
      next()
    })
  })

  context('multiple actors', (assert, next) => {
    const custodians = []
    const numMembers = 5
    for (let i = 0; i < numMembers; i++) {
      custodians.push(keyBackup({ publish, pullStreamAllMessages }))
    }
    const secretOwner = keyBackup({ publish, pullStreamAllMessages })
    const sObj = {
      secret: s.randomBytes(32),
      label: 'My private key',
      shards: 5,
      quorum: 3,
      custodians: custodians.map(c => c.keypair.publicKey)
    }
    secretOwner.share(sObj).then((root) => {
      assert.ok(root, 'Gives root ID')
      secretOwner.request(root, (err, numRequests) => {
        assert.error(err, 'No error on request')
        assert.equal(numRequests, 5, 'Expected number of requests published')
        makeReplies(root)
      })
    }).catch((err) => {
      assert.error(err, 'No error on share')
      next()
    })

    function makeReplies (root) {
      pull(
        pull.values(custodians),
        pull.asyncMap((custodian, cb) => {
          custodian.reply((err, numReplies) => {
            assert.error(err, 'No error on reply')
            assert.equal(numReplies, 1, 'Single reply published')
            cb(null, numReplies)
          })
        }),
        pull.collect((err) => {
          assert.error(err, 'No error')
          secretOwner.combine(root, (err, secretObj) => {
            assert.error(err, 'No error on combine')
            assert.equal(secretObj.label, sObj.label, 'Label correctly retrieved')
            assert.equal(secretObj.secret.toString('hex'), sObj.secret.toString('hex'), 'Successfully recovered secret')
            next()
          })
        })
      )
    }
  })

  context('with ephemeral keys', (assert, next) => {
    const custodians = []
    const numMembers = 5
    for (let i = 0; i < numMembers; i++) {
      custodians.push(keyBackup({ publish, pullStreamAllMessages }))
    }
    const secretOwner = keyBackup({ publish, pullStreamAllMessages, ephemeral: true, storage: tmpDir().name })
    const sObj = {
      secret: s.randomBytes(32),
      label: 'My private key',
      shards: 5,
      quorum: 3,
      custodians: custodians.map(c => c.keypair.publicKey)
    }
    secretOwner.share(sObj).then((root) => {
      assert.ok(root, 'Gives root ID')
      secretOwner.request(root, (err, numRequests) => {
        assert.error(err, 'No error on request')
        assert.equal(numRequests, 5, 'Expected number of requests published')
        makeReplies(root)
      })
    }).catch((err) => {
      assert.error(err, 'No error on share')
      next()
    })

    function makeReplies (root) {
      pull(
        pull.values(custodians),
        pull.asyncMap((custodian, cb) => {
          custodian.reply((err, numReplies) => {
            assert.error(err, 'No error on reply')
            assert.equal(numReplies, 1, 'Single reply published')
            cb(null, numReplies)
          })
        }),
        pull.collect((err) => {
          assert.error(err, 'No error')
          secretOwner.combine(root, (err, secretObj) => {
            assert.error(err, 'No error on combine')
            assert.equal(secretObj.label, sObj.label, 'Label correctly retrieved')
            assert.equal(secretObj.secret.toString('hex'), sObj.secret.toString('hex'), 'Successfully recovered secret')
            next()
          })
        })
      )
    }
  })

  context('with forwarding', (assert, next) => {
    const custodians = []
    const numMembers = 5
    for (let i = 0; i < numMembers; i++) {
      custodians.push(keyBackup({ publish, pullStreamAllMessages }))
    }
    const secretOwner = keyBackup({ publish, pullStreamAllMessages })
    const newSecretOwner = keyBackup({ publish, pullStreamAllMessages })
    const sObj = {
      secret: s.randomBytes(32),
      label: 'My private key',
      shards: 5,
      quorum: 3,
      custodians: custodians.map(c => c.keypair.publicKey)
    }
    secretOwner.share(sObj).then((root) => {
      assert.ok(root, 'Gives root ID')

      pull(
        pull.values(custodians),
        pull.asyncMap((custodian, cb) => {
          custodian.forward(root, newSecretOwner.id, (err, published) => {
            assert.error(err, 'No error on publish forward')
            assert.equal(published, 1, 'Single message published')
            cb()
          })
        }),
        pull.collect((err) => {
          assert.error(err, 'No error')
          combineForwards(root)
        })
      )
    }).catch((err) => {
      assert.error(err, 'No error on share')
      next()
    })

    function combineForwards (root) {
      newSecretOwner.combine(root, secretOwner.id, (err, secretObj) => {
        assert.error(err, 'No error on combine')
        assert.equal(secretObj.label, sObj.label, 'Label correctly retrieved')
        assert.equal(secretObj.secret.toString('hex'), sObj.secret.toString('hex'), 'Successfully recovered secret')
        next()
      })
    }
  })

  context('with forwarding, without knowing secret owner id', (assert, next) => {
    const custodians = []
    const numMembers = 5
    for (let i = 0; i < numMembers; i++) {
      custodians.push(keyBackup({ publish, pullStreamAllMessages }))
    }
    const secretOwner = keyBackup({ publish, pullStreamAllMessages })
    const newSecretOwner = keyBackup({ publish, pullStreamAllMessages })
    const sObj = {
      secret: s.randomBytes(32),
      label: 'My private key',
      shards: 5,
      quorum: 3,
      custodians: custodians.map(c => c.keypair.publicKey)
    }
    secretOwner.share(sObj).then((root) => {
      assert.ok(root, 'Gives root ID')

      pull(
        pull.values(custodians),
        pull.asyncMap((custodian, cb) => {
          custodian.forward(root, newSecretOwner.id, (err, published) => {
            assert.error(err, 'No error on publish forward')
            assert.equal(published, 1, 'Single message published')
            cb()
          })
        }),
        pull.collect((err) => {
          assert.error(err, 'No error')
          combineForwards(root)
        })
      )
    }).catch((err) => {
      assert.error(err, 'No error on share')
      next()
    })

    function combineForwards (root) {
      newSecretOwner.combine(root, (err, secretObj) => {
        assert.error(err, 'No error on combine')
        assert.equal(secretObj.label, sObj.label, 'Label correctly retrieved')
        assert.equal(secretObj.secret.toString('hex'), sObj.secret.toString('hex'), 'Successfully recovered secret')
        next()
      })
    }
  })
})
