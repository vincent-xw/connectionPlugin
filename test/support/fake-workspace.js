/**
 * Fake Google Sheets / Slides / Drive-metadata endpoints for the adapter tests.
 *
 * The handlers are pure functions over a small in-memory state so the test
 * server stays readable: `createWorkspaceState` builds fixtures and
 * `handleWorkspaceRequest` answers one request, returning `undefined` when the
 * path is not its business.
 */

/** Convert a 1-based column number into letters (1 -> A, 27 -> AA). */
export function columnLetter(index) {
  let value = Math.max(1, index)
  let output = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    output = String.fromCharCode(65 + remainder) + output
    value = Math.floor((value - 1) / 26)
  }
  return output
}

/** Convert column letters into a 1-based column number (A -> 1, AD -> 30). */
export function columnIndex(letters) {
  let value = 0
  for (const character of String(letters).toUpperCase()) {
    value = value * 26 + (character.charCodeAt(0) - 64)
  }
  return value
}

/**
 * Parse an A1 range such as `'My sheet'!A1:C3`, `Sheet1!A1`, or `Sheet1`.
 * @param {string} range - A1 range.
 * @returns {{ title?: string, row: number, column: number, endRow?: number, endColumn?: number }}
 */
export function parseA1(range) {
  const raw = String(range ?? '')
  const bang = raw.lastIndexOf('!')
  let title
  let cells = raw
  if (bang !== -1) {
    title = raw.slice(0, bang).replace(/^'+|'+$/g, '').replace(/''/g, "'")
    cells = raw.slice(bang + 1)
  }
  const match = /^([A-Za-z]+)?(\d+)?(?::([A-Za-z]+)(\d+))?$/.exec(cells.trim())
  if (match === null) return { ...(title === undefined ? {} : { title }), row: 1, column: 1 }
  return {
    ...(title === undefined ? {} : { title }),
    row: match[2] === undefined ? 1 : Number(match[2]),
    column: match[1] === undefined ? 1 : columnIndex(match[1]),
    ...(match[3] === undefined ? {} : { endColumn: columnIndex(match[3]) }),
    ...(match[4] === undefined ? {} : { endRow: Number(match[4]) }),
  }
}

/** Build the initial state from test fixtures. */
export function createWorkspaceState({ spreadsheets = [], presentations = [], registerFile } = {}) {
  const sheets = new Map()
  for (const fixture of spreadsheets) {
    const tabs = (fixture.sheets ?? [{ title: 'Sheet1', values: [] }]).map((sheet, index) => ({
      properties: {
        sheetId: index,
        title: sheet.title,
        index,
        gridProperties: {
          rowCount: (sheet.values?.length ?? 0) + 20,
          columnCount: Math.max(26, ...(sheet.values ?? []).map((row) => row.length)),
        },
      },
      values: (sheet.values ?? []).map((row) => row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)))),
    }))
    sheets.set(fixture.id, {
      spreadsheetId: fixture.id,
      properties: { title: fixture.title ?? fixture.id },
      sheets: tabs,
    })
  }
  const decks = new Map()
  for (const fixture of presentations) {
    decks.set(fixture.id, {
      presentationId: fixture.id,
      title: fixture.title ?? fixture.id,
      revisionId: 'rev-1',
      slides: (fixture.slides ?? []).map((slide, index) => ({
        objectId: slide.objectId ?? `slide-${index}`,
        pageElements: (slide.texts ?? []).map((text, elementIndex) => ({
          objectId: `element-${index}-${elementIndex}`,
          shape: {
            text: { textElements: [{ textRun: { content: text } }] },
            ...(slide.placeholder === undefined ? {} : { placeholder: { type: slide.placeholder } }),
          },
        })),
      })),
    })
  }
  return { sheets, decks, registerFile, created: 0, applied: [] }
}

/** Sheet structure without cell values, as `spreadsheets.get` returns it. */
function structureOf(spreadsheet) {
  return {
    spreadsheetId: spreadsheet.spreadsheetId,
    properties: spreadsheet.properties,
    sheets: spreadsheet.sheets.map((sheet) => ({ properties: sheet.properties })),
  }
}

