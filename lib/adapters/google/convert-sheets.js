/**
 * Google Sheets conversion.
 *
 * The Connector's portable model is document-shaped (tabs of blocks), and a
 * spreadsheet maps onto it surprisingly well: each sheet becomes one tab and
 * its cells become a single `table` block. That keeps `docs_read`, tab
 * selection, and Markdown rendering unchanged for spreadsheets.
 *
 * Cell values arrive from `spreadsheets.values.batchGet`, which returns only
 * the used range. Two bounds are applied so one large sheet cannot exhaust the
 * model context: rows and columns past the bound are dropped and reported in a
 * trailing note block.
 * @module @local/docs-connector/adapters/google/convert-sheets
 */

/** Maximum rows rendered per sheet. */
export const SHEETS_MAX_ROWS = 200
/** Maximum columns rendered per sheet. */
export const SHEETS_MAX_COLUMNS = 30

/**
 * Quote a sheet title for A1 notation (`'My sheet'!A1`).
 * A single quote inside a title is escaped by doubling it.
 * @param {string} title - sheet title.
 * @returns {string} quoted title.
 */
export function quoteSheetTitle(title) {
  return `'${String(title ?? '').replace(/'/g, "''")}'`
}

/** Coerce one cell value into display text (`null`/`undefined` become empty). */
function cellText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return value.map(cellText).join(' ')
  return String(value)
}

/**
 * Bound a value matrix and report only truncation that actually happened.
 *
 * The read requests a fixed window (`A1:AD200`), so the API itself caps the
 * result. A note is emitted only when that window was filled: a sheet with 83
 * used rows and 1000 grid rows is complete, not truncated.
 * @param {unknown[][]} values - rows from the API.
 * @returns {{ rows: string[][], note?: string }}
 */
export function boundRows(values) {
  const source = Array.isArray(values) ? values : []
  const rows = source.slice(0, SHEETS_MAX_ROWS).map((row) => {
    const cells = Array.isArray(row) ? row : [row]
    return cells.slice(0, SHEETS_MAX_COLUMNS).map(cellText)
  })
  const hitRowBound = source.length >= SHEETS_MAX_ROWS
  const hitColumnBound = source.some((row) => Array.isArray(row) && row.length >= SHEETS_MAX_COLUMNS)
  if (!hitRowBound && !hitColumnBound) return { rows }
  return {
    rows,
    note: `[table truncated to the first ${SHEETS_MAX_ROWS} rows × ${SHEETS_MAX_COLUMNS} columns of this sheet]`,
  }
}

/**
 * Convert a `spreadsheets.get` response plus its value ranges into a snapshot.
 * @param {object} spreadsheet - Sheets API Spreadsheet (structure only).
 * @param {object[]} [valueRanges] - `valueRanges` from `values:batchGet`, aligned with `sheets`.
 * @param {object} [options]
 * @param {boolean} [options.raw] - attach the native payloads.
 * @returns {object} snapshot for {@link normalizeSnapshot}.
 */
export function toSheetsSnapshot(spreadsheet, valueRanges = [], options = {}) {
  const spreadsheetId = typeof spreadsheet?.spreadsheetId === 'string' ? spreadsheet.spreadsheetId : ''
  const title = typeof spreadsheet?.properties?.title === 'string' ? spreadsheet.properties.title : ''
  const sheets = Array.isArray(spreadsheet?.sheets) ? spreadsheet.sheets : []
  const ranges = Array.isArray(valueRanges) ? valueRanges : []
  const tabs = sheets.map((sheet, position) => {
    const properties = sheet?.properties ?? {}
    const sheetTitle = typeof properties.title === 'string' && properties.title.length > 0
      ? properties.title
      : `Sheet ${position + 1}`
    const range = ranges[position] ?? {}
    const bounded = boundRows(range.values)
    const blocks = bounded.rows.length === 0
      ? [{ type: 'paragraph', text: '(empty sheet)' }]
      : [{ type: 'table', rows: bounded.rows }]
    if (bounded.note !== undefined) blocks.push({ type: 'paragraph', text: bounded.note })
    return {
      id: properties.sheetId === undefined ? `sheet-${position}` : String(properties.sheetId),
      title: sheetTitle,
      index: Number.isInteger(properties.index) ? properties.index : position,
      depth: 0,
      blocks,
    }
  })
  return {
    platform: 'google-docs',
    documentId: spreadsheetId,
    title,
    url: spreadsheetId.length > 0 ? `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` : undefined,
    tabs,
    ...(options.raw === true ? { raw: { spreadsheet, valueRanges } } : {}),
  }
}
