/**
 * Plugin entry and public adapter-authoring surface of the Docs Connector.
 *
 * This module is the package root row (`@local/docs-connector`). It registers
 * the `ctx.docs` registry service. The same module is also the safe import
 * target for third-party adapters:
 *
 * ```js
 * import { DocsError, DOCS_ERROR, renderDocument } from '@local/docs-connector/core'
 * ```
 * @module @local/docs-connector/core
 */
import { DocsService } from './service.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'docs-connector'

/**
 * Mount the platform-neutral registry as `ctx.docs`.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning context.
 * @param {unknown} config - `{ defaultPlatform?, maxReadChars?, allowCustomActions? }`.
 */
export function apply(ctx, config) {
  ctx.provide('docs', new DocsService(ctx, config))
}

export { DOCS_ERROR, DocsError, asDocsError } from './errors.js'
export {
  normalizeSnapshot,
  renderBlock,
  renderDocument,
  renderTabText,
  resolveTab,
  tabCharCount,
  tabSummary,
  truncateText,
} from './document.js'
export { AdapterRegistry, CAPABILITIES, normalizeCapabilities, validateAdapter } from './registry.js'
export { DEFAULT_MAX_READ_CHARS, DocsService, MAX_CONNECT_WAIT_SECONDS, MAX_READ_CHARS, requireCapability, resolveCoreConfig } from './service.js'
