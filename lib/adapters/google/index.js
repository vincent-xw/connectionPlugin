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
import { googleDocUrl, parseGoogleRef, toSnapshot } from './convert.js'
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
export function createGoogleAdapter({ config, auth, api, logger }) {
  const accountOf = (value) => normalizeAccount(value ?? config.account)

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

  /** Adapter contract. */
  return {
    id: 'google-docs',
    title: 'Google Docs',
    description: 'Read, create, and edit Google Docs documents with an OAuth 2.0 desktop client.',
    refExample: 'https://docs.google.com/document/d/<documentId>/edit',
    capabilities: {
      read: true,
      create: true,
      append: true,
      insert: true,
      replace: true,
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
      const snapshot = await fetchSnapshot(ref, account, signal, { raw: options.raw === true })
      return snapshot.snapshot
    },

    async create(request, signal) {
      const title = typeof request.title === 'string' ? request.title.trim() : ''
      if (title.length === 0) {
        throw new DocsError('title must not be empty', { code: DOCS_ERROR.INVALID_INPUT, platform: 'google-docs' })
      }
      const account = accountOf(request.account)
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
      const revision = revisionFromReply(reply)
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
      const nextRevision = revisionFromReply(reply) ?? revision
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
      const nextRevision = revisionFromReply(reply) ?? revision
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
      const nextRevision = revisionFromReply(reply) ?? revision
      return {
        ...(tab === undefined ? {} : { tab: tab.id }),
        occurrencesChanged: Number.isInteger(occurrences) ? occurrences : 0,
        ...(nextRevision === undefined ? {} : { revision: nextRevision }),
      }
    },

    async invoke(ref, { action, payload }, signal) {
      if (!config.allowRawActions) {
        throw new DocsError('raw Google Docs actions are disabled', {
          code: DOCS_ERROR.UNSUPPORTED,
          platform: 'google-docs',
          hint: 'Set allowRawActions: true on the docs-connector-google row to enable docs_invoke.',
        })
      }
      const account = accountOf(payload?.account)
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
      throw new DocsError(`unknown Google Docs action "${action}"`, {
        code: DOCS_ERROR.UNSUPPORTED,
        platform: 'google-docs',
        hint: 'Supported actions: getRaw, batchUpdate, createDocument.',
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
