/**
 * Google Slides conversion.
 *
 * A presentation maps onto the portable model as one tab per slide, with each
 * shape's text becoming a paragraph block and each slide table becoming a
 * `table` block. The first non-empty line of a slide becomes its tab title so
 * `docs_read` gives the model a usable outline before the body.
 * @module @local/docs-connector/adapters/google/convert-slides
 */

/** Join one shape's text runs into a plain string. */
function textOf(text) {
  const elements = Array.isArray(text?.textElements) ? text.textElements : []
  let output = ''
  for (const element of elements) {
    if (typeof element?.textRun?.content === 'string') output += element.textRun.content
  }
  return output
}

/** Split shape text into blocks, dropping the trailing blank line Slides keeps. */
function textBlocks(text, placeholderType) {
  const trimmed = text.replace(/\n+$/, '')
  if (trimmed.trim().length === 0) return []
  const lines = trimmed.split('\n')
  const isTitle = typeof placeholderType === 'string' && /TITLE|HEADER/.test(placeholderType)
  return lines.map((line, index) => isTitle && index === 0
    ? { type: 'heading', level: 1, text: line }
    : { type: 'paragraph', text: line })
}

/** Convert a slide table element into a table block. */
function tableBlock(table) {
  const rows = (Array.isArray(table?.tableRows) ? table.tableRows : []).map((row) => (Array.isArray(row?.tableCells) ? row.tableCells : [])
    .map((cell) => textOf(cell?.text).replace(/\n+$/, '')))
  return { type: 'table', rows }
}

/** Convert one page element into zero or more blocks. */
function elementBlocks(element) {
  if (element?.shape !== undefined) {
    return textBlocks(textOf(element.shape.text), element.shape.placeholder?.type)
  }
  if (element?.table !== undefined) return [tableBlock(element.table)]
  if (element?.image !== undefined) {
    const alt = element.image.title ?? element.image.description ?? 'image'
    return [{ type: 'image', alt: String(alt) }]
  }
  if (element?.line !== undefined) return [{ type: 'raw', text: '[line]' }]
  if (element?.sheetsChart !== undefined) return [{ type: 'raw', text: '[chart]' }]
  if (element?.video !== undefined) return [{ type: 'raw', text: '[video]' }]
  if (element?.wordArt !== undefined) return [{ type: 'raw', text: '[word art]' }]
  return []
}

/** First non-empty line of a slide, used as the tab title. */
function slideTitle(blocks, position) {
  for (const block of blocks) {
    const text = typeof block.text === 'string' ? block.text.trim() : ''
    if (text.length > 0) return text.length > 60 ? `${text.slice(0, 57)}...` : text
  }
  return `Slide ${position + 1}`
}

/**
 * Convert a `presentations.get` response into a snapshot.
 * @param {object} presentation - Slides API Presentation.
 * @param {object} [options]
 * @param {boolean} [options.raw] - attach the native payload.
 * @returns {object} snapshot for {@link normalizeSnapshot}.
 */
export function toSlidesSnapshot(presentation, options = {}) {
  const presentationId = typeof presentation?.presentationId === 'string' ? presentation.presentationId : ''
  const slides = Array.isArray(presentation?.slides) ? presentation.slides : []
  const tabs = slides.map((slide, position) => {
    const elements = Array.isArray(slide?.pageElements) ? slide.pageElements : []
    const blocks = elements.flatMap(elementBlocks)
    const objectId = typeof slide?.objectId === 'string' && slide.objectId.length > 0 ? slide.objectId : `slide-${position}`
    return {
      id: objectId,
      title: slideTitle(blocks, position),
      index: position,
      depth: 0,
      blocks: blocks.length === 0 ? [{ type: 'paragraph', text: '(empty slide)' }] : blocks,
    }
  })
  return {
    platform: 'google-docs',
    documentId: presentationId,
    title: typeof presentation?.title === 'string' ? presentation.title : '',
    url: presentationId.length > 0 ? `https://docs.google.com/presentation/d/${presentationId}/edit` : undefined,
    ...(typeof presentation?.revisionId === 'string' && presentation.revisionId.length > 0 ? { revision: presentation.revisionId } : {}),
    tabs,
    ...(options.raw === true ? { raw: presentation } : {}),
  }
}
