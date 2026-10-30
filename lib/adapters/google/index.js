/**
 * Google Docs platform adapter.
 *
 * Implements the Connector's adapter contract over Google Docs API v1:
 * OAuth 2.0 (authorization code + PKCE, loopback), document conversion, and
 * the generic read/create/append/insert/replace operations. A raw
 * `batchUpdate` escape hatch is available through `docs_invoke` when enabled.
 * @module @local/docs-connector/adapters/google
 */
import { DOCS_ERROR, DocsError } from '../../core/errors.js'
import { renderTabText, resolveTab } from '../../core/document.js'
import { GOOGLE_DEFAULT_CONFIG, normalizeAccount, resolveGoogleConfig } from './config.js'
import { GoogleAuth } from './auth.js'
import { GoogleApi } from './client.js'
import { GOOGLE_MIME, googleDocUrl, googleFileUrl, parseGoogleRef, toSnapshot } from './convert.js'
import { SHEETS_MAX_COLUMNS, SHEETS_MAX_ROWS, quoteSheetTitle, toSheetsSnapshot } from './convert-sheets.js'
import { toSlidesSnapshot } from './convert-slides.js'
import { createSystemBrowserOpener } from './open-browser.js'
import { createProxiedFetch } from './proxy-fetch.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'docs-connector-google'
/** The registry must be mounted before this adapter can register itself. */
export const inject = ['docs']

/** Read a logger without failing when the logger service is absent. */
function safeLogger(ctx) {
  try {
    return ctx.logger?.('docs-connector') ?? undefined
  } catch {
    return undefined
  }
}

/** The native tab id for write requests; the legacy implicit body has none. */
function tabIdOf(tab) {
  return tab.id === 'body' ? undefined : tab.id
}

/** Google Docs native MIME type; the default listing kind. */
const DOCUMENT_MIME_TYPE = 'application/vnd.google-apps.document'
/**
 * Native Google kinds `docs_list` can ask for. `all` covers the three kinds the
 * connector understands; folders, forms, and uploads are never listed because
 * none of the read/write tools can operate on them.
 */
export const GOOGLE_LIST_KINDS = Object.freeze({
  document: ['application/vnd.google-apps.document'],
  spreadsheet: ['application/vnd.google-apps.spreadsheet'],
  presentation: ['application/vnd.google-apps.presentation'],
  all: [
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.presentation',
  ],
})
/** Page sizes accepted by `files.list`. */
const MIN_PAGE_SIZE = 1
const MAX_PAGE_SIZE = 100
const DEFAULT_PAGE_SIZE = 20

/**
 * Build the Drive `q` expression for `docs_list`.
 *
 * Trashed files are excluded and only native Google Docs documents are
 * returned: an uploaded `.docx` has different edit semantics, so it is not a
 * valid target for the write tools. The name filter escapes the single-quoted
 * literal Drive's query language expects.
 * @param {string|undefined} query - substring matched against the file name.
 * @returns {string} Drive query.
 */
export function driveDocumentQuery(query, type = 'document') {
  const mimeTypes = GOOGLE_LIST_KINDS[type]
  if (mimeTypes === undefined) {
    throw new DocsError(`unknown list type "${type}"`, {
      code: DOCS_ERROR.INVALID_INPUT,
      platform: 'google-docs',
      hint: `Use one of: ${Object.keys(GOOGLE_LIST_KINDS).join(', ')}.`,
    })
  }
  const mimeClause = mimeTypes.length === 1
    ? `mimeType = '${mimeTypes[0]}'`
    : `(${mimeTypes.map((mime) => `mimeType = '${mime}'`).join(' or ')})`
  const clauses = [mimeClause, 'trashed = false']
  if (typeof query === 'string' && query.trim().length > 0) {
    const literal = query.trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    clauses.push(`name contains '${literal}'`)
  }
  return clauses.join(' and ')
}

/**
 * Map a Drive MIME type onto the kind the adapter can handle.
 * @param {unknown} mimeType - `files.get` MIME type.
 * @returns {'document'|'spreadsheet'|'presentation'|'unsupported'}
 */
function kindFromMime(mimeType) {
  if (mimeType === GOOGLE_MIME.spreadsheet) return 'spreadsheet'
  if (mimeType === GOOGLE_MIME.presentation) return 'presentation'
  if (mimeType === GOOGLE_MIME.document) return 'document'
  return 'unsupported'
}

/**
 * Spreadsheet column letters for a 1-based count (1 -> A, 30 -> AD).
 * @param {number} count - column count.
 * @returns {string}
 */
function columnLetters(count) {
  let value = Math.max(1, Math.trunc(count))
  let output = ''
  while (value > 0) {
    const remainder = (value - 1) % 26
    output = String.fromCharCode(65 + remainder) + output
    value = Math.floor((value - 1) / 26)
  }
  return output
}

