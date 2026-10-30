import test from 'node:test'
import assert from 'node:assert/strict'
import { startFakeGoogle } from './support/fake-google.js'
import { MemoryCredentials, fakeContext, testLogger } from './support/memory-credentials.js'
import { GoogleAuth } from '../lib/adapters/google/auth.js'
import { GoogleApi } from '../lib/adapters/google/client.js'
import { createGoogleAdapter } from '../lib/adapters/google/index.js'
import { DOCUMENTS_SCOPE, resolveGoogleConfig } from '../lib/adapters/google/config.js'
import { DOCS_ERROR, DocsError } from '../lib/core/errors.js'

const CLIENT_ID = 'client-1'
const DOC_REF = { platform: 'google-docs', documentId: 'doc-1' }

async function setup(google, overrides = {}, t, fetchImpl = globalThis.fetch) {
  const credentials = new MemoryCredentials()
  const ctx = fakeContext({ credentials })
  const config = resolveGoogleConfig({
    clientId: CLIENT_ID,
    clientSecret: 'secret-1',
    scopes: [DOCUMENTS_SCOPE],
    apiBase: google.baseUrl,
    authEndpoint: `${google.baseUrl}/auth`,
    tokenEndpoint: `${google.baseUrl}/token`,
    revokeEndpoint: `${google.baseUrl}/revoke`,
    autoOpenBrowser: false,
    timeoutMs: 5000,
    maxRetries: 1,
    allowRawActions: true,
    ...overrides,
  })
  const logger = testLogger()
  const auth = new GoogleAuth({ ctx, config, fetchImpl, logger })
  const api = new GoogleApi({ auth, config, fetchImpl, logger })
  const adapter = createGoogleAdapter({ config, auth, api, logger })
  t?.after(() => auth.close())
  return { credentials, ctx, config, auth, api, adapter }
}

async function authorize(google, auth, { code = 'code-1', account = 'default' } = {}) {
  const started = await auth.start({ account })
  const url = new URL(started.url)
  const state = url.searchParams.get('state')
  const challenge = url.searchParams.get('code_challenge')
  const redirectUri = url.searchParams.get('redirect_uri')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('access_type'), 'offline')
  google.addCode(code, { clientId: CLIENT_ID, challenge })
  const callback = new URL(redirectUri)
  callback.searchParams.set('code', code)
  callback.searchParams.set('state', state)
  const response = await fetch(callback)
  assert.equal(response.status, 200, await response.text())
  return { url, state, redirectUri }
}

test('Google Docs adapter: OAuth, read, append, replace, insert, create, conflict', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { credentials, auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  const status = await auth.status()
  assert.equal(status.connected, true)
  assert.equal(status.account, 'default')
  assert.equal(credentials.records.size, 1)
  const record = [...credentials.records.values()][0]
  assert.equal(record.kind, 'grant')
  assert.equal(record.payload.refreshToken, 'refresh-1')

  const snapshot = await adapter.read(DOC_REF, {})
  assert.equal(snapshot.platform, 'google-docs')
  assert.equal(snapshot.title, 'Test Doc')
  assert.equal(snapshot.revision, 'rev-1')
  assert.equal(snapshot.tabs.length, 1)
  assert.equal(snapshot.tabs[0].id, 't.0')
  assert.match(snapshot.tabs[0].blocks[0].text, /Hello/)

  const appended = await adapter.append(DOC_REF, { text: 'world' })
  assert.equal(appended.tab, 't.0')
  assert.equal(appended.revision, 'rev-2')
  assert.equal(google.document('doc-1').tabs[0].text, 'Hello\nworld\n')

  const replaced = await adapter.replace(DOC_REF, { find: 'world', replace: 'there' })
  assert.equal(replaced.occurrencesChanged, 1)
  assert.equal(google.document('doc-1').tabs[0].text, 'Hello\nthere\n')

  const inserted = await adapter.insert(DOC_REF, { index: 1, text: 'X' })
  assert.equal(inserted.index, 1)
  assert.equal(google.document('doc-1').tabs[0].text, 'HXello\nthere\n')

  await assert.rejects(
    () => adapter.append(DOC_REF, { text: 'stale', expectedRevision: 'rev-1' }),
    (error) => {
      assert.ok(error instanceof DocsError)
      assert.equal(error.code, DOCS_ERROR.REVISION_CONFLICT)
      assert.match(error.message, /revision/i)
      return true
    },
  )
  assert.equal(google.document('doc-1').tabs[0].text, 'HXello\nthere\n')

  const created = await adapter.create({ title: 'Fresh Doc', text: 'New body' })
  assert.equal(created.documentId, 'doc-2')
  assert.match(created.url, /document\/d\/doc-2\/edit/)
  const fresh = await adapter.read({ platform: 'google-docs', documentId: 'doc-2' }, {})
  assert.equal(fresh.title, 'Fresh Doc')
  assert.match(fresh.tabs[0].blocks[0].text, /New body/)
})

