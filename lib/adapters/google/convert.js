/**
 * Google Docs document conversion.
 *
 * The Docs API returns a structural document (tabs, paragraphs, tables,
 * inline elements), not Markdown. This module turns that structure into the
 * Connector's portable blocks and keeps the native indexes a caller needs for
 * `docs_insert`.
 * @module @local/docs-connector/adapters/google/convert
 */

/** Canonical browser URL for a Google Doc. */
export function googleDocUrl(documentId) {
  return `https://docs.google.com/document/d/${documentId}/edit`
}

/**
 * Parse a Google Docs URL or a bare document id.
 * @param {string} input - URL, URL without scheme, or id.
 * @returns {{ documentId: string, url: string } | null} parsed reference, or null when unrecognized.
 */
export function parseGoogleRef(input) {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (value.length === 0 || /\s/.test(value)) return null
  let candidate = value
  if (/^docs\.google\.com\//i.test(candidate)) candidate = `https://${candidate}`
  if (/^https?:\/\//i.test(candidate)) {
    let url
    try {
      url = new URL(candidate)
    } catch {
      return null
    }
    if (!/(^|\.)docs\.google\.com$/i.test(url.hostname)) return null
    const path = url.pathname
    const pathMatch = /\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)/.exec(path)
    if (pathMatch !== null) return { documentId: pathMatch[1], url: googleDocUrl(pathMatch[1]) }
    const openId = url.searchParams.get('id')
    if ((/\/document\/?$/i.test(path) || /\/open\/?$/i.test(path)) && openId !== null && /^[A-Za-z0-9_-]+$/.test(openId)) {
      return { documentId: openId, url: googleDocUrl(openId) }
    }
    return null
  }
  if (/^[A-Za-z0-9_-]{10,}$/.test(value)) return { documentId: value, url: googleDocUrl(value) }
  return null
}

/**
 * Apply inline text styles as Markdown. Whitespace-only runs are left alone so
 * paragraph terminators do not turn into stray emphasis markers.
 * @param {string} text - run text.
 * @param {object} [style] - `textStyle` from the Docs API.
 * @returns {string}
 */
function styleRun(text, style) {
  if (text.trim().length === 0) return text
  let output = text
  if (typeof style?.link?.url === 'string' && style.link.url.length > 0) output = `[${output}](${style.link.url})`
  if (style?.bold === true) output = `**${output}**`
  if (style?.italic === true) output = `*${output}*`
  if (style?.strikethrough === true) output = `~~${output}~~`
  return output
}

/**
 * Flatten one paragraph's inline elements.
 * @param {object} paragraph - Docs API Paragraph.
 * @returns {string} paragraph text without its trailing newline.
 */
export function paragraphText(paragraph) {
  const elements = paragraph?.elements ?? []
  const lastTextRun = elements.reduce((last, element, index) => element.textRun !== undefined ? index : last, -1)
  let output = ''
  elements.forEach((element, index) => {
    if (element.textRun !== undefined) {
      let content = String(element.textRun.content ?? '')
      // Strip only the paragraph terminator so intentional soft line breaks
      // (Shift+Enter) inside a run survive.
      if (index === lastTextRun && content.endsWith('\n')) content = content.slice(0, -1)
      output += styleRun(content, element.textRun.textStyle)
    } else if (element.inlineObjectElement !== undefined) {
      const id = element.inlineObjectElement.inlineObjectId
      output += `[image: ${typeof id === 'string' && id.length > 0 ? id : 'image'}]`
    } else if (element.footnoteReference !== undefined) {
      output += `[^${element.footnoteReference.footnoteNumber ?? '?'}]`
    } else if (element.person !== undefined) {
      output += `@${element.person.personProperties?.name ?? 'person'}`
    } else if (element.richLink !== undefined) {
      output += element.richLink.richLinkProperties?.title ?? 'link'
    } else if (element.equation !== undefined) {
      output += ' [equation] '
    } else if (element.horizontalRule !== undefined) {
      output += '\n---\n'
    } else if (element.pageBreak !== undefined) {
      output += '\n---\n'
    }
  })
  return output
}

/** Heading depth for a Docs API named style, or 0 for body text. */
function headingForStyle(namedStyleType) {
  switch (namedStyleType) {
    case 'TITLE': return 1
    case 'SUBTITLE': return 2
    case 'HEADING_1': return 1
    case 'HEADING_2': return 2
    case 'HEADING_3': return 3
    case 'HEADING_4': return 4
    case 'HEADING_5': return 5
    case 'HEADING_6': return 6
    default: return 0
  }
}

/**
 * Convert one paragraph item into a portable block.
 * @param {object} item - body content item carrying `paragraph`.
 * @returns {object} block.
 */