/**
 * Normalize a model-supplied value matrix.
 * A single row (`["a", "b"]`) is accepted and wrapped; every cell becomes a
 * string, number, or boolean because the Sheets API rejects objects.
 * @param {unknown} values - candidate matrix.
 * @returns {Array<Array<string|number|boolean>>}
 */
function normalizeMatrix(values) {
  if (!Array.isArray(values)) return []
  const rows = Array.isArray(values[0]) ? values : [values]
  return rows.map((row) => (Array.isArray(row) ? row : [row]).map((cell) => {
    if (typeof cell === 'string' || typeof cell === 'boolean') return cell
    if (typeof cell === 'number' && Number.isFinite(cell)) return cell
    if (cell === null || cell === undefined) return ''
    return String(cell)
  }))
}

/** First text-bearing shape of a slide, used as the insert target. */
function firstTextShape(slide) {
  const elements = Array.isArray(slide?.pageElements) ? slide.pageElements : []
  return elements.find((element) => typeof element?.objectId === 'string' && element.shape?.text !== undefined)
}

/** Total text length of a shape, which is the Slides API insertion index. */
function shapeTextLength(text) {
  const elements = Array.isArray(text?.textElements) ? text.textElements : []
  return elements.reduce((total, element) => total + (typeof element?.textRun?.content === 'string' ? element.textRun.content.length : 0), 0)
}

/**
 * Normalize the `sheets` argument of a spreadsheet create.
 *
 * Each entry becomes one tab: `{ title, values }`. Values are written with
 * `RAW` so numbers stay numbers and text stays text (no date auto-parsing),
 * which is what "copy this workbook" needs.
 * @param {unknown} sheets - candidate list.
 * @returns {Array<{ title: string, values: Array<Array<string|number|boolean>> }>}
 */
function normalizeSheets(sheets) {
  if (!Array.isArray(sheets)) return []
  const seen = new Set()
  return sheets.map((sheet, index) => {
    const title = typeof sheet?.title === 'string' ? sheet.title.trim() : ''
    if (title.length === 0) {
      throw new DocsError(`sheets[${index}].title must not be empty`, {
        code: DOCS_ERROR.INVALID_INPUT,
        platform: 'google-docs',
      })
    }
    if (seen.has(title)) {
      throw new DocsError(`duplicate sheet title "${title}"`, {
        code: DOCS_ERROR.INVALID_INPUT,
        platform: 'google-docs',
        hint: 'Sheet titles must be unique inside one spreadsheet.',
      })
    }
    seen.add(title)
    return { title, values: normalizeMatrix(sheet?.values) }
  })
}

/** Bound a page size the adapter receives directly. */
function clampPageSize(value) {
  const size = Number(value)
  if (!Number.isFinite(size) || size < MIN_PAGE_SIZE) return DEFAULT_PAGE_SIZE
  return Math.min(Math.trunc(size), MAX_PAGE_SIZE)
}

/**
 * Build the adapter object (exported for tests and for reuse by a composition
 * that wants a different row layout).
 * @param {object} options
 * @param {ReturnType<import('./config.js').resolveGoogleConfig>} options.config - resolved config.
 * @param {GoogleAuth} options.auth - token provider.
 * @param {GoogleApi} options.api - REST client.
 * @param {object} [options.logger] - optional logger.
 * @returns {object} adapter contract implementation.
 */
/** How long an id→kind lookup is trusted before asking Drive again. */
const KIND_CACHE_TTL_MS = 5 * 60_000

