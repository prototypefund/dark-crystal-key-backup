# key-backup

A high level class for Dark Crystal key backup and recovery.

## API

```js
const KeyBackup = require('.')
const member = KeyBackup(options)
```

Returns a `keybackup` instance representing a 'member' which could be a secret-owner, a custodian, or both.

The constructor takes an `options` object which may have properties:
- `keypair` - a keypair object of the form `{ publicKey, secretKey }`, both of which should be buffers. This is optional, if no keypair is passed, one will be generated.
- `publish` - a function which will used to publish messages.  It should take a single argument, `message` and return a promise.
- `publishCB` - If you prefer to use callbacks, you can instead give a function `publishCB` which takes two arguments, `message` and `callback`. 
- `query` - query function (TODO).
- `encoder` - an optional message encoder.  If it is not given a JSON encoder will be used. If given, it should be an object of the form `{ encode, decode }`.  `encode` should take an object and return a buffer, `decode` should do the opposite.
- `messageToId` an optional function which given a message, returns its reference.  For example, takes a `root` message, and gives a reference which we can later use to refer to that root message. Defaults to encoding the message with the given encoder, taking its hash, and giving it as a hex encoded string. If given, should take an object and return a string.

## `member.share`

```js
const promise = member.share(options)
```
OR
```js
member.share(options, callback)
```

Options:
- `secret`
- `label`
- `shards`
- `quorum`
- `custodians`
- `name`

returns a reference to the root message in the callback/promise.

### `member.combine`
### `member.request`
### `member.reply`
### `member.forward`
### `member.getShard`
### `member.messagesByType`
### `member.encodeAndBox`
### `member.decodeAndUnbox`
