/**
 * End-to-end checks for the whole stack: tools-facing DocsService → Google
 * adapter → fake Google endpoints.
 *
 * The adapter tests pin the API calls; these tests pin the model-facing result:
 * how a spreadsheet becomes Markdown, how a deck becomes tabs, and that a cell
 * write really lands in the grid.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startFakeGoogle } from './support/fake-google.js'
import { MemoryCredentials, fakeContext, testLogger } from './support/memory-credentials.js'
import { GoogleAuth } from '../lib/adapters/google/auth.js'
import { GoogleApi } from '../lib/adapters/google/client.js'
import { createGoogleAdapter } from '../lib/adapters/google/index.js'
import { DOCUMENTS_SCOPE, resolveGoogleConfig } from '../lib/adapters/google/config.js'
import { DocsService } from '../lib/core/service.js'
import { DOCS_ERROR } from '../lib/core/errors.js'

const CLIENT_ID = 'client-e2e'

const SHEET_ID = '1E2ESheetAbCdEfGhIjKlMnOp'
const DECK_ID = '1E2EDeckAbCdEfGhIjKlMnOp'
const PDF_ID = '1E2EPdfAbCdEfGhIjKlMnOp'

const SPREADSHEET = {
  id: SHEET_ID,
  title: '待办事项列表',
  sheets: [
    { title: 'Sheet1', values: [['任务', '状态'], ['写代码', '完成']] },
    { title: '归档', values: [['旧任务', '已归档']] },
  ],
}

const DECK = {
  id: DECK_ID,
  title: 'Demo Deck',
  slides: [
    { objectId: 'slide-1', placeholder: 'TITLE', texts: ['Hello deck\n'] },
    { objectId: 'slide-2', texts: ['Bullet one\nBullet two\n'] },
  ],
}

/** Build a service wired to the real adapter and authorize it against the fake. */
async function setup(t, fixtures = {}) {
  const google = await startFakeGoogle({ documentIdPrefix: '1E2EDoc', ...fixtures })
  t.after(() => google.close())
  const credentials = new MemoryCredentials()
  const ctx = fakeContext({ credentials })
  const config = resolveGoogleConfig({
    clientId: CLIENT_ID,
    clientSecret: 'secret-e2e',
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
  })
  const logger = testLogger()
  const auth = new GoogleAuth({ ctx, config, fetchImpl: globalThis.fetch, logger })
  t.after(() => auth.close())
  const api = new GoogleApi({ auth, config, fetchImpl: globalThis.fetch, logger })
  const adapter = createGoogleAdapter({ config, auth, api, logger })
  const service = new DocsService(ctx, { defaultPlatform: 'google-docs' })
  service.registerAdapter(adapter, ctx)

  const started = await auth.start({ account: 'default' })
  const url = new URL(started.url)
  google.addCode('e2e-code', { clientId: CLIENT_ID, challenge: url.searchParams.get('code_challenge') })
  const callback = new URL(url.searchParams.get('redirect_uri'))
  callback.searchParams.set('code', 'e2e-code')
  callback.searchParams.set('state', url.searchParams.get('state'))
  const response = await fetch(callback)
  assert.equal(response.status, 200, await response.text())
  return { google, service, adapter, auth }
}

