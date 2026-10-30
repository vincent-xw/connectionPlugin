import test from 'node:test'
import assert from 'node:assert/strict'
import { AdapterRegistry, normalizeCapabilities, validateAdapter } from '../lib/core/registry.js'
import { DocsService } from '../lib/core/service.js'
import { DOCS_ERROR, DocsError } from '../lib/core/errors.js'
import { fakeContext, testLogger } from './support/memory-credentials.js'

function makeAdapter(id, overrides = {}) {
  return {
    id,
    title: `${id} platform`,
    refExample: `${id}:doc-1`,
    parseRef: (input) => /^doc-[A-Za-z0-9]+$/.test(input) ? { documentId: input } : null,
    formatRef: (ref) => `${id}://${ref.documentId}`,
    async read(ref) {
      return {
        platform: id,
        documentId: ref.documentId,
        title: 'Adapter Doc',
        revision: 'rev-1',
        tabs: [{ id: 'tab-1', title: 'Tab 1', blocks: [{ type: 'paragraph', text: 'hello' }] }],
      }
    },
    ...overrides,
  }
}

test('capabilities are inferred from methods unless explicitly disabled', () => {
  const readOnly = normalizeCapabilities({ read: async () => {}, create: async () => {} })
  assert.equal(readOnly.read, true)
  assert.equal(readOnly.create, true)
  assert.equal(readOnly.replace, false)
  const disabled = normalizeCapabilities({ read: async () => {}, capabilities: { read: false, create: true }, create: async () => {} })
  assert.equal(disabled.read, false)
  assert.equal(disabled.create, true)
  assert.equal(normalizeCapabilities({ auth: { status() {}, start() {}, disconnect() {} }, read: async () => {} }).auth, true)
})

test('validateAdapter rejects a malformed contract', () => {
  assert.throws(() => validateAdapter({ id: 'Bad ID', parseRef() {} }), (error) => error.code === DOCS_ERROR.INVALID_INPUT)
  assert.throws(() => validateAdapter({ id: 'ok' }), /parseRef/)
  assert.throws(() => validateAdapter({ id: 'ok', parseRef() {}, capabilities: { read: true } }), /declares "read"/)
  assert.throws(() => validateAdapter({ id: 'ok', parseRef() {}, auth: { status() {} } }), /auth\.start/)
})

test('registry registers, rejects duplicates, and disposes idempotently', () => {
  const registry = new AdapterRegistry()
  const adapter = makeAdapter('alpha')
  const dispose = registry.register(adapter)
  assert.equal(registry.list().length, 1)
  assert.equal(registry.get('alpha'), adapter)
  assert.throws(() => registry.register(makeAdapter('alpha')), /already registered/)
  dispose()
  dispose()
  assert.equal(registry.list().length, 0)
})

test('registry chooses a default platform, the only platform, or fails', () => {
  const registry = new AdapterRegistry({ defaultPlatform: 'beta' })
  registry.register(makeAdapter('alpha'))
  assert.equal(registry.choose().id, 'alpha')
  registry.register(makeAdapter('beta'))
  assert.equal(registry.choose().id, 'beta')
  assert.equal(registry.choose('alpha').id, 'alpha')
  assert.throws(() => registry.choose('missing'), (error) => error.code === DOCS_ERROR.UNKNOWN_PLATFORM)

  const ambiguous = new AdapterRegistry()
  ambiguous.register(makeAdapter('one'))
  ambiguous.register(makeAdapter('two'))
  assert.throws(() => ambiguous.choose(), (error) => error.code === DOCS_ERROR.AMBIGUOUS_PLATFORM)
  assert.throws(() => new AdapterRegistry().choose(), (error) => error.code === DOCS_ERROR.PLATFORM_UNAVAILABLE)
})

