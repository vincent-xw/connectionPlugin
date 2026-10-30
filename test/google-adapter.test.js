import test from 'node:test'
import assert from 'node:assert/strict'
import { startFakeGoogle } from './support/fake-google.js'
import { MemoryCredentials, fakeContext, testLogger } from './support/memory-credentials.js'
import { GoogleAuth } from '../lib/adapters/google/auth.js'
import { GoogleApi } from '../lib/adapters/google/client.js'
import { createGoogleAdapter } from '../lib/adapters/google/index.js'
import { DOCUMENTS_SCOPE, DRIVE_METADATA_READONLY_SCOPE, GOOGLE_DEFAULT_CONFIG, PRESENTATIONS_SCOPE, SPREADSHEETS_SCOPE, resolveGoogleConfig } from '../lib/adapters/google/config.js'
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
    driveApiBase: google.baseUrl,
    sheetsApiBase: google.baseUrl,
    slidesApiBase: google.baseUrl,
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

test('Google Docs adapter: status marks an open flow even when a grant exists', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth } = await setup(google, {}, t)
  await authorize(google, auth)
  const settled = await auth.status({})
  assert.equal(settled.connected, true)
  assert.equal(settled.flowPending, false)

  await auth.start({})
  const pending = await auth.status({})
  assert.equal(pending.connected, true)
  assert.equal(pending.flowPending, true)
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

test('Google Docs adapter: lists Google Docs documents with paging and a title filter', async (t) => {
  const google = await startFakeGoogle({
    files: [
      { id: 'doc-a', name: 'Alpha notes', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-02T00:00:00.000Z' },
      { id: 'doc-b', name: 'Beta plan', mimeType: 'application/vnd.google-apps.document' },
      { id: 'sheet-1', name: 'Alpha sheet', mimeType: 'application/vnd.google-apps.spreadsheet' },
    ],
  })
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  const first = await adapter.list({ limit: 1 })
  assert.equal(first.platform, 'google-docs')
  assert.equal(first.documents.length, 1)
  assert.equal(first.documents[0].documentId, 'doc-a')
  assert.equal(first.documents[0].title, 'Alpha notes')
  assert.equal(first.documents[0].mimeType, 'application/vnd.google-apps.document')
  assert.equal(first.documents[0].modifiedTime, '2026-10-02T00:00:00.000Z')
  assert.match(first.documents[0].url, /document\/d\/doc-a\/edit/)
  assert.equal(first.nextPageToken, '1')

  const second = await adapter.list({ limit: 1, pageToken: first.nextPageToken })
  assert.deepEqual(second.documents.map((doc) => doc.documentId), ['doc-b'])
  assert.equal(second.nextPageToken, undefined)

  const filtered = await adapter.list({ query: "alph'a" })
  assert.deepEqual(filtered.documents, [])
  const request = google.driveRequests.at(-1)
  assert.match(request.q, /mimeType = 'application\/vnd\.google-apps\.document'/)
  assert.match(request.q, /trashed = false/)
  assert.match(request.q, /name contains 'alph\\'a'/)
  assert.equal(request.orderBy, 'modifiedTime desc')
  assert.match(request.fields, /nextPageToken/)
})

test('Google Docs adapter: lists Google Sheets and every native kind on request', async (t) => {
  const google = await startFakeGoogle({
    files: [
      { id: 'doc-a', name: 'Doc A', mimeType: 'application/vnd.google-apps.document' },
      { id: 'sheet-a', name: 'Sheet A', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-10-03T00:00:00.000Z' },
      { id: 'deck-a', name: 'Deck A', mimeType: 'application/vnd.google-apps.presentation' },
      { id: 'xlsx-a', name: 'Uploaded sheet', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    ],
  })
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  const sheets = await adapter.list({ type: 'spreadsheet' })
  assert.deepEqual(sheets.documents.map((doc) => doc.documentId), ['sheet-a'])
  assert.equal(sheets.documents[0].mimeType, 'application/vnd.google-apps.spreadsheet')
  assert.match(sheets.documents[0].url, /\/spreadsheets\/d\/sheet-a\/edit/)
  assert.match(google.driveRequests.at(-1).q, /mimeType = 'application\/vnd\.google-apps\.spreadsheet'/)

  const all = await adapter.list({ type: 'all' })
  assert.deepEqual(all.documents.map((doc) => doc.documentId).sort(), ['deck-a', 'doc-a', 'sheet-a'])
  const query = google.driveRequests.at(-1).q
  assert.match(query, /\(mimeType = '.*document' or mimeType = '.*spreadsheet' or mimeType = '.*presentation'\)/)

  await assert.rejects(
    () => adapter.list({ type: 'folder' }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.INVALID_INPUT)
      assert.match(error.hint, /document, spreadsheet, presentation, all/)
      return true
    },
  )
})

test('Google adapter: default scopes cover Docs, Sheets, Slides, and metadata', () => {
  assert.deepEqual(GOOGLE_DEFAULT_CONFIG.scopes, [
    DOCUMENTS_SCOPE,
    SPREADSHEETS_SCOPE,
    PRESENTATIONS_SCOPE,
    DRIVE_METADATA_READONLY_SCOPE,
  ])
  assert.equal(GOOGLE_DEFAULT_CONFIG.driveApiBase, 'https://www.googleapis.com')
  assert.equal(GOOGLE_DEFAULT_CONFIG.sheetsApiBase, 'https://sheets.googleapis.com')
  assert.equal(GOOGLE_DEFAULT_CONFIG.slidesApiBase, 'https://slides.googleapis.com')
})

test('Google Docs adapter: a disabled API is reported as configuration, not permission', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)
  google.failures.push({
    method: 'GET',
    path: /^\/drive\/v3\/files/,
    status: 403,
    body: {
      error: {
        code: 403,
        message: 'Google Drive API has not been used in project 123 before or it is disabled.',
        status: 'PERMISSION_DENIED',
        errors: [{ reason: 'accessNotConfigured', message: 'Access Not Configured' }],
      },
    },
  })
  await assert.rejects(
    () => adapter.list({}),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.NOT_CONFIGURED)
      assert.match(error.hint, /Google Drive API/)
      return true
    },
  )
})