/** Find a sheet by title, defaulting to the first one. */
function findSheet(spreadsheet, title) {
  if (title === undefined) return spreadsheet.sheets[0]
  return spreadsheet.sheets.find((sheet) => sheet.properties.title === title)
}

/** Grow one sheet's value matrix so a write fits. */
function ensureCell(sheet, row, column) {
  while (sheet.values.length < row) sheet.values.push([])
  const target = sheet.values[row - 1]
  while (target.length < column) target.push('')
}

/** Write a matrix at (row, column) and return the updated A1 range. */
function writeMatrix(sheet, row, column, values) {
  values.forEach((valuesRow, rowOffset) => {
    valuesRow.forEach((cell, columnOffset) => {
      const targetRow = row + rowOffset
      const targetColumn = column + columnOffset
      ensureCell(sheet, targetRow, targetColumn)
      sheet.values[targetRow - 1][targetColumn - 1] = String(cell)
    })
  })
  const rows = values.length
  const columns = values.reduce((width, valuesRow) => Math.max(width, valuesRow.length), 0)
  const end = `${columnLetter(column)}${row}:${columnLetter(column + Math.max(0, columns - 1))}${row + Math.max(0, rows - 1)}`
  return { updatedRange: `'${sheet.properties.title}'!${end}`, updatedRows: rows, updatedColumns: columns, updatedCells: rows * columns }
}

/** Replace text across every shape of every slide. */
function replaceAllText(deck, request) {
  const { containsText, replaceText } = request
  const find = String(containsText?.text ?? '')
  if (find.length === 0) return 0
  const pattern = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), containsText?.matchCase === true ? 'g' : 'gi')
  let occurrences = 0
  for (const slide of deck.slides) {
    for (const element of slide.pageElements) {
      const runs = element.shape?.text?.textElements ?? []
      for (const run of runs) {
        const content = run.textRun?.content
        if (typeof content !== 'string') continue
        const matches = content.match(pattern)
        occurrences += matches === null ? 0 : matches.length
        run.textRun.content = content.replace(pattern, String(replaceText ?? ''))
      }
    }
  }
  return occurrences
}

/**
 * Answer one Sheets/Slides/Drive-metadata request.
 * @param {object} state - from {@link createWorkspaceState}.
 * @param {object} request - `{ method, path, url, bodyText }`.
 * @returns {{ status: number, payload: object } | undefined} response, or undefined when not handled.
 */