test('registry parses prefixed refs, platform-hinted refs, and rejects ambiguity', () => {
  const registry = new AdapterRegistry()
  registry.register(makeAdapter('alpha'))
  const parsed = registry.parse('alpha:doc-9')
  assert.equal(parsed.adapter.id, 'alpha')
  assert.deepEqual(parsed.ref, { platform: 'alpha', documentId: 'doc-9' })
  assert.equal(registry.parse('doc-7', 'alpha').ref.documentId, 'doc-7')
  assert.throws(() => registry.parse('not-a-ref'), (error) => error.code === DOCS_ERROR.INVALID_REFERENCE)
  assert.throws(() => registry.parse('doc-7', 'missing'), (error) => error.code === DOCS_ERROR.UNKNOWN_PLATFORM)

  const both = new AdapterRegistry()
  both.register(makeAdapter('one', { parseRef: () => ({ documentId: 'shared' }) }))
  both.register(makeAdapter('two', { parseRef: () => ({ documentId: 'shared' }) }))
  assert.throws(() => both.parse('shared'), (error) => error.code === DOCS_ERROR.AMBIGUOUS_PLATFORM)
})

test('DocsService dispatches read to the adapter and normalizes the result', async () => {
  const ctx = fakeContext()
  const service = new DocsService(ctx, { defaultPlatform: 'alpha', maxReadChars: 20 })
  service.registerAdapter(makeAdapter('alpha'), ctx)
  const result = await service.read({ document: 'alpha:doc-1' })
  assert.equal(result.platform, 'alpha')
  assert.equal(result.documentId, 'doc-1')
  assert.equal(result.title, 'Adapter Doc')
  assert.equal(result.revision, 'rev-1')
  assert.equal(result.tabs.length, 1)
  assert.match(result.text, /hello/)
  assert.equal(result.truncated, false)
})

test('DocsService scopes read to a tab and passes the account through', async () => {
  let seen
  const ctx = fakeContext()
  const adapter = makeAdapter('alpha', {
    async read(ref, options) {
      seen = options
      return {
        platform: 'alpha',
        documentId: ref.documentId,
        title: 'Two Tabs',
        tabs: [
          { id: 't.0', title: 'One', blocks: [{ type: 'paragraph', text: 'first' }] },
          { id: 't.1', title: 'Two', blocks: [{ type: 'paragraph', text: 'second' }] },
        ],
      }
    },
  })
  const service = new DocsService(ctx, {})
  service.registerAdapter(adapter, ctx)
  const result = await service.read({ document: 'alpha:doc-1', tab: 'Two', account: 'work' })
  assert.equal(seen.account, 'work')
  assert.equal(result.text, 'second')
  assert.equal(result.tabs.length, 2)
  await assert.rejects(() => service.read({ document: 'alpha:doc-1', tab: 'missing' }), /no tab matches/)
})

test('DocsService reports unsupported capabilities and wraps adapter failures', async () => {
  const ctx = fakeContext()
  const service = new DocsService(ctx, {})
  service.registerAdapter(makeAdapter('alpha'), ctx)
  await assert.rejects(() => service.create({ title: 'x' }), (error) => {
    assert.equal(error.code, DOCS_ERROR.UNSUPPORTED)
    assert.match(error.message, /does not support create/)
    return true
  })

  const failing = makeAdapter('beta', {
    async read() {
      throw new Error('upstream exploded')
    },
  })
  service.registerAdapter(failing, ctx)
  await assert.rejects(() => service.read({ document: 'beta:doc-1' }), (error) => {
    assert.ok(error instanceof DocsError)
    assert.equal(error.code, DOCS_ERROR.UPSTREAM)
    assert.equal(error.platform, 'beta')
    return true
  })
})

