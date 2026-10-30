/**
 * Composition smoke test: boot the three bundle rows the way `cordis.patch.yml`
 * does (core service → Google adapter → tools) and drive the tools.
 *
 * The other suites import `lib/**` directly, which cannot catch a wiring bug:
 * a row that fails to mount, a tool registered under the wrong name, or a
 * capability the adapter never declares. This test mounts the real rows on a
 * minimal cordis-like context and calls the tools exactly as the model would.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startFakeGoogle } from './support/fake-google.js'
import { MemoryCredentials, fakeContext, testLogger } from './support/memory-credentials.js'
import { apply as applyCore } from '../lib/core/index.js'
import { apply as applyGoogle } from '../lib/adapters/google/index.js'
import { apply as applyTools } from '../lib/tools/index.js'

const CLIENT_ID = 'client-boot'
const SHEET_ID = '1BootSheetAbCdEfGhIjKlMn'
const DECK_ID = '1BootDeckAbCdEfGhIjKlMnOp'

/** Mount the three rows and return the captured tools. */
function boot(google) {
  const credentials = new MemoryCredentials()
  const ctx = fakeContext({ credentials })
  const defs = new Map()
  const sections = []
  ctx.tools = {
    register(definition) {
      defs.set(definition.name, definition)
      return () => defs.delete(definition.name)
    },
    get(name) {
      return defs.get(name)
    },
  }
  ctx.systemPrompt = {
    section(section) {
      sections.push(section)
    },
  }

  applyCore(ctx, { defaultPlatform: 'google-docs', allowCustomActions: true })
  applyGoogle(ctx, {
    clientId: CLIENT_ID,
    clientSecret: 'secret-boot',
    apiBase: google.baseUrl,
    driveApiBase: google.baseUrl,
    sheetsApiBase: google.baseUrl,
    slidesApiBase: google.baseUrl,
    authEndpoint: `${google.baseUrl}/auth`,
    tokenEndpoint: `${google.baseUrl}/token`,
    revokeEndpoint: `${google.baseUrl}/revoke`,
    autoOpenBrowser: false,
    proxyFromEnv: false,
    timeoutMs: 5000,
    maxRetries: 1,
  })
  applyTools(ctx, { readOnly: false })
  return { ctx, defs, sections, credentials }
}

/** Run one authorization flow through the mounted adapter. */
async function authorize(google, ctx) {
  const adapter = ctx.docs.choose('google-docs')
  const started = await adapter.auth.start({ account: 'default' })
  const url = new URL(started.url)
  google.addCode('boot-code', { clientId: CLIENT_ID, challenge: url.searchParams.get('code_challenge') })
  const callback = new URL(url.searchParams.get('redirect_uri'))
  callback.searchParams.set('code', 'boot-code')
  callback.searchParams.set('state', url.searchParams.get('state'))
  const response = await fetch(callback)
  assert.equal(response.status, 200, await response.text())
}

const exec = () => ({ signal: new AbortController().signal })

test('plugin rows mount and expose every documented tool and capability', async (t) => {
  const google = await startFakeGoogle({
    spreadsheets: [{ id: SHEET_ID, title: '待办事项列表', sheets: [{ title: 'Sheet1', values: [['任务'], ['写代码']] }] }],
    presentations: [{ id: DECK_ID, title: 'Demo Deck', slides: [{ texts: ['Hello deck\n'] }] }],
  })
  t.after(() => google.close())
  const { ctx, defs, sections } = boot(google)

  assert.deepEqual([...defs.keys()].sort(), [
    'docs_append',
    'docs_connect',
    'docs_create',
    'docs_disconnect',
    'docs_insert',
    'docs_invoke',
    'docs_list',
    'docs_platforms',
    'docs_read',
    'docs_replace',
    'docs_sheet_append',
    'docs_sheet_format',
    'docs_sheet_update',
    'docs_slide_insert_text',
  ])
  assert.equal(sections.length, 1)
  assert.match(sections[0].text({ scope: undefined }), /docs_read detects the file kind/)

  const [adapter] = ctx.docs.adapters()
  assert.equal(adapter.id, 'google-docs')
  for (const capability of ['read', 'list', 'create', 'append', 'insert', 'replace', 'updateValues', 'appendValues', 'insertSlideText', 'formatSheet', 'custom', 'auth']) {
    assert.equal(adapter.capabilities[capability], true, capability)
  }

  const platforms = await defs.get('docs_platforms').execute({}, exec())
  const [rendered] = defs.get('docs_platforms').output.render({}, platforms)
  assert.match(rendered.text, /updateValues, appendValues, insertSlideText, formatSheet/)
  assert.match(rendered.text, /not authorized/)
})