export function createGoogleAdapter({ config, auth, api, logger }) {
  const accountOf = (value) => normalizeAccount(value ?? config.account)

  /** @type {Map<string, { kind: string, mimeType?: string, title?: string, at: number }>} */
  const kindCache = new Map()

  /**
   * Resolve a document id to the kind the adapter must dispatch on.
   *
   * A bare id carries no type, so kind comes from Drive metadata. Two failures
   * degrade instead of breaking: a grant that predates the metadata scope keeps
   * working for Google Docs (the pre-existing behaviour), and a metadata 404 is
   * reported by the API call that follows rather than here.
   * @param {{ documentId: string }} ref - parsed reference.
   * @param {string} account - account label.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<{ kind: string, mimeType?: string, title?: string, assumed?: boolean }>}
   */
  async function resolveKind(ref, account, signal) {
    const cached = kindCache.get(ref.documentId)
    if (cached !== undefined && Date.now() - cached.at < KIND_CACHE_TTL_MS) return cached
    try {
      const file = await api.getFileMetadata(ref.documentId, { account, signal })
      const entry = {
        kind: kindFromMime(file?.mimeType),
        mimeType: typeof file?.mimeType === 'string' ? file.mimeType : undefined,
        title: typeof file?.name === 'string' ? file.name : undefined,
        at: Date.now(),
      }
      kindCache.set(ref.documentId, entry)
      return entry
    } catch (error) {
      const recoverable = error instanceof DocsError
        && (error.code === DOCS_ERROR.NOT_CONFIGURED || error.code === DOCS_ERROR.FORBIDDEN)
      if (!recoverable) throw error
      logger?.warn?.('google-docs: file metadata is unavailable; assuming a Docs document')
      return { kind: 'document', assumed: true, at: Date.now() }
    }
  }

  /** Throw a kind-specific unsupported error with a concrete next step. */
  function unsupportedKind(kind, mimeType, operation) {
    return new DocsError(`${operation} is not supported for this file kind${mimeType === undefined ? '' : ` (${mimeType})`}`, {
      code: DOCS_ERROR.UNSUPPORTED,
      platform: 'google-docs',
      hint: kind === 'unsupported'
        ? 'Only Google Docs, Google Sheets, and Google Slides are supported; uploaded Office files and PDFs are not.'
        : `This id resolves to a ${kind}; use the tool that matches it.`,
    })
  }

  /** Read a spreadsheet: structure first, then the bounded cell ranges. */
  async function readSpreadsheet(ref, account, signal, options = {}) {
    const spreadsheet = await api.getSpreadsheet(ref.documentId, { account, signal })
    const titles = (Array.isArray(spreadsheet?.sheets) ? spreadsheet.sheets : [])
      .map((sheet) => sheet?.properties?.title)
      .filter((title) => typeof title === 'string' && title.length > 0)
    const lastColumn = columnLetters(SHEETS_MAX_COLUMNS)
    const ranges = titles.map((title) => `${quoteSheetTitle(title)}!A1:${lastColumn}${SHEETS_MAX_ROWS}`)
    const values = ranges.length === 0
      ? []
      : (await api.getValues(ref.documentId, ranges, { account, signal }))?.valueRanges ?? []
    return toSheetsSnapshot(spreadsheet, values, { raw: options.raw === true })
  }

  /** Read a presentation; the Slides API response already carries all text. */
  async function readPresentation(ref, account, signal, options = {}) {
    const presentation = await api.getPresentation(ref.documentId, { account, signal })
    return toSlidesSnapshot(presentation, { raw: options.raw === true })
  }

  /** Read and convert a document, returning both native and portable views. */
  async function fetchSnapshot(ref, account, signal, options = {}) {
    const document = await api.getDocument(ref.documentId, { account, signal })
    return { document, snapshot: toSnapshot(document, { raw: options.raw === true }) }
  }

  /** Revision to pin on a write: the caller's expected revision wins. */
  function pinnedRevision(expectedRevision, snapshot) {
    if (typeof expectedRevision === 'string' && expectedRevision.trim().length > 0) return expectedRevision.trim()
    if (config.guardWrites) return snapshot.revision
    return undefined
  }

  /** Build `writeControl` for a pinned revision. */
  function writeControl(revision) {
    return revision === undefined ? undefined : { requiredRevisionId: revision }
  }

  /** Revision reported by a batchUpdate reply, when Google returns it. */
  function revisionFromReply(reply) {
    const value = reply?.writeControl?.requiredRevisionId
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }

  /**
   * The revision a successful write produced. Google may omit `writeControl`
   * from a batchUpdate reply; reporting the pre-write revision would make the
   * next guarded write fail, so re-read the document once when configured.
   */
  async function revisionAfterWrite(reply, ref, account, signal) {
    const reported = revisionFromReply(reply)
    if (reported !== undefined) return reported
    if (!config.refreshRevisionAfterWrite) return undefined
    try {
      const document = await api.getDocument(ref.documentId, { account, signal })
      return typeof document.revisionId === 'string' && document.revisionId.length > 0 ? document.revisionId : undefined
    } catch (error) {
      logger?.warn?.('google-docs: could not refresh the revision after a write:', error instanceof Error ? error.message : error)
      return undefined
    }
  }

  /**
   * Create a spreadsheet, optionally with named sheets and their values.
   *
   * Two calls: `spreadsheets.create` with the tab titles (so the structure is
   * identical to the source, empty tabs included), then one
   * `values:batchUpdate` for every non-empty tab.
   */
  async function createSpreadsheet(request, account, signal) {
    const title = typeof request.title === 'string' ? request.title.trim() : ''
    if (title.length === 0) {
      throw new DocsError('title must not be empty', { code: DOCS_ERROR.INVALID_INPUT, platform: 'google-docs' })
    }
    const sheets = normalizeSheets(request.sheets)
    const created = await api.createSpreadsheet({
      properties: { title },
      ...(sheets.length === 0 ? {} : {
        sheets: sheets.map((sheet) => ({
          properties: {
            title: sheet.title,
            gridProperties: {
              rowCount: Math.max(1, sheet.values.length),
              columnCount: Math.max(1, sheet.values.reduce((width, row) => Math.max(width, row.length), 0)),
            },
          },
        })),
      }),
    }, { account, signal })
    const documentId = typeof created?.spreadsheetId === 'string' ? created.spreadsheetId : ''
    if (documentId.length === 0) {
      throw new DocsError('Google Sheets created no spreadsheet id', {
        code: DOCS_ERROR.UPSTREAM,
        platform: 'google-docs',
      })
    }
    const data = sheets
      .filter((sheet) => sheet.values.length > 0)
      .map((sheet) => ({ range: `${quoteSheetTitle(sheet.title)}!A1`, values: sheet.values }))
    if (data.length > 0) await api.batchUpdateValues(documentId, data, { account, signal })
    const tabs = (Array.isArray(created?.sheets) ? created.sheets : [])
      .map((sheet) => sheet?.properties?.title)
      .filter((name) => typeof name === 'string' && name.length > 0)
    return {
      documentId,
      url: `https://docs.google.com/spreadsheets/d/${documentId}/edit`,
      title,
      ...(tabs.length === 0 ? {} : { tabs }),
    }
  }

  /** Create a new tab, tolerating API surfaces that do not support tabs. */
  async function createTab(documentId, tabTitle, account, signal) {
    try {
      const reply = await api.batchUpdate(documentId, [{
        addDocumentTab: { tabProperties: { title: tabTitle } },
      }], { account, signal })
      const tabId = reply?.replies?.[0]?.addDocumentTab?.tabProperties?.tabId
      return typeof tabId === 'string' && tabId.length > 0 ? tabId : undefined
    } catch (error) {
      if (error instanceof DocsError && error.code === DOCS_ERROR.INVALID_INPUT) {
        logger?.warn?.(`google-docs: addDocumentTab is unavailable (${error.message}); writing to the default tab instead`)
        return undefined
      }
      throw error
    }
  }

  /**
   * Enumerate the caller's Google Docs documents through Drive.
   *
   * Listing needs the Drive metadata scope; a token authorized before that
   * scope was added fails with FORBIDDEN and a reconnect hint.
   */
  async function listDocuments(request = {}, signal) {
    const account = accountOf(request.account)
    const pageToken = typeof request.pageToken === 'string' && request.pageToken.length > 0 ? request.pageToken : undefined
    const reply = await api.listFiles({
      query: driveDocumentQuery(request.query, request.type),
      pageSize: clampPageSize(request.limit),
      pageToken,
      account,
      signal,
    })
    const files = Array.isArray(reply?.files) ? reply.files : []
    const documents = files
      .filter((file) => file !== null && typeof file === 'object' && typeof file.id === 'string' && file.id.length > 0)
      .map((file) => ({
        documentId: file.id,
        title: typeof file.name === 'string' && file.name.length > 0 ? file.name : file.id,
        url: typeof file.webViewLink === 'string' && file.webViewLink.length > 0 ? file.webViewLink : googleDocUrl(file.id),
        mimeType: typeof file.mimeType === 'string' ? file.mimeType : DOCUMENT_MIME_TYPE,
        ...(typeof file.modifiedTime === 'string' && file.modifiedTime.length > 0 ? { modifiedTime: file.modifiedTime } : {}),
      }))
    const nextPageToken = typeof reply?.nextPageToken === 'string' && reply.nextPageToken.length > 0 ? reply.nextPageToken : undefined
    return {
      platform: 'google-docs',
      documents,
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
    }
  }

  /** Adapter contract. */
  return {
    id: 'google-docs',
    title: 'Google Docs',
    description: 'Read, list, create, and edit Google Docs documents with an OAuth 2.0 desktop client.',
    refExample: 'https://docs.google.com/document/d/<documentId>/edit',
    capabilities: {
      read: true,
      list: true,
      create: true,
      append: true,
      insert: true,
      replace: true,
      updateValues: true,
      appendValues: true,
      insertSlideText: true,
      formatSheet: true,
      custom: true,
      auth: true,
      tabs: true,
      revisions: true,
    },
    parseRef: parseGoogleRef,
    formatRef: (ref) => ref.url ?? googleDocUrl(ref.documentId),
    auth: {
      defaultAccount: config.account,
      status: (options) => auth.status(options),
      start: (options) => auth.start(options),
      disconnect: (options) => auth.disconnect(options),
    },

    async read(ref, options = {}, signal) {
      const account = accountOf(options.account)
      const resolved = await resolveKind(ref, account, signal)
      if (resolved.kind === 'spreadsheet') return readSpreadsheet(ref, account, signal, options)
      if (resolved.kind === 'presentation') return readPresentation(ref, account, signal, options)
      if (resolved.kind === 'unsupported') throw unsupportedKind(resolved.kind, resolved.mimeType, 'read')
      const snapshot = await fetchSnapshot(ref, account, signal, { raw: options.raw === true })
      return snapshot.snapshot
    },

    async list(request = {}, signal) {
      return listDocuments(request, signal)
    },

    async create(request, signal) {
      const kind = typeof request.kind === 'string' && request.kind.trim().length > 0 ? request.kind.trim() : 'document'
      if (kind !== 'document' && kind !== 'spreadsheet') {
        throw new DocsError(`creating a ${kind} is not supported`, {
          code: DOCS_ERROR.UNSUPPORTED,
          platform: 'google-docs',
          hint: 'Supported kinds: document (Google Docs) and spreadsheet (Google Sheets).',
        })
      }
      const title = typeof request.title === 'string' ? request.title.trim() : ''
      if (title.length === 0) {
        throw new DocsError('title must not be empty', { code: DOCS_ERROR.INVALID_INPUT, platform: 'google-docs' })
      }
      const account = accountOf(request.account)
      if (kind === 'spreadsheet') return createSpreadsheet(request, account, signal)
      const created = await api.createDocument(title, { account, signal })
      const documentId = created.documentId
      if (typeof documentId !== 'string' || documentId.length === 0) {
        throw new DocsError('Google Docs created no document id', {
          code: DOCS_ERROR.UPSTREAM,
          platform: 'google-docs',
        })
      }
      let tabId
      if (typeof request.tabTitle === 'string' && request.tabTitle.trim().length > 0) {
        tabId = await createTab(documentId, request.tabTitle.trim(), account, signal)
      }
      const text = typeof request.text === 'string' ? request.text : ''
      if (text.length === 0) {
        return { documentId, url: googleDocUrl(documentId), title, ...(tabId === undefined ? {} : { tab: tabId }) }
      }
      const reply = await api.batchUpdate(documentId, [{
        insertText: {
          endOfSegmentLocation: tabId === undefined ? {} : { tabId },
          text,
        },
      }], { account, signal })
      const revision = await revisionAfterWrite(reply, { documentId }, account, signal)
      return {
        documentId,
        url: googleDocUrl(documentId),
        title,
        ...(tabId === undefined ? {} : { tab: tabId }),
        ...(revision === undefined ? {} : { revision }),
      }
    },

    async append(ref, request, signal) {
      const account = accountOf(request.account)
      const text = typeof request.text === 'string' ? request.text : ''
      if (text.length === 0) {
        throw new DocsError('text must not be empty', { code: DOCS_ERROR.INVALID_INPUT, platform: 'google-docs' })
      }
      const { snapshot } = await fetchSnapshot(ref, account, signal)
      const tab = resolveTab(snapshot, request.tab)
      const existing = renderTabText(tab).trim()
      const prefix = request.leadingNewline !== false && existing.length > 0 && !text.startsWith('\n')
      const payloadText = prefix ? `\n${text}` : text
      const tabId = tabIdOf(tab)
      const revision = pinnedRevision(request.expectedRevision, snapshot)
      const reply = await api.batchUpdate(ref.documentId, [{
        insertText: {
          endOfSegmentLocation: tabId === undefined ? {} : { tabId },
          text: payloadText,
        },
      }], { account, writeControl: writeControl(revision), signal })
      const nextRevision = await revisionAfterWrite(reply, ref, account, signal)
      return {
        tab: tab.id,
        insertedChars: text.length,
        ...(nextRevision === undefined ? {} : { revision: nextRevision }),
      }
    },

    async insert(ref, request, signal) {
      const account = accountOf(request.account)
      const text = typeof request.text === 'string' ? request.text : ''
      if (text.length === 0) {
        throw new DocsError('text must not be empty', { code: DOCS_ERROR.INVALID_INPUT, platform: 'google-docs' })
      }
      const index = Number(request.index)
      if (!Number.isInteger(index)) {
        throw new DocsError('index must be an integer UTF-16 code-unit offset', {
          code: DOCS_ERROR.INVALID_INPUT,
          platform: 'google-docs',
        })
      }
      const { snapshot } = await fetchSnapshot(ref, account, signal)
      const tab = resolveTab(snapshot, request.tab)
      const low = Math.max(1, Number.isInteger(tab.startIndex) ? tab.startIndex : 1)
      const high = Number.isInteger(tab.endIndex) ? tab.endIndex : undefined
      if (index < low || (high !== undefined && index > high)) {
        throw new DocsError(`index ${index} is outside the writable range of tab "${tab.id}"`, {
          code: DOCS_ERROR.INVALID_INPUT,
          platform: 'google-docs',
          hint: high === undefined ? `Use an index of at least ${low}.` : `Use an index between ${low} and ${high}.`,
        })
      }
      const tabId = tabIdOf(tab)
      const revision = pinnedRevision(request.expectedRevision, snapshot)
      const reply = await api.batchUpdate(ref.documentId, [{
        insertText: {
          location: { index, ...(tabId === undefined ? {} : { tabId }) },
          text,
        },
      }], { account, writeControl: writeControl(revision), signal })
      const nextRevision = await revisionAfterWrite(reply, ref, account, signal)
      return {
        tab: tab.id,
        index,
        insertedChars: text.length,
        ...(nextRevision === undefined ? {} : { revision: nextRevision }),
      }
    },

    async replace(ref, request, signal) {
      const account = accountOf(request.account)
      const find = typeof request.find === 'string' ? request.find : ''
      const replacement = typeof request.replace === 'string' ? request.replace : ''
      if (find.length === 0) {
        throw new DocsError('find must not be empty', { code: DOCS_ERROR.INVALID_INPUT, platform: 'google-docs' })
      }
      const resolved = await resolveKind(ref, account, signal)
      if (resolved.kind === 'spreadsheet') {
        throw new DocsError('replaceAllText does not apply to a spreadsheet', {
          code: DOCS_ERROR.UNSUPPORTED,
          platform: 'google-docs',
          hint: 'Read the sheet with docs_read, then rewrite the cells with docs_sheet_update (A1 range + values).',
        })
      }
      if (resolved.kind === 'presentation') {
        // The Slides API replaces across the whole presentation; there is no
        // per-slide scoping, so a tab selector cannot be honoured here.
        const reply = await api.presentationBatchUpdate(ref.documentId, [{
          replaceAllText: {
            containsText: { text: find, matchCase: request.matchCase === true },
            replaceText: replacement,
          },
        }], { account, signal })
        const occurrences = reply?.replies?.[0]?.replaceAllText?.occurrencesChanged
        return {
          occurrencesChanged: Number.isInteger(occurrences) ? occurrences : 0,
          url: googleFileUrl('presentation', ref.documentId),
        }
      }
      if (resolved.kind === 'unsupported') throw unsupportedKind(resolved.kind, resolved.mimeType, 'replace')
      const { snapshot } = await fetchSnapshot(ref, account, signal)
      const tab = request.tab === undefined || request.tab === null || request.tab === '' ? undefined : resolveTab(snapshot, request.tab)
      const tabId = tab === undefined ? undefined : tabIdOf(tab)
      const revision = pinnedRevision(request.expectedRevision, snapshot)
      const reply = await api.batchUpdate(ref.documentId, [{
        replaceAllText: {
          containsText: { text: find, matchCase: request.matchCase === true },
          replaceText: replacement,
          ...(tabId === undefined ? {} : { tabsCriteria: { tabIds: [tabId] } }),
        },
      }], { account, writeControl: writeControl(revision), signal })
      const occurrences = reply?.replies?.[0]?.replaceAllText?.occurrencesChanged
      const nextRevision = await revisionAfterWrite(reply, ref, account, signal)
      return {
        ...(tab === undefined ? {} : { tab: tab.id }),
        occurrencesChanged: Number.isInteger(occurrences) ? occurrences : 0,
        ...(nextRevision === undefined ? {} : { revision: nextRevision }),
      }
    },

    /**
     * Overwrite an A1 range in a Google Sheet.
     * The range contains the sheet title, so a multi-sheet spreadsheet is
     * addressed unambiguously: `'Sheet 1'!A1:C3`.
     */
    async updateValues(ref, request, signal) {
      const account = accountOf(request.account)
      const range = typeof request.range === 'string' ? request.range.trim() : ''
      if (range.length === 0) {
        throw new DocsError('range must be A1 notation such as "Sheet1!A1"', {
          code: DOCS_ERROR.INVALID_INPUT,
          platform: 'google-docs',
          hint: 'Quote sheet titles that contain spaces: \'Sheet 1\'!A1.',
        })
      }
      const values = normalizeMatrix(request.values)
      if (values.length === 0) {
        throw new DocsError('values must be a non-empty array of rows', {
          code: DOCS_ERROR.INVALID_INPUT,
          platform: 'google-docs',
          hint: 'Pass values as [[\"a\", \"b\"], [\"c\", \"d\"]]; a single row may be passed as [\"a\", \"b\"].',
        })
      }
      const resolved = await resolveKind(ref, account, signal)
      if (resolved.kind !== 'spreadsheet') {
        throw new DocsError('cell values can only be written to a Google Sheet', {
          code: DOCS_ERROR.INVALID_INPUT,
          platform: 'google-docs',
          hint: resolved.kind === 'document'
            ? 'Use docs_append or docs_insert for a Docs document.'
            : `This id resolves to a ${resolved.kind}.`,
        })
      }
      const reply = await api.updateValues(ref.documentId, range, values, { account, signal })
      return {
        url: googleFileUrl('spreadsheet', ref.documentId),
        range: typeof reply?.updatedRange === 'string' ? reply.updatedRange : range,
        updatedRows: Number.isInteger(reply?.updatedRows) ? reply.updatedRows : values.length,
        ...(Number.isInteger(reply?.updatedColumns) ? { updatedColumns: reply.updatedColumns } : {}),
        ...(Number.isInteger(reply?.updatedCells) ? { updatedCells: reply.updatedCells } : {}),
      }
    },

    /**
     * Append rows after the last row of a sheet, growing the sheet when the API
     * is asked to. Without an explicit range the first sheet is used.
     */
    async appendValues(ref, request, signal) {
      const account = accountOf(request.account)
      const values = normalizeMatrix(request.values)
      if (values.length === 0) {
        throw new DocsError('values must be a non-empty array of rows', {
          code: DOCS_ERROR.INVALID_INPUT,
          platform: 'google-docs',
          hint: 'Pass the rows to append as [[\"a\", \"b\"]]; a single row may be passed as [\"a\", \"b\"].',
        })
      }
      const resolved = await resolveKind(ref, account, signal)
      if (resolved.kind !== 'spreadsheet') {
        throw new DocsError('rows can only be appended to a Google Sheet', {
          code: DOCS_ERROR.INVALID_INPUT,
          platform: 'google-docs',
          hint: `This id resolves to a ${resolved.kind}.`,
        })
      }
      let range = typeof request.range === 'string' ? request.range.trim() : ''
      if (range.length === 0) {
        const spreadsheet = await api.getSpreadsheet(ref.documentId, { account, signal })
        const title = spreadsheet?.sheets?.[0]?.properties?.title
        range = typeof title === 'string' && title.length > 0 ? quoteSheetTitle(title) : 'A1'
      }
      const reply = await api.appendValues(ref.documentId, range, values, { account, signal })
      const updates = reply?.updates ?? {}
      return {
        url: googleFileUrl('spreadsheet', ref.documentId),
        range: typeof updates.updatedRange === 'string' ? updates.updatedRange : range,
        updatedRows: Number.isInteger(updates.updatedRows) ? updates.updatedRows : values.length,
        ...(Number.isInteger(updates.updatedColumns) ? { updatedColumns: updates.updatedColumns } : {}),
        ...(Number.isInteger(updates.updatedCells) ? { updatedCells: updates.updatedCells } : {}),
      }
    },

    /**
     * Apply raw Sheets `batchUpdate` requests to one spreadsheet.
     *
     * Formatting has no small, stable vocabulary of its own: a cell format has
     * dozens of optional fields, and the same request type also covers merges,
     * column widths, frozen rows, and new sheets. Passing the documented
     * request objects through keeps the tool useful without inventing a
     * lossy partial model.
     */
    async formatSheet(ref, request, signal) {
      const account = accountOf(request.account)
      const requests = request.requests
      if (!Array.isArray(requests) || requests.length === 0) {
        throw new DocsError('requests must be a non-empty array of Sheets API Request objects', {
          code: DOCS_ERROR.INVALID_INPUT,
          platform: 'google-docs',
          hint: 'Example: [{ repeatCell: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } }].',
        })
      }
      const resolved = await resolveKind(ref, account, signal)
      if (resolved.kind !== 'spreadsheet') {
        throw new DocsError('formatting applies to a Google Sheet only', {
          code: DOCS_ERROR.INVALID_INPUT,
          platform: 'google-docs',
          hint: `This id resolves to a ${resolved.kind}.`,
        })
      }
      const reply = await api.batchUpdateSpreadsheet(ref.documentId, requests, { account, signal })
      return {
        url: googleFileUrl('spreadsheet', ref.documentId),
        replies: Array.isArray(reply?.replies) ? reply.replies : [],
      }
    },

    /**
     * Append text to an existing text shape of one slide.
     *
     * The Slides API cannot create shapes through this connector, so the target
     * slide must already have a text box: the first text-bearing shape is used
     * and the text goes at its end (a predictable "append").
     */
    async insertSlideText(ref, request, signal) {
      const account = accountOf(request.account)
      const text = typeof request.text === 'string' ? request.text : ''
      if (text.trim().length === 0) {
        throw new DocsError('text must not be empty', { code: DOCS_ERROR.INVALID_INPUT, platform: 'google-docs' })
      }
      const resolved = await resolveKind(ref, account, signal)
      if (resolved.kind !== 'presentation') {
        throw new DocsError('slide text can only be inserted into a Google Slides presentation', {
          code: DOCS_ERROR.INVALID_INPUT,
          platform: 'google-docs',
          hint: `This id resolves to a ${resolved.kind}.`,
        })
      }
      const presentation = await api.getPresentation(ref.documentId, { account, signal })
      const slides = Array.isArray(presentation?.slides) ? presentation.slides : []
      if (slides.length === 0) {
        throw new DocsError('the presentation has no slides', {
          code: DOCS_ERROR.NOT_FOUND,
          platform: 'google-docs',
        })
      }
      const selector = typeof request.slide === 'string' && request.slide.trim().length > 0 ? request.slide.trim() : undefined
      let slide = slides[0]
      if (selector !== undefined) {
        slide = slides.find((candidate) => candidate.objectId === selector)
        if (slide === undefined && /^\d+$/.test(selector)) slide = slides[Number(selector)]
        if (slide === undefined) {
          throw new DocsError(`no slide matches "${selector}"`, {
            code: DOCS_ERROR.INVALID_INPUT,
            platform: 'google-docs',
            hint: `Pass a slide id or a 0-based index. Available: ${slides.map((candidate, index) => `${index}=${candidate.objectId}`).join(', ')}.`,
          })
        }
      }
      const shape = firstTextShape(slide)
      if (shape === undefined) {
        throw new DocsError('the target slide has no text shape to write into', {
          code: DOCS_ERROR.UNSUPPORTED,
          platform: 'google-docs',
          hint: 'Add a text box to the slide in the Slides UI, or target a different slide with the slide parameter.',
        })
      }
      const insertionIndex = shapeTextLength(shape.shape.text)
      const reply = await api.presentationBatchUpdate(ref.documentId, [{
        insertText: { objectId: shape.objectId, insertionIndex, text },
      }], { account, signal })
      return {
        url: googleFileUrl('presentation', ref.documentId),
        slide: typeof slide.objectId === 'string' ? slide.objectId : selector,
        shape: shape.objectId,
        insertedChars: text.length,
        ...(typeof reply?.writeControl?.requiredRevisionId === 'string' ? { revision: reply.writeControl.requiredRevisionId } : {}),
      }
    },

    async invoke(ref, { action, payload, account: requestAccount }, signal) {
      if (!config.allowRawActions) {
        throw new DocsError('raw Google Docs actions are disabled', {
          code: DOCS_ERROR.UNSUPPORTED,
          platform: 'google-docs',
          hint: 'Set allowRawActions: true on the docs-connector-google row to enable docs_invoke.',
        })
      }
      const account = accountOf(requestAccount ?? payload?.account)
      if (action === 'getRaw') {
        if (ref === null) {
          throw new DocsError('getRaw needs a document reference', {
            code: DOCS_ERROR.INVALID_INPUT,
            platform: 'google-docs',
          })
        }
        return api.getDocument(ref.documentId, { account, signal })
      }
      if (action === 'batchUpdate') {
        if (ref === null) {
          throw new DocsError('batchUpdate needs a document reference', {
            code: DOCS_ERROR.INVALID_INPUT,
            platform: 'google-docs',
          })
        }
        if (!Array.isArray(payload?.requests) || payload.requests.length === 0) {
          throw new DocsError('payload.requests must be a non-empty array', {
            code: DOCS_ERROR.INVALID_INPUT,
            platform: 'google-docs',
            hint: 'Pass the raw Docs API Request objects in payload.requests.',
          })
        }
        const reply = await api.batchUpdate(ref.documentId, payload.requests, {
          account,
          writeControl: payload.writeControl,
          signal,
        })
        return reply
      }
      if (action === 'createDocument') {
        return api.createDocument(String(payload?.title ?? ''), { account, signal })
      }
      if (action === 'listDocuments') {
        return listDocuments({
          account,
          limit: payload?.limit,
          pageToken: payload?.pageToken,
          query: payload?.query,
          type: payload?.type,
        }, signal)
      }
      throw new DocsError(`unknown Google Docs action "${action}"`, {
        code: DOCS_ERROR.UNSUPPORTED,
        platform: 'google-docs',
        hint: 'Supported actions: getRaw, batchUpdate, createDocument, listDocuments.',
      })
    },

    close() {
      auth.close()
    },
  }
}

/**
 * Mount the Google Docs adapter.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 * @param {unknown} rawConfig - adapter row config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveGoogleConfig(rawConfig)
  const logger = safeLogger(ctx)
  const opener = config.autoOpenBrowser ? createSystemBrowserOpener({ logger }) : undefined
  const fetchImpl = createProxiedFetch({
    proxy: config.proxy,
    proxyFromEnv: config.proxyFromEnv,
    bypass: config.proxyBypass,
    logger,
  })
  const auth = new GoogleAuth({ ctx, config, fetchImpl, logger, opener })
  const api = new GoogleApi({ auth, config, fetchImpl, logger })
  const adapter = createGoogleAdapter({ config, auth, api, logger })
  const dispose = ctx.docs.registerAdapter(adapter, ctx)
  return () => {
    try {
      if (typeof dispose === 'function') dispose()
    } finally {
      auth.close()
    }
  }
}

/** Re-export the public config defaults for adapter authors and tests. */
export { GOOGLE_DEFAULT_CONFIG }