test('DocsService lists documents, bounds the page, and resolves missing URLs', async () => {
  let seen
  const ctx = fakeContext()
  const service = new DocsService(ctx, { defaultPlatform: 'alpha' })
  service.registerAdapter(makeAdapter('alpha', {
    formatRef: (ref) => `alpha://${ref.documentId}`,
    async list(request) {
      seen = request
      return {
        documents: [
          { documentId: 'doc-1', title: 'First', modifiedTime: '2026-10-01T00:00:00.000Z' },
          { documentId: 'doc-2' },
        ],
        nextPageToken: 'page-2',
      }
    },
  }), ctx)
  const result = await service.list({ limit: 500, pageToken: 'page-1', query: '  First  ', account: 'work' })
  assert.equal(seen.limit, 100)
  assert.equal(seen.pageToken, 'page-1')
  assert.equal(seen.query, 'First')
  assert.equal(seen.account, 'work')
  assert.equal(result.platform, 'alpha')
  assert.equal(result.nextPageToken, 'page-2')
  assert.deepEqual(result.documents[0], {
    documentId: 'doc-1',
    title: 'First',
    url: 'alpha://doc-1',
    modifiedTime: '2026-10-01T00:00:00.000Z',
  })
  assert.equal(result.documents[1].title, 'doc-2')
  assert.equal(result.documents[1].url, 'alpha://doc-2')

  const bounded = await service.list({})
  assert.equal(seen.limit, 20)
  assert.equal(bounded.documents.length, 2)
})

test('DocsService rejects a listing without identities and platforms without list', async () => {
  const ctx = fakeContext()
  const service = new DocsService(ctx, { defaultPlatform: 'alpha' })
  service.registerAdapter(makeAdapter('alpha', {
    async list() {
      return { documents: [{ title: 'no id' }] }
    },
  }), ctx)
  await assert.rejects(() => service.list({}), (error) => {
    assert.equal(error.code, DOCS_ERROR.UPSTREAM)
    assert.match(error.message, /without documentId/)
    return true
  })

  const readOnly = new DocsService(ctx, { defaultPlatform: 'readonly' })
  readOnly.registerAdapter(makeAdapter('readonly'), ctx)
  await assert.rejects(() => readOnly.list({}), (error) => {
    assert.equal(error.code, DOCS_ERROR.UNSUPPORTED)
    assert.match(error.message, /does not support list/)
    return true
  })
})

test('DocsService connect returns a URL, reports pending, and honors already-connected', async () => {
  const ctx = fakeContext()
  const service = new DocsService(ctx, { defaultPlatform: 'alpha' })
  let connected = false
  const adapter = makeAdapter('alpha', {
    auth: {
      defaultAccount: 'default',
      async status({ account }) {
        return { connected, account }
      },
      async start({ account }) {
        return { url: 'https://example.test/auth', account, expiresAt: Date.now() + 1000 }
      },
      async disconnect() {
        connected = false
      },
    },
  })
  service.registerAdapter(adapter, ctx)
  const pending = await service.connect({ waitSeconds: 0 })
  assert.equal(pending.connected, false)
  assert.equal(pending.status, 'pending')
  assert.equal(pending.url, 'https://example.test/auth')

  connected = true
  const again = await service.connect({})
  assert.equal(again.connected, true)
  assert.equal(again.alreadyConnected, true)

  const disconnected = await service.disconnect({})
  assert.equal(disconnected.connected, false)
  assert.equal(connected, false)
})

test('DocsService dispatches spreadsheet writes and reports missing capabilities', async () => {
  const ctx = fakeContext()
  const service = new DocsService(ctx, { defaultPlatform: 'alpha' })
  const seen = []
  service.registerAdapter(makeAdapter('alpha', {
    async updateValues(ref, request) {
      seen.push(['update', ref.documentId, request])
      return { range: 'Sheet1!A1', updatedRows: 1, updatedColumns: 2, updatedCells: 2 }
    },
    async appendValues(ref, request) {
      seen.push(['append', ref.documentId, request])
      return { range: "'Sheet1'!A9", updatedRows: 1 }
    },
  }), ctx)

  const updated = await service.updateValues({ document: 'alpha:doc-1', range: 'Sheet1!A1', values: [['a', 'b']], account: 'work' })
  assert.equal(seen[0][1], 'doc-1')
  assert.equal(seen[0][2].range, 'Sheet1!A1')
  assert.equal(seen[0][2].account, 'work')
  assert.deepEqual(updated, {
    platform: 'alpha',
    documentId: 'doc-1',
    range: 'Sheet1!A1',
    updatedRows: 1,
    updatedColumns: 2,
    updatedCells: 2,
  })

  const appended = await service.appendValues({ document: 'alpha:doc-1', values: [['c']] })
  assert.equal(appended.range, "'Sheet1'!A9")
  assert.equal(appended.updatedCells, undefined)

  const bare = new DocsService(ctx, { defaultPlatform: 'plain' })
  bare.registerAdapter(makeAdapter('plain'), ctx)
  await assert.rejects(() => bare.updateValues({ document: 'plain:doc-1', range: 'A1', values: [['x']] }), (error) => {
    assert.equal(error.code, DOCS_ERROR.UNSUPPORTED)
    assert.match(error.message, /does not support updateValues/)
    return true
  })
})

