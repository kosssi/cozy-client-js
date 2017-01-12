/* global btoa */
import {encodeQuery, decodeQuery} from './utils'
import {cozyFetchJSON, FetchError} from './fetch'

const StateSize = 16

export const CredsKey = 'creds'
export const StateKey = 'state'

export class Client {
  constructor (opts) {
    this.clientID = opts.clientID || opts.client_id || ''
    this.clientSecret = opts.clientSecret || opts.client_secret || ''
    this.registrationAccessToken = opts.registrationAccessToken || opts.registration_access_token || ''

    if (opts.redirect_uris) {
      this.redirectURI = opts.redirect_uris[0] || ''
    } else {
      this.redirectURI = opts.redirectURI || ''
    }

    this.softwareID = opts.softwareID || opts.software_id || ''
    this.softwareVersion = opts.softwareVersion || opts.software_version || ''
    this.clientName = opts.clientName || opts.client_name || ''
    this.clientKind = opts.clientKind || opts.client_kind || ''
    this.clientURI = opts.clientURI || opts.client_uri || ''

    this.logoURI = opts.logoURI || opts.logo_uri || ''
    this.policyURI = opts.policyURI || opts.policy_uri || ''

    if (this.redirectURI === '') {
      throw new Error('Missing redirectURI field')
    }
    if (this.softwareID === '') {
      throw new Error('Missing softwareID field')
    }
    if (this.clientName === '') {
      throw new Error('Missing clientName field')
    }
  }

  isRegistered () {
    return this.clientID !== ''
  }

  toRegisterJSON () {
    return {
      redirect_uris: [this.redirectURI],
      software_id: this.softwareID,
      software_version: this.softwareVersion,
      client_name: this.clientName,
      client_kind: this.clientKind,
      client_uri: this.clientURI,
      logo_uri: this.logoURI,
      policy_uri: this.policyURI
    }
  }

  toAuthHeader () {
    return 'Bearer ' + this.registrationAccessToken
  }
}

export class AccessToken {
  constructor (opts) {
    this.tokenType = opts.tokenType || opts.token_type
    this.accessToken = opts.accessToken || opts.access_token
    this.refreshToken = opts.refreshToken || opts.refresh_token
    this.scope = opts.scope
  }

  toAuthHeader () {
    return 'Bearer ' + this.accessToken
  }
}

export function registerClient (cozy, client) {
  if (!(client instanceof Client)) {
    client = new Client(client)
  }
  if (client.isRegistered()) {
    return Promise.reject(new Error('Client already registered'))
  }
  return cozyFetchJSON(cozy, 'POST', '/auth/register', client.toRegisterJSON(), {
    disableAuth: true
  })
    .then((data) => new Client(data))
}

export function updateClient (cozy, client, resetSecret = false) {
  if (!(client instanceof Client)) {
    client = new Client(client)
  }
  if (!client.isRegistered()) {
    return Promise.reject(new Error('Client not registered'))
  }
  let data = client.toRegisterJSON()
  data.client_id = client.clientID
  if (resetSecret) data.client_secret = client.clientSecret

  return cozyFetchJSON(cozy, 'PUT', `/auth/register/${client.clientID}`, data)
  .then((data) => new Client(data))
}

export function unregisterClient (cozy, client) {
  return cozyFetchJSON(cozy, 'DELETE', `/auth/register/${client.clientID}`)
}

// getClient will retrive the registered client informations from the server.
export function getClient (cozy, client) {
  if (!(client instanceof Client)) {
    client = new Client(client)
  }
  if (!client.isRegistered()) {
    return Promise.reject(new Error('Client not registered'))
  }
  return cozyFetchJSON(cozy, 'GET', `/auth/register/${client.clientID}`, null, {
    manualAuthCredentials: {
      client: client,
      token: client
    }
  })
    .then((data) => new Client(data))
}

// getAuthCodeURL returns a pair {authURL,state} given a registered client. The
// state should be stored in order to be checked against on the user validation
// phase.
export function getAuthCodeURL (cozy, client, permissions = {}) {
  if (!(client instanceof Client)) {
    client = new Client(client)
  }
  if (!client.isRegistered()) {
    throw new Error('Client not registered')
  }
  const scopes = []
  for (const permName in permissions) {
    if (permissions.hasOwnProperty(permName)) {
      const {type, verbs, selector, values} = permissions[permName]
    }
  }
  const state = generateRandomState()
  const query = {
    'client_id': client.clientID,
    'redirect_uri': client.redirectURI,
    'state': state,
    'response_type': 'code',
    'scope': scopes.join(' ')
  }
  return {
    url: cozy._url + `/auth/authorize?${encodeQuery(query)}`,
    state: state
  }
}

