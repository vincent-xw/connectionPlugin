import test from 'node:test'
import assert from 'node:assert/strict'
import { createGoogleAdapter } from '../lib/adapters/google/index.js'
import { resolveGoogleConfig } from '../lib/adapters/google/config.js'
import { DOCS_ERROR, DocsError } from '../lib/core/errors.js'

function makeAdapter(api) {
  const config = resolveGoogleConfig({ clientId: 'test-client', autoOpenBrowser: false })
  return createGoogleAdapter({ config, auth: {}, api })
}

test('create: a spreadsheet whose initial values fail is still returned with a warning', async () => {
  const api = {
    createSpreadsheet: async () => ({
      spreadsheetId: 'sheet-1',
      sheets: [{ properties: { title: 'Sheet1' } }],
    }),
    batchUpdateValues: async () => {
      throw new DocsError('tls reset', { code: DOCS_ERROR.WRITE_NOT_SENT })
    },
  }
  const adapter = makeAdapter(api)
  const result = await adapter.create({
    title: 'Q4',
    kind: 'spreadsheet',
    sheets: [{ title: 'Sheet1', values: [['a']] }],
  })
  assert.equal(result.documentId, 'sheet-1')
  assert.match(result.url, /spreadsheets\/d\/sheet-1/)
  assert.match(result.warning, /was created/)
  assert.match(result.warning, /do not create another spreadsheet/)
})

test('create: a document whose body insert fails is still returned with a warning', async () => {
  const api = {
    createDocument: async () => ({ documentId: 'doc-1' }),
    batchUpdate: async () => {
      throw new DocsError('tls reset', { code: DOCS_ERROR.WRITE_NOT_SENT })
    },
  }
  const adapter = makeAdapter(api)
  const result = await adapter.create({ title: 'Notes', text: 'hello' })
  assert.equal(result.documentId, 'doc-1')
  assert.match(result.url, /document\/d\/doc-1\/edit/)
  assert.match(result.warning, /was created/)
  assert.match(result.warning, /do not create another document/)
})
