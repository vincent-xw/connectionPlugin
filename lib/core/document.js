/**
 * The platform-neutral document model.
 *
 * Adapters translate their native format into {@link DocumentSnapshot}. A
 * snapshot is intentionally small: identity, revision, and a flat list of
 * tabs, where each tab carries either pre-rendered `text` or portable
 * {@link DocBlock}s. Everything model-facing (tab headers, markdown, the
 * truncation marker) is rendered here, so a new platform only has to produce
 * blocks — or plain text when that is all its API offers.
 * @module @local/docs-connector/core/document
 */
import { DOCS_ERROR, DocsError } from './errors.js'

/**
 * @typedef {object} DocRef
 * @property {string} platform - adapter id, e.g. `google-docs`.
 * @property {string} documentId - platform-native document id.
 * @property {string} [url] - canonical browser URL when the adapter has one.
 */

/**
 * @typedef {object} DocBlock
 * @property {'paragraph'|'heading'|'list'|'table'|'image'|'break'|'raw'} type
 * @property {string} [text] - block text (paragraph/heading/list/raw).
 * @property {number} [level] - heading level 1-6, or list nesting level (0-based).
 * @property {boolean} [ordered] - list ordering.
 * @property {string[][]} [rows] - table rows, each cell already flattened to text.
 * @property {string} [alt] - image alt text / placeholder label.
 * @property {'page'|'section'} [kind] - break kind.
 * @property {number} [startIndex] - native start index when the platform exposes one.
 * @property {number} [endIndex] - native end index when the platform exposes one.
 */

/**
 * @typedef {object} DocumentTab
 * @property {string} id - native tab id used by write operations.
 * @property {string} title - human title.
 * @property {number} [index] - platform tab order.
 * @property {number} [depth] - nesting depth (0 for top-level tabs).
 * @property {DocBlock[]} [blocks] - portable blocks.
 * @property {string} [text] - pre-rendered tab text; rendered from blocks when omitted.
 * @property {number} [startIndex] - first native index of the tab body.
 * @property {number} [endIndex] - last native index of the tab body.
 */

/**
 * @typedef {object} DocumentSnapshot
 * @property {string} platform
 * @property {string} documentId
 * @property {string} title
 * @property {string} [url]
 * @property {string} [revision] - opaque revision used for optimistic writes.
 * @property {DocumentTab[]} tabs
 * @property {object} [raw] - adapter-native payload when explicitly requested.
 */

/** @param {number} value - candidate heading level. @returns {number} 1-6. */
function headingLevel(value) {
  const level = Number.isFinite(value) ? Math.trunc(Number(value)) : 1
  return Math.min(6, Math.max(1, level))
}

/** Escape a table cell so a stray pipe cannot break the markdown table. */
function tableCell(text) {
  return String(text ?? '').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim()
}

/**
 * Render one portable block.
 * @param {DocBlock} block - block to render.
 * @param {'markdown'|'text'} format - output dialect.
 * @returns {string} rendered block, possibly an empty string for spacing.
 */
export function renderBlock(block, format = 'markdown') {
  const markdown = format !== 'text'
  switch (block.type) {
    case 'heading': {
      const level = headingLevel(block.level)
      const text = String(block.text ?? '').trim()
      return markdown ? `${'#'.repeat(level)} ${text}` : text
    }
    case 'list': {
      const indent = '  '.repeat(Math.max(0, Number(block.level) || 0))
      const marker = block.ordered === true ? '1.' : '-'
      return `${indent}${marker} ${String(block.text ?? '').trim()}`
    }
    case 'table': {
      const rows = Array.isArray(block.rows) ? block.rows : []
      if (rows.length === 0) return ''
      if (!markdown) return rows.map((row) => row.map(tableCell).join(' | ')).join('\n')
      const width = Math.max(...rows.map((row) => row.length))
      const cells = (row) => {
        const values = Array.from({ length: width }, (_, index) => tableCell(row[index]))
        return `| ${values.join(' | ')} |`
      }
      const [head, ...body] = rows
      return [cells(head), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map(cells)].join('\n')
    }
    case 'image':
      return `[image: ${String(block.alt ?? 'image').trim() || 'image'}]`
    case 'break':
      if (block.kind === 'section') return markdown ? '\n---\n' : '\n'
      return markdown ? '\n---\n' : '\n'
    case 'raw':
    case 'paragraph':
    default:
      return String(block.text ?? '')
  }
}