test('Google Docs adapter: tab-scoped replace leaves other tabs alone', async (t) => {
  const google = await startFakeGoogle({
    tabs: [
      { title: 'One', text: 'alpha\n' },
      { title: 'Two', text: 'alpha\n' },
    ],
  })
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  const result = await adapter.replace(DOC_REF, { tab: 't.1', find: 'alpha', replace: 'beta' })
  assert.equal(result.occurrencesChanged, 1)
  assert.equal(google.document('doc-1').tabs[0].text, 'alpha\n')
  assert.equal(google.document('doc-1').tabs[1].text, 'beta\n')

  const all = await adapter.replace(DOC_REF, { find: 'alpha', replace: 'gamma' })
  assert.equal(all.occurrencesChanged, 1)
  assert.equal(google.document('doc-1').tabs[0].text, 'gamma\n')
})

test('Google Docs adapter: refresh on 401 and reuse the saved refresh token', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { credentials, auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  for (const token of [...google.accessTokens]) google.accessTokens.delete(token)
  const snapshot = await adapter.read(DOC_REF, {})
  assert.equal(snapshot.title, 'Test Doc')
  assert.ok(google.tokenRequests.some((request) => request.grant_type === 'refresh_token'))
  const record = [...credentials.records.values()][0]
  assert.equal(record.payload.refreshToken, 'refresh-1')
})

test('Google Docs adapter: retries a rate-limited read', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  google.failures.push({
    method: 'GET',
    path: /^\/v1\/documents\//,
    status: 429,
    headers: { 'retry-after': '0' },
    body: { error: { code: 429, message: 'Rate limit exceeded', status: 'RESOURCE_EXHAUSTED' } },
  })
  const snapshot = await adapter.read(DOC_REF, {})
  assert.equal(snapshot.title, 'Test Doc')
})

test('Google Docs adapter: create with a tab title writes into the new tab', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  const created = await adapter.create({ title: 'Tabbed', text: 'inside tab', tabTitle: 'Notes' })
  assert.equal(created.tab, 't.1')
  const document = google.document(created.documentId)
  assert.equal(document.tabs.length, 2)
  assert.equal(document.tabs[1].title, 'Notes')
  assert.match(document.tabs[1].text, /inside tab/)
  assert.equal(document.tabs[0].text, '\n')
})

test('Google Docs adapter: rejects a callback with a mismatched state', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth } = await setup(google, {}, t)
  const started = await auth.start({})
  const url = new URL(started.url)
  const redirectUri = url.searchParams.get('redirect_uri')
  google.addCode('code-x', { clientId: CLIENT_ID, challenge: url.searchParams.get('code_challenge') })
  const callback = new URL(redirectUri)
  callback.searchParams.set('code', 'code-x')
  callback.searchParams.set('state', 'not-the-state')
  const response = await fetch(callback)
  assert.equal(response.status, 400)
  assert.equal((await auth.status()).connected, false)
})

test('Google Docs adapter: reports an authorization denial without connecting', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth } = await setup(google, {}, t)
  const started = await auth.start({})
  const url = new URL(started.url)
  const callback = new URL(url.searchParams.get('redirect_uri'))
  callback.searchParams.set('error', 'access_denied')
  callback.searchParams.set('error_description', 'The user denied the request')
  const response = await fetch(callback)
  assert.equal(response.status, 400)
  const status = await auth.status()
  assert.equal(status.connected, false)
  assert.match(status.detail, /denied/)
})