export function handleWorkspaceRequest(state, { method, path, url, bodyText }) {
  const metadata = /^\/drive\/v3\/files\/([^/:]+)$/.exec(path)
  if (metadata !== null && method === 'GET') {
    const id = decodeURIComponent(metadata[1])
    const spreadsheet = state.sheets.get(id)
    if (spreadsheet !== undefined) {
      return {
        status: 200,
        payload: {
          id,
          name: spreadsheet.properties.title,
          mimeType: 'application/vnd.google-apps.spreadsheet',
          modifiedTime: '2026-10-04T00:00:00.000Z',
        },
      }
    }
    const deck = state.decks.get(id)
    if (deck !== undefined) {
      return { status: 200, payload: { id, name: deck.title, mimeType: 'application/vnd.google-apps.presentation' } }
    }
    return { status: 404, payload: { error: { code: 404, message: 'File not found', status: 'NOT_FOUND' } } }
  }

  if (path === '/v4/spreadsheets' && method === 'POST') {
    const body = JSON.parse(bodyText || '{}')
    const id = `created-sheet-${state.created + 1}AbCdEfGhIjKl`
    state.created += 1
    const tabs = (Array.isArray(body.sheets) ? body.sheets : []).map((sheet, index) => ({
      properties: {
        sheetId: index,
        title: String(sheet?.properties?.title ?? `Sheet${index + 1}`),
        index,
        gridProperties: {
          rowCount: sheet?.properties?.gridProperties?.rowCount ?? 1000,
          columnCount: sheet?.properties?.gridProperties?.columnCount ?? 26,
        },
      },
      values: [],
    }))
    const spreadsheet = {
      spreadsheetId: id,
      properties: { title: String(body.properties?.title ?? 'Untitled') },
      sheets: tabs.length === 0 ? [{ properties: { sheetId: 0, title: 'Sheet1', index: 0 }, values: [] }] : tabs,
    }
    state.sheets.set(id, spreadsheet)
    state.registerFile?.(id, spreadsheet.properties.title, 'application/vnd.google-apps.spreadsheet')
    return { status: 200, payload: structureOf(spreadsheet) }
  }

  const batchUpdateMatch = /^\/v4\/spreadsheets\/([^/:]+)\/values:batchUpdate$/.exec(path)
  if (batchUpdateMatch !== null && method === 'POST') {
    const spreadsheet = state.sheets.get(decodeURIComponent(batchUpdateMatch[1]))
    if (spreadsheet === undefined) {
      return { status: 404, payload: { error: { code: 404, message: 'Requested entity was not found.' } } }
    }
    const body = JSON.parse(bodyText || '{}')
    const responses = []
    let totalUpdatedCells = 0
    for (const entry of Array.isArray(body.data) ? body.data : []) {
      const parsed = parseA1(entry.range)
      const sheet = findSheet(spreadsheet, parsed.title)
      if (sheet === undefined) {
        return { status: 400, payload: { error: { message: `no sheet ${parsed.title}` } } }
      }
      const written = writeMatrix(sheet, parsed.row, parsed.column, entry.values ?? [])
      totalUpdatedCells += written.updatedCells
      responses.push(written)
    }
    return { status: 200, payload: { spreadsheetId: spreadsheet.spreadsheetId, totalUpdatedCells, responses } }
  }

  const formatMatch = /^\/v4\/spreadsheets\/([^/:]+):batchUpdate$/.exec(path)
  if (formatMatch !== null && method === 'POST') {
    const spreadsheet = state.sheets.get(decodeURIComponent(formatMatch[1]))
    if (spreadsheet === undefined) {
      return { status: 404, payload: { error: { code: 404, message: 'Requested entity was not found.' } } }
    }
    const body = JSON.parse(bodyText || '{}')
    const requests = Array.isArray(body.requests) ? body.requests : []
    state.applied.push(...requests)
    return { status: 200, payload: { spreadsheetId: spreadsheet.spreadsheetId, replies: requests.map(() => ({})) } }
  }

  const spreadsheetMatch = /^\/v4\/spreadsheets\/([^/:]+)$/.exec(path)
  if (spreadsheetMatch !== null && method === 'GET') {
    const spreadsheet = state.sheets.get(decodeURIComponent(spreadsheetMatch[1]))
    if (spreadsheet === undefined) {
      return { status: 404, payload: { error: { code: 404, message: 'Requested entity was not found.' } } }
    }
    return { status: 200, payload: structureOf(spreadsheet) }
  }

  const batchGetMatch = /^\/v4\/spreadsheets\/([^/:]+)\/values:batchGet$/.exec(path)
  if (batchGetMatch !== null && method === 'GET') {
    const spreadsheet = state.sheets.get(decodeURIComponent(batchGetMatch[1]))
    if (spreadsheet === undefined) {
      return { status: 404, payload: { error: { code: 404, message: 'Requested entity was not found.' } } }
    }
    const ranges = url.searchParams.getAll('ranges')
    const valueRanges = ranges.map((range) => {
      const parsed = parseA1(range)
      const sheet = findSheet(spreadsheet, parsed.title)
      if (sheet === undefined) return { range, majorDimension: 'ROWS' }
      const values = sheet.values.map((row) => [...row])
      while (values.length > 0 && values[values.length - 1].every((cell) => cell === '')) values.pop()
      return { range, majorDimension: 'ROWS', values }
    })
    return { status: 200, payload: { spreadsheetId: spreadsheet.spreadsheetId, valueRanges } }
  }

  const appendMatch = /^\/v4\/spreadsheets\/([^/:]+)\/values\/(.+):append$/.exec(path)
  if (appendMatch !== null && method === 'POST') {
    const spreadsheet = state.sheets.get(decodeURIComponent(appendMatch[1]))
    if (spreadsheet === undefined) {
      return { status: 404, payload: { error: { code: 404, message: 'Requested entity was not found.' } } }
    }
    const parsed = parseA1(decodeURIComponent(appendMatch[2]))
    const sheet = findSheet(spreadsheet, parsed.title)
    if (sheet === undefined) {
      return { status: 400, payload: { error: { message: `no sheet ${parsed.title}` } } }
    }
    const body = JSON.parse(bodyText || '{}')
    const values = Array.isArray(body.values) ? body.values : []
    const startRow = sheet.values.length + 1
    const written = writeMatrix(sheet, startRow, 1, values)
    return {
      status: 200,
      payload: {
        spreadsheetId: spreadsheet.spreadsheetId,
        tableRange: `${sheet.properties.title}!A1`,
        updates: written,
      },
    }
  }

  const updateMatch = /^\/v4\/spreadsheets\/([^/:]+)\/values\/(.+)$/.exec(path)
  if (updateMatch !== null && method === 'PUT') {
    const spreadsheet = state.sheets.get(decodeURIComponent(updateMatch[1]))
    if (spreadsheet === undefined) {
      return { status: 404, payload: { error: { code: 404, message: 'Requested entity was not found.' } } }
    }
    const parsed = parseA1(decodeURIComponent(updateMatch[2]))
    const sheet = findSheet(spreadsheet, parsed.title)
    if (sheet === undefined) {
      return { status: 400, payload: { error: { message: `no sheet ${parsed.title}` } } }
    }
    const body = JSON.parse(bodyText || '{}')
    if (!Array.isArray(body.values) || body.values.length === 0) {
      return { status: 400, payload: { error: { message: 'values must be a non-empty array' } } }
    }
    const written = writeMatrix(sheet, parsed.row, parsed.column, body.values)
    return { status: 200, payload: { spreadsheetId: spreadsheet.spreadsheetId, ...written } }
  }

  const presentationMatch = /^\/v1\/presentations\/([^/:]+)$/.exec(path)
  if (presentationMatch !== null && method === 'GET') {
    const deck = state.decks.get(decodeURIComponent(presentationMatch[1]))
    if (deck === undefined) {
      return { status: 404, payload: { error: { code: 404, message: 'Requested entity was not found.' } } }
    }
    return { status: 200, payload: deck }
  }

  const deckUpdateMatch = /^\/v1\/presentations\/([^/:]+):batchUpdate$/.exec(path)
  if (deckUpdateMatch !== null && method === 'POST') {
    const deck = state.decks.get(decodeURIComponent(deckUpdateMatch[1]))
    if (deck === undefined) {
      return { status: 404, payload: { error: { code: 404, message: 'Requested entity was not found.' } } }
    }
    const body = JSON.parse(bodyText || '{}')
    const replies = []
    for (const request of body.requests ?? []) {
      if (request.replaceAllText !== undefined) {
        replies.push({ replaceAllText: { occurrencesChanged: replaceAllText(deck, request.replaceAllText) } })
        continue
      }
      if (request.insertText !== undefined) {
        const { objectId, insertionIndex, text } = request.insertText
        let target
        for (const slide of deck.slides) {
          target = slide.pageElements.find((element) => element.objectId === objectId)
          if (target !== undefined) break
        }
        if (target === undefined) {
          return { status: 400, payload: { error: { message: `no page element ${objectId}` } } }
        }
        const runs = target.shape?.text?.textElements ?? []
        const content = runs.map((run) => run.textRun?.content ?? '').join('')
        const index = Number.isInteger(insertionIndex) ? insertionIndex : content.length
        const next = `${content.slice(0, index)}${String(text)}${content.slice(index)}`
        target.shape.text.textElements = [{ textRun: { content: next } }]
        replies.push({ insertText: {} })
        continue
      }
      return { status: 400, payload: { error: { message: `unsupported slide request ${Object.keys(request)[0]}` } } }
    }
    deck.revisionId = `rev-${Number(deck.revisionId.slice(4)) + 1}`
    return { status: 200, payload: { presentationId: deck.presentationId, replies, writeControl: { requiredRevisionId: deck.revisionId } } }
  }

  return undefined
}