test('e2e: a spreadsheet reads as Markdown tables, one tab per sheet', async (t) => {
  const { service } = await setup(t, { spreadsheets: [SPREADSHEET] })
  const result = await service.read({ document: SHEET_ID })

  assert.equal(result.platform, 'google-docs')
  assert.equal(result.documentId, SHEET_ID)
  assert.equal(result.title, '待办事项列表')
  assert.equal(result.tabs.length, 2)
  assert.deepEqual(result.tabs.map((tab) => tab.title), ['Sheet1', '归档'])
  assert.match(result.text, /## Tab: Sheet1 `0`/)
  assert.match(result.text, /\| 任务 \| 状态 \|/)
  assert.match(result.text, /\| 写代码 \| 完成 \|/)
  assert.match(result.text, /\| 旧任务 \| 已归档 \|/)
  assert.equal(result.truncated, false)
})

test('e2e: one sheet can be read alone, and a missing tab is rejected', async (t) => {
  const { service } = await setup(t, { spreadsheets: [SPREADSHEET] })
  const single = await service.read({ document: SHEET_ID, tab: '归档' })
  assert.equal(single.tabs.length, 2)
  assert.match(single.text, /旧任务/)
  assert.doesNotMatch(single.text, /写代码/)
  assert.doesNotMatch(single.text, /## Tab:/)

  await assert.rejects(
    () => service.read({ document: SHEET_ID, tab: 'missing' }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.INVALID_INPUT)
      assert.match(error.hint, /Sheet1 \(0\), 归档 \(1\)/)
      return true
    },
  )
})

test('e2e: a deck reads as one tab per slide with the title as a heading', async (t) => {
  const { service } = await setup(t, { presentations: [DECK] })
  const result = await service.read({ document: DECK_ID })
  assert.equal(result.title, 'Demo Deck')
  assert.equal(result.tabs.length, 2)
  assert.match(result.text, /# Hello deck/)
  assert.match(result.text, /Bullet one/)
  assert.match(result.text, /Bullet two/)
})

test('e2e: docs_sheet_update and docs_sheet_append land in the grid', async (t) => {
  const { google, service } = await setup(t, { spreadsheets: [SPREADSHEET] })

  const updated = await service.updateValues({
    document: SHEET_ID,
    range: 'Sheet1!B2',
    values: [['已完成']],
  })
  assert.equal(updated.updatedRows, 1)
  assert.equal(updated.updatedCells, 1)
  assert.match(updated.range, /Sheet1/)

  const appended = await service.appendValues({
    document: SHEET_ID,
    values: [['买牛奶', '待办']],
  })
  assert.equal(appended.updatedRows, 1)

  const grid = google.workspace.sheets.get(SHEET_ID).sheets[0].values
  assert.equal(grid[1][1], '已完成')
  assert.deepEqual(grid.at(-1), ['买牛奶', '待办'])

  const reread = await service.read({ document: SHEET_ID })
  assert.match(reread.text, /\| 写代码 \| 已完成 \|/)
  assert.match(reread.text, /\| 买牛奶 \| 待办 \|/)
})

test('e2e: created documents are readable through the same kind dispatch', async (t) => {
  const { service } = await setup(t)
  const created = await service.create({ title: 'E2E Doc', text: 'hello e2e' })
  assert.match(created.url, /document\/d\//)
  const read = await service.read({ document: created.documentId })
  assert.equal(read.title, 'E2E Doc')
  assert.match(read.text, /hello e2e/)
})

test('e2e: an unsupported file kind fails with a routed error', async (t) => {
  const { service } = await setup(t, {
    files: [{ id: PDF_ID, name: 'report.pdf', mimeType: 'application/pdf' }],
  })
  await assert.rejects(
    () => service.read({ document: PDF_ID }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.UNSUPPORTED)
      assert.match(error.message, /read is not supported for this file kind/)
      return true
    },
  )
  await assert.rejects(
    () => service.updateValues({ document: PDF_ID, range: 'A1', values: [['x']] }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.INVALID_INPUT)
      assert.match(error.hint, /resolves to a unsupported|resolves to an unsupported/)
      return true
    },
  )
})

test('e2e: slide text insertion is visible on the next read', async (t) => {
  const { service } = await setup(t, { presentations: [DECK] })
  const written = await service.insertSlideText({ document: DECK_ID, text: ' (from e2e)' })
  assert.equal(written.slide, 'slide-1')
  assert.equal(written.insertedChars, 11)

  const read = await service.read({ document: DECK_ID })
  assert.match(read.text, /Hello deck/)
  assert.match(read.text, /from e2e/)
})

test('e2e: a sheet that fits the read window carries no truncation note', async (t) => {
  const { service } = await setup(t, { spreadsheets: [SPREADSHEET] })
  const read = await service.read({ document: SHEET_ID })
  assert.doesNotMatch(read.text, /table truncated/)
})

test('e2e: a sheet that fills the read window is marked truncated', async (t) => {
  const rows = Array.from({ length: 250 }, (_, index) => [`row ${index + 1}`, String(index + 1)])
  const { service } = await setup(t, {
    spreadsheets: [{ id: SHEET_ID, title: 'Big', sheets: [{ title: 'Sheet1', values: rows }] }],
  })
  const read = await service.read({ document: SHEET_ID })
  assert.match(read.text, /table truncated to the first 200 rows × 30 columns/)
  assert.match(read.text, /\| row 200 \| 200 \|/)
  assert.doesNotMatch(read.text, /row 201/)
})

test('e2e: wide sheets are bounded by column count too', async (t) => {
  const wide = [Array.from({ length: 40 }, (_, index) => `c${index + 1}`)]
  const { service } = await setup(t, {
    spreadsheets: [{ id: SHEET_ID, title: 'Wide', sheets: [{ title: 'Sheet1', values: wide }] }],
  })
  const read = await service.read({ document: SHEET_ID })
  assert.match(read.text, /table truncated to the first 200 rows × 30 columns/)
})

test('e2e: a created workbook keeps its sheet titles and values', async (t) => {
  const { service } = await setup(t)
  const created = await service.create({
    kind: 'spreadsheet',
    title: 'Q4 任务计划（导入）',
    sheets: [
      { title: '进度总览', values: [['Q4 进度总览'], ['一句话进展', '已打通']] },
      { title: '任务清单', values: [['一级任务', '状态'], ['D01', '进行中']] },
      { title: '周报', values: [['周次', '日期'], ['第 42 周', '2026-10-13']] },
    ],
  })
  assert.deepEqual(created.tabs, ['进度总览', '任务清单', '周报'])
  assert.match(created.url, /spreadsheets\/d\//)

  const read = await service.read({ document: created.documentId })
  assert.equal(read.title, 'Q4 任务计划（导入）')
  assert.deepEqual(read.tabs.map((tab) => tab.title), ['进度总览', '任务清单', '周报'])
  assert.match(read.text, /\| 一句话进展 \| 已打通 \|/)
  assert.match(read.text, /\| D01 \| 进行中 \|/)
  assert.doesNotMatch(read.text, /table truncated/)
})