test('Google Docs adapter: a token without the Drive scope reports the scope gap', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)
  google.settings.driveForbidden = true
  await assert.rejects(
    () => adapter.list({}),
    (error) => {
      assert.ok(error instanceof DocsError)
      assert.equal(error.code, DOCS_ERROR.FORBIDDEN)
      assert.match(error.hint, /drive\.metadata\.readonly/)
      return true
    },
  )
})

test('Google Docs adapter: docs_invoke listDocuments reaches the same listing', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)
  const result = await adapter.invoke(null, { action: 'listDocuments', payload: { limit: 10 } })
  assert.equal(result.platform, 'google-docs')
  assert.equal(result.documents[0].documentId, 'doc-1')
})

const SPREADSHEET = {
  id: 'sheet-1',
  title: '待办事项列表',
  sheets: [
    { title: 'Sheet1', values: [['任务', '状态'], ['写代码', '完成'], ['写测试', '进行中']] },
    { title: '归档', values: [['旧任务']] },
  ],
}

const DECK = {
  id: 'deck-1',
  title: 'Demo Deck',
  slides: [
    { objectId: 'slide-1', placeholder: 'TITLE', texts: ['Hello deck\n'] },
    { objectId: 'slide-2', texts: ['Bullet one\nBullet two\n'] },
  ],
}

test('Google adapter: reads a spreadsheet as one table block per sheet', async (t) => {
  const google = await startFakeGoogle({ spreadsheets: [SPREADSHEET] })
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  const snapshot = await adapter.read({ platform: 'google-docs', documentId: 'sheet-1' }, {})
  assert.equal(snapshot.title, '待办事项列表')
  assert.equal(snapshot.tabs.length, 2)
  assert.equal(snapshot.tabs[0].title, 'Sheet1')
  assert.deepEqual(snapshot.tabs[0].blocks[0], {
    type: 'table',
    rows: [['任务', '状态'], ['写代码', '完成'], ['写测试', '进行中']],
  })
  assert.equal(snapshot.tabs[1].title, '归档')
  assert.match(snapshot.url, /spreadsheets\/d\/sheet-1\/edit/)
})

test('Google adapter: reads a presentation as one tab per slide', async (t) => {
  const google = await startFakeGoogle({ presentations: [DECK] })
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  const snapshot = await adapter.read({ platform: 'google-docs', documentId: 'deck-1' }, {})
  assert.equal(snapshot.title, 'Demo Deck')
  assert.equal(snapshot.tabs.length, 2)
  assert.deepEqual(snapshot.tabs[0].blocks, [{ type: 'heading', level: 1, text: 'Hello deck' }])
  assert.equal(snapshot.tabs[0].title, 'Hello deck')
  assert.deepEqual(snapshot.tabs[1].blocks, [
    { type: 'paragraph', text: 'Bullet one' },
    { type: 'paragraph', text: 'Bullet two' },
  ])
  assert.match(snapshot.url, /presentation\/d\/deck-1\/edit/)
})

