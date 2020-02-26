# key-backup

A high level class for Dark Crystal key backup and recovery.

This module is designed to be transport agnostic.  You provide functions for publishing messages, and for reading a stream of all known messages from all peers (including ourself). 

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
- `streamAllMessages` - A function which returns a stream of all messages we know of.
- `pullStreamAllMessages` - A function which returns a [pull-stream](https://pull-stream.github.io/) of all messages we know of.
- `encoder` - an optional message encoder.  If it is not given a JSON encoder will be used. If given, it should be an object of the form `{ encode, decode }`.  `encode` should take an object and return a buffer, `decode` should do the opposite.
- `messageToId` an optional function which given a message, returns its reference.  For example, takes a `root` message, and gives a reference which we can later use to refer to that root message. Defaults to encoding the message with the given encoder, taking its hash, and giving it as a hex encoded string. If given, should take an object and return a string.
- `ephemeral` - Boolean - whether to use ephemeral keys in requests for returned shards.  If false, ephemeral keys will still be used if given by the other party, but we will not use them in our own requests.
- `storage` - If `ephemeral` is true, the filesystem path to use to store keys on disk. Defaults to `~/.key-backup`.

Note - you **must** provide a publish function, and a way of reading messages (either `streamAllMessages` or `pullStreamAllMessages`)

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

```js
const promise = member.combine(root, secretOwnerId)
```

OR

```js
member.combine(root, secretOwnerId, callback)
```

Attempt to combine available shards for the given `root` reference.  The `secretOwnerId` is optional, and if given will be used to verify the signatures were from the original secret owner.  In the case of shards found in `reply` messages, it is assumed that you are the secret owner.

If successful, the promise or callback returns an object in the form `{ label, secret }`, where label is a string containing a descriptive label and `secret` is a buffer containing the secret. Otherwise, an error is returned.

### `member.request`

```js
const promise = member.request(root, singleRecipient)
```

```js
member.request (root, singleRecipient, callback) 
```

Publish request messages to request return of shards for a particular secret, specified by the given `root` reference.

`singleRecipient` is an optional argument.  If given, a request to only the given recipient will be published.  Otherwise, requests will be sent to all custodians.

The callback or promise returns the number of requests successfully published.

### `member.reply`

```js
const promise = member.reply() 
```

OR

```js
member.reply(callback) 
```

This method finds all request messages addressed to us which have not yet been replied to, decrypts the respective shards and packs them into `reply` messages.

This should be run whenever new request messages are received, or can be run whenever any new messages are received.

The promise or callback returns the number of `reply` messages successfully published.

### `member.forward`

```js
const promise = member.forward(root, recipient)
```
OR
```js
member.forward(root, recipient, callback)
```

Publish a `forward` message containing the shard associated with the given `root` reference, if present.

`recipient` is the id (public key) of the intended recipient of the `forward` message.  It may be given as a buffer or a hex encoded string.

Returns the number of messages published (which should always be one) in the promise or callback.

### `member.getShard`

```js
const promise = member.getShard(root)
```

OR

```js
member.getShard(root, callback)
```

Find and decrypt a shard, if present, for the given `root` reference. If found, a buffer containing the decrypted shard is returned in the promise or callback.

### `member.messagesByType`

```js
pull(member.messagesByType(types))
```

Returns a pull-stream of messages of the specified `types`.

`types` may be an array of strings, or a string containing a single type, for example `'reply'`.

### `member.encodeAndBox`

```js
const boxedMessage = member.encodeAndBox(message, recipient)
```
Encode a given message, using the encoded given in the constructor (or the default JSON encoder), and encrypt it to the given `recipient`.  `message` should be an object. Returns a buffer.

### `member.decodeAndUnbox`

```js
const = member.decodeAndUnbox(message) 
```

Decrypt and decode the given message. `message` should be a buffer. If decryption was not successful, attempts to decode the message as it was given. The included JSON encoder will return `false` if decoding was unsuccessful.  Otherwise, returns an object.

### `member.deleteEphemeralKeypair`

```js
const promise = member.deleteEphemeralKeypair(root, recipient)
```
OR
```js
member.deleteEphemeralKeypair(root, recipient, callback)
```

If `options.ephemeralKeys` is set, this can be used to delete an ephemeral keypair associated with the given root message reference and recipient, once the shard data is no longer needed.
