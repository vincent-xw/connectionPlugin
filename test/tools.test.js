import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/tools/index.js'
import { DOCS_ERROR, DocsError } from '../lib/core/errors.js'

function capture(config, docs) {
  const defs = new Map()
  const sections = []
  const ctx = {
    docs,
    tools: {
      register(definition) {
        defs.set(definition.name, definition)
        return () => defs.delete(definition.name)
      },
      get(name) {
        return defs.get(name)
      },
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
      },
    },
  }
  apply(ctx, config)
  return { ctx, defs, sections }
}

function fakeDocs(overrides = {}) {
  const calls = []
  const service = {
    config: { defaultPlatform: 'fake', maxReadChars: 60000, allowCustomActions: true },
    async catalog() {
      return [{
        id: 'fake',
        title: 'Fake Platform',
        description: 'A test platform',
        refExample: 'fake:d1',
        default: true,
        capabilities: { read: true, create: true, append: true, insert: true, replace: true, custom: true, auth: true, tabs: true, revisions: true },
        auth: { supported: true, connected: true, account: 'default', expiresAt: '2030-01-01T00:00:00.000Z' },
      }]
    },
    async read(request) {
      calls.push(['read', request])
      return {
        platform: 'fake',
        documentId: 'd1',
        title: 'Doc One',
        revision: 'r-1',
        tabs: [{ id: 't.0', title: 'Tab 1', index: 0, depth: 0, chars: 5 }],
        text: 'hello',
        truncated: false,
      }
    },
    async create(request) {
      calls.push(['create', request])
      return { platform: 'fake', documentId: 'd2', url: 'fake://d2', revision: 'r-2', tab: 't.0' }
    },
    async append(request) {
      calls.push(['append', request])
      return { platform: 'fake', documentId: 'd1', revision: 'r-3', tab: 't.0', insertedChars: 5 }
    },
    async insert(request) {
      calls.push(['insert', request])
      return { platform: 'fake', documentId: 'd1', revision: 'r-4', tab: 't.0', index: 1, insertedChars: 3 }
    },
    async replace(request) {
      calls.push(['replace', request])
      return { platform: 'fake', documentId: 'd1', revision: 'r-5', occurrencesChanged: 2 }
    },
    async connect(request) {
      calls.push(['connect', request])
      return { platform: 'fake', account: request.account ?? 'default', connected: false, status: 'pending', url: 'https://example.test/authorize' }
    },
    async disconnect(request) {
      calls.push(['disconnect', request])
      return { platform: 'fake', account: 'default', connected: false, status: 'disconnected' }
    },
    async invoke(request) {
      calls.push(['invoke', request])
      return { platform: 'fake', action: request.action, result: { ok: true } }
    },
  }
  return { service: Object.assign(service, overrides), calls }
}

test('tools: registers read-only, write, and invoke tools', () => {
  const { defs } = capture({}, fakeDocs().service)
  assert.deepEqual([...defs.keys()].sort(), [
    'docs_append',
    'docs_connect',
    'docs_create',
    'docs_disconnect',
    'docs_insert',
    'docs_invoke',
    'docs_platforms',
    'docs_read',
    'docs_replace',
  ])
  const readOnly = capture({ readOnly: true }, fakeDocs().service)
  assert.deepEqual([...readOnly.defs.keys()].sort(), ['docs_connect', 'docs_disconnect', 'docs_platforms', 'docs_read'])
})

test('tools: schemas are valid JSON Schema with hoisted required arrays', () => {
  const { defs } = capture({}, fakeDocs().service)
  for (const definition of defs.values()) {
    assert.equal(definition.parameters.type, 'object', definition.name)
    assert.ok(!Array.isArray(definition.parameters.required) || definition.parameters.required.every((key) => typeof key === 'string'))
    const check = (node, path) => {
      assert.equal(typeof node, 'object')
      assert.notEqual(node.required, true, `${path}.required must not be a boolean`)
      if (node.properties !== undefined) {
        for (const [key, child] of Object.entries(node.properties)) {
          if (node.required !== undefined) assert.ok(Array.isArray(node.required), `${path}.required`)
          check(child, `${path}.properties.${key}`)
        }
      }
      if (node.items !== undefined) check(node.items, `${path}.items`)
      if (node.oneOf !== undefined) node.oneOf.forEach((child, index) => check(child, `${path}.oneOf[${index}]`))
    }
    check(definition.parameters, definition.name)
    check(definition.output.schema, `${definition.name}.output`)
    assert.equal(typeof definition.output.render, 'function')
  }
  assert.deepEqual(defs.get('docs_read').parameters.required, ['document'])
})