test('Google adapter: slides replace works and sheets replace points at docs_sheet_update', async (t) => {
  const google = await startFakeGoogle({ spreadsheets: [SPREADSHEET], presentations: [DECK] })
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  const replaced = await adapter.replace({ platform: 'google-docs', documentId: 'deck-1' }, { find: 'Bullet', replace: 'Point' })
  assert.equal(replaced.occurrencesChanged, 2)
  assert.match(replaced.url, /presentation\/d\/deck-1\/edit/)
  const deck = google.workspace.decks.get('deck-1')
  assert.equal(deck.slides[1].pageElements[0].shape.text.textElements[0].textRun.content, 'Point one\nPoint two\n')

  await assert.rejects(
    () => adapter.replace({ platform: 'google-docs', documentId: 'sheet-1' }, { find: 'a', replace: 'b' }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.UNSUPPORTED)
      assert.match(error.hint, /docs_sheet_update/)
      return true
    },
  )
})

test('Google adapter: writes one A1 range and appends rows', async (t) => {
  const google = await startFakeGoogle({ spreadsheets: [SPREADSHEET] })
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  const ref = { platform: 'google-docs', documentId: 'sheet-1' }
  const updated = await adapter.updateValues(ref, { range: 'Sheet1!B3', values: [['已完成']] })
  assert.equal(updated.updatedRows, 1)
  assert.equal(updated.updatedCells, 1)
  assert.match(updated.range, /Sheet1/)
  assert.equal(google.workspace.sheets.get('sheet-1').sheets[0].values[2][1], '已完成')

  const appended = await adapter.appendValues(ref, { values: [['新任务', '待办']] })
  assert.equal(appended.updatedRows, 1)
  assert.match(appended.url, /spreadsheets\/d\/sheet-1\/edit/)
  assert.match(appended.range, /^'Sheet1'!/)
  const values = google.workspace.sheets.get('sheet-1').sheets[0].values
  assert.deepEqual(values.at(-1), ['新任务', '待办'])

  await assert.rejects(
    () => adapter.appendValues(ref, { values: 'not-a-matrix' }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.INVALID_INPUT)
      return true
    },
  )
})

test('Google adapter: cells cannot be written to a Docs document', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)
  await assert.rejects(
    () => adapter.updateValues(DOC_REF, { range: 'A1', values: [['x']] }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.INVALID_INPUT)
      assert.match(error.hint, /docs_append|docs_insert/)
      return true
    },
  )
})

test('Google adapter: an unsupported file kind is rejected as UNSUPPORTED', async (t) => {
  const google = await startFakeGoogle({
    files: [{ id: 'pdf-1', name: 'report.pdf', mimeType: 'application/pdf' }],
  })
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)
  await assert.rejects(
    () => adapter.read({ platform: 'google-docs', documentId: 'pdf-1' }, {}),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.UNSUPPORTED)
      assert.match(error.hint, /Only Google Docs, Google Sheets, and Google Slides/)
      return true
    },
  )
})

test('Google adapter: sheet and slide URLs parse into references', async () => {
  const { parseGoogleRef } = await import('../lib/adapters/google/convert.js')
  const sheet = parseGoogleRef('https://docs.google.com/spreadsheets/d/abc123/edit#gid=0')
  assert.deepEqual(sheet, { documentId: 'abc123', url: 'https://docs.google.com/spreadsheets/d/abc123/edit' })
  const deck = parseGoogleRef('https://docs.google.com/presentation/d/xyz789/edit')
  assert.deepEqual(deck, { documentId: 'xyz789', url: 'https://docs.google.com/presentation/d/xyz789/edit' })
})