test('mounted tools list, read, and write a spreadsheet and a deck', async (t) => {
  const google = await startFakeGoogle({
    spreadsheets: [{ id: SHEET_ID, title: '待办事项列表', sheets: [{ title: 'Sheet1', values: [['任务'], ['写代码']] }] }],
    presentations: [{ id: DECK_ID, title: 'Demo Deck', slides: [{ texts: ['Hello deck\n'] }] }],
  })
  t.after(() => google.close())
  const { ctx, defs } = boot(google)
  await authorize(google, ctx)

  const listed = await defs.get('docs_list').execute({ type: 'spreadsheet' }, exec())
  assert.deepEqual(listed.documents.map((doc) => doc.documentId), [SHEET_ID])
  assert.equal(listed.documents[0].title, '待办事项列表')
  const [listText] = defs.get('docs_list').output.render({}, listed)
  assert.match(listText.text, /待办事项列表/)

  const read = await defs.get('docs_read').execute({ document: SHEET_ID }, exec())
  assert.equal(read.tabs[0].title, 'Sheet1')
  assert.match(read.text, /\| 写代码 \|/)

  const appended = await defs.get('docs_sheet_append').execute({ document: SHEET_ID, values: [['买牛奶']] }, exec())
  assert.equal(appended.updatedRows, 1)
  const [appendText] = defs.get('docs_sheet_append').output.render({}, appended)
  assert.match(appendText.text, /sheet_append: ok/)
  assert.deepEqual(google.workspace.sheets.get(SHEET_ID).sheets[0].values.at(-1), ['买牛奶'])

  const updated = await defs.get('docs_sheet_update').execute({ document: SHEET_ID, range: 'Sheet1!A1', values: [['任务（已更新）']] }, exec())
  assert.equal(updated.updatedCells, 1)
  assert.equal(google.workspace.sheets.get(SHEET_ID).sheets[0].values[0][0], '任务（已更新）')

  const deck = await defs.get('docs_read').execute({ document: DECK_ID }, exec())
  assert.match(deck.text, /Hello deck/)

  const inserted = await defs.get('docs_slide_insert_text').execute({ document: DECK_ID, text: ' (boot)' }, exec())
  assert.equal(inserted.slide, 'slide-0')
  assert.equal(inserted.insertedChars, 7)
})

test('the mounted adapter still guards write access on read-only rows', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const credentials = new MemoryCredentials()
  const ctx = fakeContext({ credentials })
  const defs = new Map()
  ctx.tools = {
    register(definition) {
      defs.set(definition.name, definition)
      return () => defs.delete(definition.name)
    },
    get(name) {
      return defs.get(name)
    },
  }
  ctx.systemPrompt = { section() {} }
  applyCore(ctx, { defaultPlatform: 'google-docs' })
  applyGoogle(ctx, {
    clientId: CLIENT_ID,
    apiBase: google.baseUrl,
    driveApiBase: google.baseUrl,
    sheetsApiBase: google.baseUrl,
    slidesApiBase: google.baseUrl,
    authEndpoint: `${google.baseUrl}/auth`,
    tokenEndpoint: `${google.baseUrl}/token`,
    autoOpenBrowser: false,
    proxyFromEnv: false,
    timeoutMs: 5000,
  })
  applyTools(ctx, { readOnly: true })

  assert.deepEqual([...defs.keys()].sort(), ['docs_connect', 'docs_disconnect', 'docs_list', 'docs_platforms', 'docs_read'])
  assert.equal(defs.has('docs_sheet_append'), false)
  assert.equal(defs.has('docs_slide_insert_text'), false)
})

test('logging stays quiet on a healthy boot', async (t) => {
  const google = await startFakeGoogle()
  t.after(() => google.close())
  const logger = testLogger()
  const ctx = fakeContext({ credentials: new MemoryCredentials() })
  ctx.logger = () => logger
  applyCore(ctx, { defaultPlatform: 'google-docs' })
  applyGoogle(ctx, {
    clientId: CLIENT_ID,
    apiBase: google.baseUrl,
    proxyFromEnv: false,
    autoOpenBrowser: false,
    timeoutMs: 5000,
  })
  assert.equal(ctx.docs.adapters().length, 1)
  assert.equal(logger.messages.filter((message) => message.level === 'error').length, 0)
})