test('Google Docs adapter: disconnect deletes the grant', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { credentials, auth } = await setup(google, {}, t)
  await authorize(google, auth)
  assert.equal(credentials.records.size, 1)
  await auth.disconnect({})
  assert.equal(credentials.records.size, 0)
  assert.equal((await auth.status()).connected, false)
})

test('Google Docs adapter: missing client id fails with NOT_CONFIGURED', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth } = await setup(google, { clientId: '' }, t)
  await assert.rejects(
    () => auth.start({}),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.NOT_CONFIGURED)
      assert.match(error.message, /client id/i)
      return true
    },
  )
})

test('proxy transport: HTTP CONNECT carries OAuth and Docs API traffic', async (t) => {
  const { startConnectProxy } = await import('./support/proxy.js')
  const { createProxiedFetch } = await import('../lib/adapters/google/proxy-fetch.js')
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const proxy = await startConnectProxy()
  t.after(() => proxy.close())
  const proxied = createProxiedFetch({
    proxy: `http://127.0.0.1:${proxy.port}`,
    proxyFromEnv: false,
    bypassLoopback: false,
  })
  const { auth, adapter } = await setup(google, {}, t, proxied)
  await authorize(google, auth)
  const snapshot = await adapter.read(DOC_REF, {})
  assert.equal(snapshot.title, 'Test Doc')
  const appended = await adapter.append(DOC_REF, { text: 'through proxy' })
  assert.equal(appended.revision, 'rev-2')
  assert.ok(proxy.stats.tunnels >= 3, `expected several tunnels, saw ${proxy.stats.tunnels}`)
  assert.ok(proxy.stats.targets.every((target) => target.startsWith('127.0.0.1:')), proxy.stats.targets.join(','))
  assert.equal(google.document('doc-1').tabs[0].text, 'Hello\nthrough proxy\n')
})

test('proxy transport: SOCKS5 carries Docs API traffic', async (t) => {
  const { startSocks5Proxy } = await import('./support/proxy.js')
  const { createProxiedFetch } = await import('../lib/adapters/google/proxy-fetch.js')
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const proxy = await startSocks5Proxy()
  t.after(() => proxy.close())
  const proxied = createProxiedFetch({
    proxy: `socks5://127.0.0.1:${proxy.port}`,
    proxyFromEnv: false,
    bypassLoopback: false,
  })
  const { auth, adapter } = await setup(google, {}, t, proxied)
  await authorize(google, auth)
  const snapshot = await adapter.read(DOC_REF, {})
  assert.equal(snapshot.title, 'Test Doc')
  assert.ok(proxy.stats.tunnels >= 2, `expected tunnels, saw ${proxy.stats.tunnels}`)
})

test('Google Docs adapter: a public client id supplied at connect time is remembered', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { credentials, auth, adapter } = await setup(google, { clientId: '' }, t)
  const started = await auth.start({ clientId: CLIENT_ID })
  assert.equal(await auth.clientId(), CLIENT_ID)
  assert.equal(credentials.records.get('docs-connector/google-docs-config').payload.clientId, CLIENT_ID)
  const url = new URL(started.url)
  const challenge = url.searchParams.get('code_challenge')
  google.addCode('code-2', { clientId: CLIENT_ID, challenge })
  const callback = new URL(url.searchParams.get('redirect_uri'))
  callback.searchParams.set('code', 'code-2')
  callback.searchParams.set('state', url.searchParams.get('state'))
  const response = await fetch(callback)
  assert.equal(response.status, 200)
  const snapshot = await adapter.read(DOC_REF, {})
  assert.equal(snapshot.title, 'Test Doc')
})


test('Google Docs adapter: re-reads the revision when batchUpdate omits writeControl', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)
  google.settings.omitWriteControl = true
  const appended = await adapter.append(DOC_REF, { text: 'no revision echoed' })
  assert.equal(appended.revision, 'rev-2')
  google.settings.omitWriteControl = false
})