test('tools: docs_platforms renders capabilities and auth state', async () => {
  const { defs } = capture({}, fakeDocs().service)
  const definition = defs.get('docs_platforms')
  const value = await definition.execute({}, { signal: new AbortController().signal })
  assert.equal(value.platforms.length, 1)
  assert.equal(value.platforms[0].id, 'fake')
  assert.equal(value.platforms[0].auth.connected, true)
  const [content] = definition.output.render({}, value)
  assert.match(content.text, /Fake Platform/)
  assert.match(content.text, /authorized as default/)
})

test('tools: docs_read forwards options and renders the revision hint', async () => {
  const { service, calls } = fakeDocs()
  const { defs } = capture({}, service)
  const definition = defs.get('docs_read')
  const value = await definition.execute(
    { document: 'fake:d1', tab: 't.0', format: 'text', maxChars: 100, account: 'work' },
    { signal: new AbortController().signal },
  )
  assert.equal(calls[0][0], 'read')
  assert.equal(calls[0][1].document, 'fake:d1')
  assert.equal(calls[0][1].tab, 't.0')
  assert.equal(calls[0][1].format, 'text')
  assert.equal(calls[0][1].maxChars, 100)
  assert.equal(calls[0][1].account, 'work')
  const [content] = definition.output.render({}, value)
  assert.match(content.text, /--- document ---/)
  assert.match(content.text, /revision: r-1/)
  assert.match(content.text, /expectedRevision: r-1/)
  assert.match(content.text, /hello/)
})

test('tools: docs_connect renders a clickable pending authorization', async () => {
  const { service, calls } = fakeDocs()
  const { defs } = capture({}, service)
  const definition = defs.get('docs_connect')
  const value = await definition.execute(
    { platform: 'fake', waitSeconds: 0, account: 'work', clientId: 'public-client-id' },
    { signal: new AbortController().signal },
  )
  assert.equal(calls[0][0], 'connect')
  assert.equal(calls[0][1].account, 'work')
  assert.equal(calls[0][1].clientId, 'public-client-id')
  const [content] = definition.output.render({}, value)
  assert.match(content.text, /authorization pending/)
  assert.match(content.text, /https:\/\/example\.test\/authorize/)
  assert.match(content.text, /docs_platforms/)
})

test('tools: invalid arguments are rejected before the service call', async () => {
  const { service, calls } = fakeDocs()
  const { defs } = capture({}, service)
  await assert.rejects(
    () => defs.get('docs_read').execute({ platform: 'fake' }, { signal: new AbortController().signal }),
    /document is required/,
  )
  assert.equal(calls.length, 0)
})

test('tools: service errors keep their code and next step', async () => {
  const { service } = fakeDocs({
    async read() {
      throw new DocsError('not authorized', {
        code: DOCS_ERROR.AUTH_REQUIRED,
        hint: 'Call docs_connect.',
      })
    },
  })
  const { defs } = capture({}, service)
  await assert.rejects(
    () => defs.get('docs_read').execute({ document: 'fake:d1' }, { signal: new AbortController().signal }),
    (error) => {
      assert.match(error.message, /\[AUTH_REQUIRED\] not authorized/)
      assert.match(error.message, /Next: Call docs_connect/)
      assert.equal(error.code, DOCS_ERROR.AUTH_REQUIRED)
      return true
    },
  )
})

test('tools: write tools forward revision guards and render results', async () => {
  const { service, calls } = fakeDocs()
  const { defs } = capture({}, service)
  const append = defs.get('docs_append')
  const value = await append.execute(
    { document: 'fake:d1', tab: 't.1', text: 'more', expectedRevision: 'r-1', leadingNewline: false },
    { signal: new AbortController().signal },
  )
  assert.equal(calls[0][1].expectedRevision, 'r-1')
  assert.equal(calls[0][1].leadingNewline, false)
  const [content] = append.output.render({}, value)
  assert.match(content.text, /append: ok/)
  assert.match(content.text, /inserted chars: 5/)
  assert.match(content.text, /revision: r-3/)
})

test('tools: prompt guidance is registered only when docs_read is visible', () => {
  const { defs, sections, ctx } = capture({}, fakeDocs().service)
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'tool:docs')
  assert.match(sections[0].text({ scope: undefined }), /Read a document before editing/)
  defs.delete('docs_read')
  assert.equal(sections[0].text({ scope: undefined }), '')
  assert.equal(ctx.tools.get('docs_read'), undefined)
})