// getAccessToken perform a request on the access_token entrypoint with the
// authorization_code grant type in order to generate a new access token for a
// newly registered client.
//
// This method extracts the access code and state from the given URL. By
// default it uses window.location.href. Also, it checks the given state with
// the one specified in the URL query parameter to prevent CSRF attacks.
export function getAccessToken (cozy, client, state, pageURL = '') {
  if (!state) {
    return Promise.reject(new Error('Missing state value'))
  }
  const grantQueries = getGrantCodeFromPageURL(pageURL)
  if (grantQueries === null) {
    return Promise.reject(new Error('Missing states from current URL'))
  }
  if (state !== grantQueries.state) {
    return Promise.reject(new Error('Given state does not match url query state'))
  }
  return retrieveToken(cozy, client, null, {
    'grant_type': 'authorization_code',
    'code': grantQueries.code
  })
}

// refreshToken perform a request on the access_token entrypoint with the
// refresh_token grant type in order to refresh the given token.
export function refreshToken (cozy, client, token) {
  return retrieveToken(cozy, client, token, {
    'grant_type': 'refresh_token',
    'code': token.refreshToken
  })
}

// oauthFlow performs the stateful registration and access granting of an OAuth
// client.
export function oauthFlow (cozy, storage, clientParams, onRegistered) {
  let tryCount = 0

  function clearAndRetry (err) {
    if (tryCount++ > 0) {
      throw err
    }
    return storage.clear().then(() =>
      oauthFlow(cozy, storage, clientParams, onRegistered))
  }

  const { permissions } = clientParams

  function registerNewClient () {
    return storage.clear()
      .then(() => registerClient(cozy, clientParams))
      .then((client) => {
        const {url, state} = getAuthCodeURL(cozy, client, permissions)
        return storage.save(StateKey, {client, url, state})
      })
  }

  return Promise.all([
    storage.load(CredsKey),
    storage.load(StateKey)
  ])
  .then(([credentials, storedState]) => {
    // If credentials are cached we re-fetch the registered client with the
    // said token. Fetching the client, if the token is outdated we should try
    // the token is refreshed.
    if (credentials) {
      const {client, token} = credentials
      return getClient(cozy, client).then((client) => ({client, token}))
    }

    // Otherwise register a new client if necessary (ie. no client is stored)
    // and call the onRegistered callback to wait for the user to grant the
    // access. Finally fetches to access token on success.
    let statePromise
    if (!storedState) {
      statePromise = registerNewClient()
    } else {
      statePromise = Promise.resolve(storedState)
    }

    let client, state, token
    return statePromise
      .then((data) => {
        client = data.client
        state = data.state
        return Promise.resolve(onRegistered(client, data.url))
      })
      .then((pageURL) => getAccessToken(cozy, client, state, pageURL))
      .then((t) => { token = t })
      .then(() => storage.delete(StateKey))
      .then(() => ({client, token}))
  })
  .then(
    (creds) => storage.save(CredsKey, creds),
    (err) => {
      if ((err instanceof FetchError) && err.isUnauthorised()) {
        return clearAndRetry(err)
      } else {
        throw err
      }
    })
}

// retrieveToken perform a request on the access_token entrypoint in order to
// fetch a token.
function retrieveToken (cozy, client, token, query) {
  if (!(client instanceof Client)) {
    client = new Client(client)
  }
  if (!client.isRegistered()) {
    return Promise.reject(new Error('Client not registered'))
  }
  const body = encodeQuery(Object.assign({}, query, {
    'client_id': client.clientID,
    'client_secret': client.clientSecret
  }))
  return cozyFetchJSON(cozy, 'POST', '/auth/access_token', body, {
    disableAuth: (token === null),
    manualAuthCredentials: { client, token },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  })
    .then((data) => new AccessToken(data))
}

// getGrantCodeFromPageURL extract the state and access_code query parameters
// from the given url
function getGrantCodeFromPageURL (pageURL = '') {
  if (pageURL === '' && typeof window !== 'undefined') {
    pageURL = window.location.href
  }
  const queries = decodeQuery(pageURL)
  if (!queries.hasOwnProperty('state')) {
    return null
  }
  return {
    state: queries['state'],
    code: queries['access_code']
  }
}

// generateRandomState will try to generate a 128bits random value from a secure
// pseudo random generator. It will fallback on Math.random if it cannot find
// such generator.
function generateRandomState () {
  let buffer
  if (typeof window !== 'undefined' &&
      typeof window.crypto !== 'undefined' &&
      typeof window.crypto.getRandomValues === 'function') {
    buffer = new Uint8Array(StateSize)
    window.crypto.getRandomValues(buffer)
  } else {
    try {
      buffer = require('crypto').randomBytes(StateSize)
    } catch (e) {}
  }
  if (!buffer) {
    buffer = new Array(StateSize)
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] = Math.floor((Math.random() * 255))
    }
  }
  return btoa(String.fromCharCode.apply(null, buffer))
    .replace(/=+$/, '')
    .replace(/\//g, '_')
    .replace(/\+/g, '-')
}
