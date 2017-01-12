This document describes in more details how to use this library along with OAuth.

Before reading this document, to better understand how authentication and OAuth work on the cozy-stack, you should read [this document](https://cozy.github.io/cozy-stack/auth.html).

The library exposes internal methods to access the OAuth endpoints of the cozy-stack. See [cozy.auth.* methods](./README.md#cozyauthregisterclientclientparams). However, the library also provides a more automated way to perform de OAuth flow by implementing many details of the OAuth registration and authorization flow for you.

Here we describe the automated and stateful method.

### Storage

To handle the workflow automatically, the user of the library shoud pass a storage object that will be used to store the OAuth client and tokens informations.

This storage should implement the following "interface":

```js
interface Storage {
  load(key: string) : Promise<any>
  save(key: string, value: any) : Promise<any>
  delete(key: string) : Promise<boolean>
  clear() : Promise<>
}
```

The library provides two implementation of such storage:
  - `cozy.auth.MemoryStorage` storing data in-memory
  - `cozy.auth.LocalStorage` storage data in a html5 [`localStorage`](https://developer.mozilla.org/en/docs/Web/API/Window/localStorage)

The library constructor (on `init` method) should be passed the storage in the `storage` field of the `oauth` options.

### Registration parameters

In order to handle the registration of the client, two callbacks should be provided to the cozy-client-js instance.

  - `clientParams` an object with the following parameters:
    + `redirectURI`: the URI on which the user is redirected after accepting the client (mandatory)
    + `softwareID`: identifier of the software (by default `github.com/cozy/cozy-client-js`)
    + `softwareVersion`: version of the software (optinal)
    + `clientName`: string (optional)
    + `clientKind`: string (optional)
    + `clientURI`: string (optional)
    + `logoURI`: string (optional)
    + `policyURI`: string (optional)
    + `permissions`: object, permissions required by the application that the user should accept (mandatory). See the [permissions document](https://github.com/cozy/cozy-stack/blob/master/docs/permissions.md) for more details.
  - `onRegistered(client, url)` which should provide the wanted "side effect" after the client registration and return a promise containing the request URL provided by the user containing the access code and state.

The `onRegistered` callback is called with the registered client and the URL on which the user should go to give access to the application.

### Complete example for Node.JS

Here is a complete example running on Node.JS with a local http server receiving as redirect URI receiving the call of the user to complete the authorization of the client.

```js
const http = require('http');
const {Cozy,MemoryStorage} = require('./dist/cozy-client.node.js')

function onRegistered(client, url) {
  let server
  return new Promise((resolve) => {
    server = http.createServer((request, response) => {
      if (request.url.indexOf('/do_access') === 0) {
        console.log('Received access from user with url', request.url)
        resolve(request.url)
        response.end();
      }
    })
    server.listen(3333, () => {
      console.log('Please visit the following url to authorize the application: ', url)
    })
  })
    .then(
      (url) => { server.close(); return url; },
      (err) => { server.close(); throw err; }
    )
}

const cozy = new Cozy({
  cozyURL: 'http://cozy.local:8080',
  oauth: {
    storage: new MemoryStorage(),
    clientParams: {
      redirectURI: 'http://localhost:3333/do_access',
      softwareID: 'foobar',
      clientName: 'client',
      permissions: {
        contacts: {
          description: "Required for autocompletion on @name",
          type: "io.cozy.contacts",
          verbs: "GET"
        },
        images: {
          description: "Required for the background",
          type: "io.cozy.files",
          verbs: "GET",
          values: ["io.cozy.files.music-dir"]
        },
      }
    },
    onRegistered: onRegistered,
  }
})

cozy.authorize().then((creds) => console.log(creds))
```