/**
 * Render a tab's blocks into text.
 * @param {DocumentTab} tab - tab with `blocks` and/or `text`.
 * @param {'markdown'|'text'} format - output dialect.
 * @returns {string}
 */
export function renderTabText(tab, format = 'markdown') {
  if (typeof tab.text === 'string') return tab.text
  const blocks = Array.isArray(tab.blocks) ? tab.blocks : []
  return blocks.map((block) => renderBlock(block, format)).join('\n')
}

/** @param {DocumentTab} tab - normalized tab. @returns {number} visible character count. */
export function tabCharCount(tab) {
  return typeof tab.text === 'string' ? tab.text.length : 0
}

/**
 * Truncate text with a model-readable marker.
 * @param {string} text - full text.
 * @param {number} maxChars - positive bound.
 * @returns {{ text: string, truncated: boolean }}
 */
export function truncateText(text, maxChars) {
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false }
  }
  const marker = `\n\n[truncated after ${maxChars} of ${text.length} characters; read one tab, or raise maxChars]`
  return { text: text.slice(0, maxChars) + marker, truncated: true }
}

/**
 * Normalize an adapter snapshot: validate identity, flatten blocks into text,
 * and compute tab-level metadata. Adapter-specific fields are dropped unless
 * `raw` was requested.
 * @param {DocumentSnapshot} snapshot - adapter-produced snapshot.
 * @param {object} [options]
 * @param {string} [options.platform] - platform asserted by the registry.
 * @param {number} [options.maxChars] - per-tab render bound applied later by the caller.
 * @returns {DocumentSnapshot} a normalized copy.
 */
export function normalizeSnapshot(snapshot, options = {}) {
  if (snapshot === null || typeof snapshot !== 'object') {
    throw new DocsError('adapter returned no document snapshot', {
      code: DOCS_ERROR.UPSTREAM,
      platform: options.platform,
      hint: 'This is an adapter bug; report it with the adapter id.',
    })
  }
  const platform = snapshot.platform ?? options.platform
  if (typeof platform !== 'string' || platform.length === 0) {
    throw new DocsError('document snapshot has no platform', {
      code: DOCS_ERROR.UPSTREAM,
      platform: options.platform,
    })
  }
  const documentId = snapshot.documentId
  if (typeof documentId !== 'string' || documentId.length === 0) {
    throw new DocsError('document snapshot has no document id', {
      code: DOCS_ERROR.UPSTREAM,
      platform,
    })
  }
  const tabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : []
  if (tabs.length === 0) {
    throw new DocsError('document snapshot has no tabs', {
      code: DOCS_ERROR.UPSTREAM,
      platform,
      hint: 'The adapter must return at least one tab, even for a single-body document.',
    })
  }
  const normalizedTabs = tabs.map((tab, position) => {
    if (tab === null || typeof tab !== 'object') {
      throw new DocsError(`document snapshot tab ${position} is not an object`, {
        code: DOCS_ERROR.UPSTREAM,
        platform,
      })
    }
    const id = typeof tab.id === 'string' && tab.id.length > 0 ? tab.id : `tab-${position}`
    const title = typeof tab.title === 'string' && tab.title.length > 0 ? tab.title : `Tab ${position + 1}`
    const blocks = Array.isArray(tab.blocks) ? tab.blocks : undefined
    const text = typeof tab.text === 'string' ? tab.text : blocks === undefined ? '' : undefined
    const normalized = {
      id,
      title,
      index: Number.isInteger(tab.index) ? tab.index : position,
      depth: Number.isInteger(tab.depth) ? tab.depth : 0,
      ...(blocks === undefined ? {} : { blocks }),
      ...(text === undefined ? {} : { text }),
    }
    if (Number.isInteger(tab.startIndex)) normalized.startIndex = tab.startIndex
    if (Number.isInteger(tab.endIndex)) normalized.endIndex = tab.endIndex
    return normalized
  })
  const revision = typeof snapshot.revision === 'string' && snapshot.revision.length > 0 ? snapshot.revision : undefined
  return {
    platform,
    documentId,
    title: typeof snapshot.title === 'string' ? snapshot.title : '',
    ...(typeof snapshot.url === 'string' && snapshot.url.length > 0 ? { url: snapshot.url } : {}),
    ...(revision === undefined ? {} : { revision }),
    tabs: normalizedTabs,
    ...(snapshot.raw === undefined ? {} : { raw: snapshot.raw }),
  }
}