test('Google adapter: appends text to a slide shape and validates the target', async (t) => {
  const google = await startFakeGoogle({ presentations: [DECK] })
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)
  const ref = { platform: 'google-docs', documentId: 'deck-1' }

  const first = await adapter.insertSlideText(ref, { text: ' (appended)' })
  assert.equal(first.slide, 'slide-1')
  assert.equal(first.shape, 'element-0-0')
  assert.equal(first.insertedChars, 11)

  const second = await adapter.insertSlideText(ref, { slide: '1', text: '!!' })
  assert.equal(second.slide, 'slide-2')
  const deck = google.workspace.decks.get('deck-1')
  assert.equal(deck.slides[0].pageElements[0].shape.text.textElements[0].textRun.content, 'Hello deck\n (appended)')
  assert.equal(deck.slides[1].pageElements[0].shape.text.textElements[0].textRun.content, 'Bullet one\nBullet two\n!!')

  await assert.rejects(
    () => adapter.insertSlideText(ref, { slide: 'nope', text: 'x' }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.INVALID_INPUT)
      assert.match(error.hint, /0=slide-1, 1=slide-2/)
      return true
    },
  )

  await assert.rejects(
    () => adapter.insertSlideText(DOC_REF, { text: 'x' }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.INVALID_INPUT)
      assert.match(error.message, /only be inserted into a Google Slides presentation/)
      return true
    },
  )

  await assert.rejects(
    () => adapter.insertSlideText(ref, { text: '   ' }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.INVALID_INPUT)
      return true
    },
  )
})

test('Google adapter: creates a spreadsheet with named sheets and values', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  const created = await adapter.create({
    kind: 'spreadsheet',
    title: 'Q4 导入测试',
    sheets: [
      { title: '进度总览', values: [['标题'], ['进展']] },
      { title: '空表', values: [] },
    ],
  })
  assert.match(created.documentId, /^created-sheet-/)
  assert.match(created.url, /spreadsheets\/d\//)
  assert.deepEqual(created.tabs, ['进度总览', '空表'])

  const stored = google.workspace.sheets.get(created.documentId)
  assert.deepEqual(stored.sheets.map((sheet) => sheet.properties.title), ['进度总览', '空表'])
  assert.deepEqual(stored.sheets[0].values, [['标题'], ['进展']])
  assert.deepEqual(stored.sheets[1].values, [])

  const read = await adapter.read({ platform: 'google-docs', documentId: created.documentId }, {})
  assert.equal(read.tabs.length, 2)
  assert.equal(read.tabs[0].title, '进度总览')
  assert.deepEqual(read.tabs[0].blocks[0].rows, [['标题'], ['进展']])
  assert.deepEqual(read.tabs[1].blocks, [{ type: 'paragraph', text: '(empty sheet)' }])

  const listed = await adapter.list({ type: 'spreadsheet' })
  assert.ok(listed.documents.some((doc) => doc.documentId === created.documentId))
})

test('Google adapter: spreadsheet create rejects duplicate or empty sheet titles', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)

  await assert.rejects(
    () => adapter.create({ kind: 'spreadsheet', title: 'X', sheets: [{ title: 'A' }, { title: 'A' }] }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.INVALID_INPUT)
      assert.match(error.message, /duplicate sheet title/)
      return true
    },
  )
  await assert.rejects(
    () => adapter.create({ kind: 'spreadsheet', title: 'X', sheets: [{ values: [['a']] }] }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.INVALID_INPUT)
      assert.match(error.message, /title must not be empty/)
      return true
    },
  )
  await assert.rejects(
    () => adapter.create({ kind: 'presentation', title: 'X' }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.UNSUPPORTED)
      assert.match(error.hint, /document .*spreadsheet/)
      return true
    },
  )
})

test('Google adapter: applies raw batchUpdate formatting requests', async (t) => {
  const google = await startFakeGoogle({ spreadsheets: [SPREADSHEET] })
  t.after(() => google.close())
  const { auth, adapter } = await setup(google, {}, t)
  await authorize(google, auth)
  const ref = { platform: 'google-docs', documentId: 'sheet-1' }

  const requests = [
    {
      repeatCell: {
        range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
        cellFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.27, green: 0.33, blue: 0.42 } },
        fields: 'userEnteredFormat(textFormat,backgroundColor)',
      },
    },
    { updateSheetProperties: { properties: { sheetId: 0, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
    { mergeCells: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 2 }, mergeType: 'MERGE_ALL' } },
  ]
  const result = await adapter.formatSheet(ref, { requests })
  assert.equal(result.replies.length, 3)
  assert.match(result.url, /spreadsheets\/d\/sheet-1\/edit/)
  assert.equal(google.workspace.applied.length, 3)
  assert.equal(google.workspace.applied[0].repeatCell.cellFormat.textFormat.bold, true)

  await assert.rejects(
    () => adapter.formatSheet(ref, { requests: [] }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.INVALID_INPUT)
      assert.match(error.hint, /repeatCell/)
      return true
    },
  )
  await assert.rejects(
    () => adapter.formatSheet(DOC_REF, { requests }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.INVALID_INPUT)
      assert.match(error.message, /formatting applies to a Google Sheet only/)
      return true
    },
  )
})