test('DocsService connect does not mistake an older grant for the fresh flow', async () => {
  const ctx = fakeContext()
  const service = new DocsService(ctx, { defaultPlatform: 'alpha' })
  let connected = true
  let flowPending = false
  service.registerAdapter(makeAdapter('alpha', {
    auth: {
      async status() {
        return { connected, flowPending }
      },
      async start() {
        flowPending = true
        return { url: 'https://example.test/auth' }
      },
      async disconnect() {
        connected = false
      },
    },
  }), ctx)

  const first = await service.connect({ force: true, waitSeconds: 0 })
  assert.equal(first.connected, false)
  assert.equal(first.status, 'pending')
  assert.match(first.url, /example\.test/)

  setTimeout(() => {
    flowPending = false
  }, 100)
  const second = await service.connect({ force: true, waitSeconds: 5 })
  assert.equal(second.connected, true)
  assert.equal(second.status, 'connected')
})

test('DocsService catalog reports capabilities and live auth state', async () => {
  const ctx = fakeContext()
  const service = new DocsService(ctx, { defaultPlatform: 'alpha' })
  service.registerAdapter(makeAdapter('alpha', {
    auth: {
      async status() {
        return { connected: true, account: 'default', expiresAt: Date.now() + 10000 }
      },
      async start() {
        return { url: 'https://example.test/auth' }
      },
      async disconnect() {},
    },
  }), ctx)
  const catalog = await service.catalog()
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].id, 'alpha')
  assert.equal(catalog[0].default, true)
  assert.equal(catalog[0].capabilities.read, true)
  assert.equal(catalog[0].auth.connected, true)
  assert.equal(typeof catalog[0].auth.expiresAt, 'string')
})

test('DocsService invoke is gated by allowCustomActions and capability', async () => {
  const ctx = fakeContext()
  const adapter = makeAdapter('alpha', { async invoke() { return { ok: true } } })
  const blocked = new DocsService(ctx, { allowCustomActions: false })
  blocked.registerAdapter(adapter, ctx)
  await assert.rejects(() => blocked.invoke({ action: 'ping' }), (error) => error.code === DOCS_ERROR.UNSUPPORTED)

  const allowed = new DocsService(ctx, { allowCustomActions: true })
  allowed.registerAdapter(adapter, ctx)
  const result = await allowed.invoke({ action: 'ping' })
  assert.deepEqual(result, { platform: 'alpha', action: 'ping', result: { ok: true } })
})

test('DocsService preserves duck-typed adapter error codes and hints', async () => {
  const ctx = fakeContext()
  const service = new DocsService(ctx, {})
  service.registerAdapter(makeAdapter('alpha', {
    async read() {
      const error = new Error('token expired')
      error.code = 'AUTH_REQUIRED'
      error.platform = 'alpha'
      error.hint = 'Call docs_connect.'
      throw error
    },
  }), ctx)
  await assert.rejects(() => service.read({ document: 'alpha:doc-1' }), (error) => {
    assert.equal(error.code, DOCS_ERROR.AUTH_REQUIRED)
    assert.equal(error.platform, 'alpha')
    assert.equal(error.hint, 'Call docs_connect.')
    return true
  })
  service.registerAdapter(makeAdapter('beta', {
    async read() {
      const error = new Error('disk says no')
      error.code = 'ENOENT'
      throw error
    },
  }), ctx)
  await assert.rejects(() => service.read({ document: 'beta:doc-1' }), (error) => {
    assert.equal(error.code, DOCS_ERROR.UPSTREAM)
    return true
  })
})