/**
 * Render a normalized snapshot into model text. Multi-tab documents get a
 * header per tab because writes must target a specific tab id.
 * @param {DocumentSnapshot} snapshot - normalized snapshot.
 * @param {object} [options]
 * @param {'markdown'|'text'} [options.format] - output dialect.
 * @param {boolean} [options.includeTabHeaders] - override the multi-tab default.
 * @param {number} [options.maxChars] - overall bound; `0` disables truncation.
 * @returns {{ text: string, truncated: boolean, charCount: number }}
 */
export function renderDocument(snapshot, options = {}) {
  const format = options.format === 'text' ? 'text' : 'markdown'
  const multi = snapshot.tabs.length > 1
  const headers = options.includeTabHeaders ?? multi
  const parts = []
  for (const tab of snapshot.tabs) {
    const body = renderTabText(tab, format)
    if (headers) {
      const indent = '  '.repeat(Math.max(0, tab.depth ?? 0))
      parts.push(format === 'text' ? `${indent}=== Tab: ${tab.title} [${tab.id}] ===` : `${indent}## Tab: ${tab.title} \`${tab.id}\``)
    }
    parts.push(body)
  }
  const text = parts.join('\n\n')
  const bounded = truncateText(text, options.maxChars ?? 0)
  return { ...bounded, charCount: text.length }
}

/**
 * Find a tab by id, title, or order. A bare number (or numeric string) is
 * interpreted as the tab's order first, then as a title.
 * @param {DocumentSnapshot} snapshot - normalized snapshot.
 * @param {string|number|undefined} selector - tab id, title, or order.
 * @returns {DocumentTab} the resolved tab (first tab when omitted).
 * @throws {DocsError} INVALID_INPUT when nothing matches or a title is ambiguous.
 */
export function resolveTab(snapshot, selector) {
  if (selector === undefined || selector === null || selector === '') return snapshot.tabs[0]
  const value = String(selector).trim()
  const byId = snapshot.tabs.find((tab) => tab.id === value)
  if (byId !== undefined) return byId
  const byTitle = snapshot.tabs.filter((tab) => tab.title === value)
  if (byTitle.length === 1) return byTitle[0]
  if (byTitle.length > 1) {
    throw new DocsError(`tab title "${value}" is ambiguous`, {
      code: DOCS_ERROR.INVALID_INPUT,
      platform: snapshot.platform,
      hint: `Pass the tab id instead: ${byTitle.map((tab) => tab.id).join(', ')}.`,
    })
  }
  if (/^\d+$/.test(value)) {
    const byIndex = snapshot.tabs.find((tab) => tab.index === Number(value))
    if (byIndex !== undefined) return byIndex
  }
  throw new DocsError(`no tab matches "${value}"`, {
    code: DOCS_ERROR.INVALID_INPUT,
    platform: snapshot.platform,
    hint: `Available tabs: ${snapshot.tabs.map((tab) => `${tab.title} (${tab.id})`).join(', ')}.`,
  })
}

/**
 * Project a tab into small JSON-safe metadata (never its full text).
 * @param {DocumentTab} tab - normalized tab.
 * @param {'markdown'|'text'} [format] - output dialect used for counting.
 * @returns {object}
 */
export function tabSummary(tab, format = 'markdown') {
  const text = renderTabText(tab, format)
  return {
    id: tab.id,
    title: tab.title,
    index: tab.index ?? 0,
    depth: tab.depth ?? 0,
    chars: text.length,
    ...(Number.isInteger(tab.startIndex) ? { startIndex: tab.startIndex } : {}),
    ...(Number.isInteger(tab.endIndex) ? { endIndex: tab.endIndex } : {}),
  }
}

/**
 * Append a tab-body range when the adapter exposes native indexes; used by
 * append/insert to build a write-target description.
 * @param {DocumentTab} tab - normalized tab.
 * @returns {string}
 */
export function describeTab(tab) {
  return `${tab.title} (${tab.id})`
}