function paragraphBlock(item) {
  const paragraph = item.paragraph
  const text = paragraphText(paragraph)
  const base = {
    ...(Number.isInteger(item.startIndex) ? { startIndex: item.startIndex } : {}),
    ...(Number.isInteger(item.endIndex) ? { endIndex: item.endIndex } : {}),
  }
  if (paragraph?.bullet !== undefined) {
    return { type: 'list', text, level: Math.max(0, Number(paragraph.bullet.nestingLevel) || 0), ordered: false, ...base }
  }
  const level = headingForStyle(paragraph?.paragraphStyle?.namedStyleType)
  if (level > 0 && text.trim().length > 0) return { type: 'heading', level, text, ...base }
  return { type: 'paragraph', text, ...base }
}

/**
 * Convert a table into a portable table block.
 * @param {object} table - Docs API Table.
 * @param {object} item - body content item carrying the table.
 * @returns {object} block.
 */
function tableBlock(table, item) {
  const rows = (table?.tableRows ?? []).map((row) => (row.tableCells ?? []).map((cell) => {
    const parts = (cell.content ?? []).map((content) => {
      if (content.paragraph !== undefined) return paragraphText(content.paragraph)
      if (content.table !== undefined) return '[nested table]'
      return ''
    })
    return parts.filter((part) => part.length > 0).join('\n')
  }))
  return {
    type: 'table',
    rows,
    ...(Number.isInteger(item.startIndex) ? { startIndex: item.startIndex } : {}),
    ...(Number.isInteger(item.endIndex) ? { endIndex: item.endIndex } : {}),
  }
}

/**
 * Convert a Docs body content array into portable blocks.
 * @param {object[]} content - `body.content`.
 * @returns {object[]} blocks.
 */
export function blocksFromContent(content) {
  const blocks = []
  for (const item of content ?? []) {
    if (item.paragraph !== undefined) {
      blocks.push(paragraphBlock(item))
    } else if (item.table !== undefined) {
      blocks.push(tableBlock(item.table, item))
    } else if (item.tableOfContents !== undefined) {
      blocks.push(...blocksFromContent(item.tableOfContents.content))
      blocks.push({ type: 'break', kind: 'section' })
    } else if (item.sectionBreak !== undefined) {
      blocks.push({ type: 'break', kind: 'section' })
    }
  }
  return blocks
}

/**
 * Native index range covered by a content array.
 * @param {object[]} content - body content.
 * @returns {{ startIndex?: number, endIndex?: number }}
 */
function contentRange(content) {
  let startIndex
  let endIndex
  for (const item of content ?? []) {
    if (Number.isInteger(item.startIndex) && (startIndex === undefined || item.startIndex < startIndex)) startIndex = item.startIndex
    if (Number.isInteger(item.endIndex) && (endIndex === undefined || item.endIndex > endIndex)) endIndex = item.endIndex
  }
  return {
    ...(startIndex === undefined ? {} : { startIndex }),
    ...(endIndex === undefined ? {} : { endIndex }),
  }
}

/**
 * Convert a `documents.get` response into the portable snapshot.
 * @param {object} document - Docs API Document.
 * @param {object} [options]
 * @param {boolean} [options.raw] - attach the native payload.
 * @returns {object} snapshot for {@link normalizeSnapshot}.
 */
export function toSnapshot(document, options = {}) {
  if (document === null || typeof document !== 'object') {
    throw new Error('Google Docs returned an empty document')
  }
  const documentId = typeof document.documentId === 'string' ? document.documentId : ''
  const tabs = []
  const visit = (tab, depth) => {
    const properties = tab?.tabProperties ?? {}
    const documentTab = tab?.documentTab ?? tab
    const content = documentTab?.body?.content
    const position = tabs.length
    tabs.push({
      id: typeof properties.tabId === 'string' && properties.tabId.length > 0 ? properties.tabId : `tab-${position}`,
      title: typeof properties.title === 'string' && properties.title.length > 0
        ? properties.title
        : position === 0 && typeof document.title === 'string'
          ? document.title
          : `Tab ${position + 1}`,
      index: Number.isInteger(properties.index) ? properties.index : position,
      depth,
      blocks: blocksFromContent(content),
      ...contentRange(content),
    })
    for (const child of tab.childTabs ?? []) visit(child, depth + 1)
  }
  if (Array.isArray(document.tabs) && document.tabs.length > 0) {
    for (const tab of document.tabs) visit(tab, 0)
  } else if (document.body !== undefined) {
    const content = document.body?.content
    tabs.push({
      id: 'body',
      title: typeof document.title === 'string' && document.title.length > 0 ? document.title : 'Document',
      index: 0,
      depth: 0,
      blocks: blocksFromContent(content),
      ...contentRange(content),
    })
  }
  return {
    platform: 'google-docs',
    documentId,
    title: typeof document.title === 'string' ? document.title : '',
    url: documentId.length > 0 ? googleDocUrl(documentId) : undefined,
    ...(typeof document.revisionId === 'string' && document.revisionId.length > 0 ? { revision: document.revisionId } : {}),
    tabs,
    ...(options.raw === true ? { raw: document } : {}),
  }
}
