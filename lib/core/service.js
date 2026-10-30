/**
 * The `ctx.docs` capability service.
 *
 * It is a thin, platform-neutral dispatcher: resolve an adapter, check the
 * capability, hand over a plain request object, and normalize the answer into
 * the model-facing result shape. Adapters own every native protocol detail.
 * @module @local/docs-connector/core/service
 */
import { DOCS_ERROR, DocsError, asDocsError } from './errors.js'
import { normalizeSnapshot, renderDocument, renderTabText, resolveTab, tabSummary, truncateText } from './document.js'
import { AdapterRegistry, normalizeCapabilities } from './registry.js'

/** Default bound on one rendered document. */
export const DEFAULT_MAX_READ_CHARS = 60000
/** Upper bound a caller may request for one rendered document. */
export const MAX_READ_CHARS = 400000
/** Upper bound on `docs_connect`'s blocking wait. */
export const MAX_CONNECT_WAIT_SECONDS = 120

/**
 * Validate and default the core row config.
 * @param {unknown} raw - row config.
 * @returns {{ defaultPlatform: string, maxReadChars: number, allowCustomActions: boolean, logLevel: string }}
 */
export function resolveCoreConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const defaultPlatform = typeof config.defaultPlatform === 'string' ? config.defaultPlatform.trim() : ''
  const requested = Number(config.maxReadChars ?? DEFAULT_MAX_READ_CHARS)
  const maxReadChars = Number.isFinite(requested) && requested > 0 ? Math.min(Math.trunc(requested), MAX_READ_CHARS) : DEFAULT_MAX_READ_CHARS
  return {
    defaultPlatform,
    maxReadChars,
    allowCustomActions: config.allowCustomActions !== false,
    logLevel: typeof config.logLevel === 'string' ? config.logLevel : 'info',
  }
}

/** @param {number} ms - delay. @param {AbortSignal} [signal] - cancellation. @returns {Promise<void>} */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DocsError('cancelled', { code: DOCS_ERROR.CANCELLED }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new DocsError('cancelled', { code: DOCS_ERROR.CANCELLED }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Project known read-result fields, dropping `undefined`. */
function projectRead(value) {
  return {
    platform: value.platform,
    documentId: value.documentId,
    title: value.title,
    ...(value.url === undefined ? {} : { url: value.url }),
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    tabs: value.tabs,
    text: value.text,
    truncated: value.truncated,
  }
}

/** Project known write-result fields, dropping `undefined`. */
function projectWrite(value) {
  return {
    platform: value.platform,
    documentId: value.documentId,
    ...(value.url === undefined ? {} : { url: value.url }),
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    ...(value.tab === undefined ? {} : { tab: value.tab }),
    ...(value.index === undefined ? {} : { index: value.index }),
    ...(value.occurrencesChanged === undefined ? {} : { occurrencesChanged: value.occurrencesChanged }),
    ...(value.insertedChars === undefined ? {} : { insertedChars: value.insertedChars }),
  }
}

/** Coerce a credential expiry into an ISO string. */
function isoExpiry(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

/** The service registered as `ctx.docs`. */
export class DocsService {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - owning cordis context.
   * @param {unknown} rawConfig - row config.
   */
  constructor(ctx, rawConfig) {
    this.ctx = ctx
    this.config = resolveCoreConfig(rawConfig)
    this.registry = new AdapterRegistry({ defaultPlatform: this.config.defaultPlatform })
    this.logger = safeLogger(ctx, 'docs-connector')
  }

  /**
   * Register a platform adapter for the lifetime of the calling plugin.
   * @param {object} adapter - adapter contract implementation.
   * @returns {() => void} disposer.
   */
  registerAdapter(adapter, ownerCtx = this.ctx) {
    const self = this
    const effectHost = typeof ownerCtx?.effect === 'function' ? ownerCtx : this.ctx
    return effectHost.effect(function* registerDocsAdapter() {
      const unregister = self.registry.register(adapter)
      yield () => {
        unregister()
        try {
          adapter.close?.()
        } catch (error) {
          self.logger?.warn?.('docs adapter close failed:', error instanceof Error ? error.message : error)
        }
      }
    }, `docs.registerAdapter(${adapter?.id ?? '?'})`)
  }

  /** @returns {object[]} registered adapters, without live auth status. */
  adapters() {
    return this.registry.list()
  }

  /**
   * Resolve one adapter or the default platform.
   * @param {string} [platform] - explicit platform id.
   * @returns {object} adapter.
   */
  choose(platform) {
    return this.registry.choose(platform)
  }

  /**
   * List adapters with live authorization state.
   * @param {string} [platform] - optional single platform.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object[]>}
   */
  async catalog(platform, signal) {
    const adapters = platform === undefined ? [...this.registry.adapters.values()] : [this.choose(platform)]
    return Promise.all(adapters.map(async (adapter) => {
      const info = this.registry.list().find((entry) => entry.id === adapter.id)
      return {
        id: adapter.id,
        title: info?.title ?? adapter.id,
        description: info?.description,
        refExample: info?.refExample,
        capabilities: info?.capabilities ?? {},
        default: info?.default === true,
        auth: await this.authStatus(adapter, undefined, signal),
      }
    }))
  }

  /**
   * Read one adapter's auth state without throwing on adapter failure.
   * @param {object} adapter - adapter.
   * @param {string} [account] - account id.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>}
   */
  async authStatus(adapter, account, signal) {
    if (typeof adapter.auth?.status !== 'function') {
      return { supported: false, connected: false }
    }
    try {
      const status = await adapter.auth.status({ account, signal })
      return {
        supported: true,
        connected: status?.connected === true,
        ...(typeof status?.account === 'string' ? { account: status.account } : {}),
        ...(isoExpiry(status?.expiresAt) === undefined ? {} : { expiresAt: isoExpiry(status.expiresAt) }),
        ...(typeof status?.detail === 'string' && status.detail.length > 0 ? { detail: status.detail } : {}),
      }
    } catch (error) {
      return {
        supported: true,
        connected: false,
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Read a document through its adapter.
   * @param {object} request - `{ document, platform?, tab?, format?, includeTabHeaders?, maxChars?, includeBlocks?, raw? }`.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>} model-facing read result.
   */
  async read(request, signal) {
    const { adapter, ref } = this.registry.parse(request.document, request.platform)
    try {
      requireCapability(adapter, 'read')
      const format = request.format === 'text' ? 'text' : 'markdown'
      const snapshot = await adapter.read(ref, {
        tab: request.tab,
        account: request.account,
        format,
        includeBlocks: request.includeBlocks === true,
        raw: request.raw === true,
      }, signal)
      const normalized = normalizeSnapshot(snapshot, { platform: adapter.id })
      const maxChars = request.maxChars === undefined
        ? this.config.maxReadChars
        : Math.min(Math.max(0, Math.trunc(Number(request.maxChars)) || 0), MAX_READ_CHARS)
      const selected = request.tab === undefined || request.tab === null || request.tab === ''
        ? undefined
        : resolveTab(normalized, request.tab)
      const rendered = selected === undefined
        ? renderDocument(normalized, { format, includeTabHeaders: request.includeTabHeaders, maxChars })
        : (() => {
          const bounded = truncateText(renderTabText(selected, format), maxChars)
          return { ...bounded, charCount: bounded.text.length }
        })()
      return projectRead({
        platform: normalized.platform,
        documentId: ref.documentId,
        title: normalized.title || ref.documentId,
        url: normalized.url ?? ref.url,
        revision: normalized.revision,
        tabs: normalized.tabs.map((tab) => tabSummary(tab, format)),
        text: rendered.text,
        truncated: rendered.truncated,
      })
    } catch (error) {
      throw asDocsError(error, { platform: adapter.id })
    }
  }

  /**
   * Create a document.
   * @param {object} request - `{ platform?, title, text?, tabTitle? }`.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>}
   */
  async create(request, signal) {
    const adapter = this.registry.choose(request.platform)
    try {
      requireCapability(adapter, 'create')
      const result = await adapter.create({
        title: request.title,
        text: request.text,
        tabTitle: request.tabTitle,
        account: request.account,
      }, signal)
      if (result === null || typeof result !== 'object' || typeof result.documentId !== 'string' || result.documentId.length === 0) {
        throw new DocsError('adapter create() returned no documentId', {
          code: DOCS_ERROR.UPSTREAM,
          platform: adapter.id,
        })
      }
      const ref = { platform: adapter.id, documentId: result.documentId }
      let url = result.url
      if (url === undefined && typeof adapter.formatRef === 'function') {
        try {
          url = adapter.formatRef(ref)
        } catch {
          url = undefined
        }
      }
      return projectWrite({
        platform: adapter.id,
        documentId: result.documentId,
        url,
        revision: result.revision,
        tab: result.tab ?? result.tabId,
      })
    } catch (error) {
      throw asDocsError(error, { platform: adapter.id })
    }
  }

  /**
   * Append text to the end of a tab (or the default tab).
   * @param {object} request - `{ document, platform?, tab?, text, expectedRevision?, leadingNewline? }`.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>}
   */
  async append(request, signal) {
    return this.write('append', request, signal, (adapter, ref) => adapter.append(ref, {
      tab: request.tab,
      account: request.account,
      text: request.text,
      expectedRevision: request.expectedRevision,
      leadingNewline: request.leadingNewline,
    }, signal))
  }

  /**
   * Insert text at a native index inside a tab.
   * @param {object} request - `{ document, platform?, tab?, index, text, expectedRevision? }`.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>}
   */
  async insert(request, signal) {
    return this.write('insert', request, signal, (adapter, ref) => adapter.insert(ref, {
      tab: request.tab,
      account: request.account,
      index: request.index,
      text: request.text,
      expectedRevision: request.expectedRevision,
    }, signal))
  }

  /**
   * Replace every occurrence of a text run, optionally scoped to one tab.
   * @param {object} request - `{ document, platform?, tab?, find, replace, matchCase?, expectedRevision? }`.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>}
   */
  async replace(request, signal) {
    return this.write('replace', request, signal, (adapter, ref) => adapter.replace(ref, {
      tab: request.tab,
      account: request.account,
      find: request.find,
      replace: request.replace,
      matchCase: request.matchCase,
      expectedRevision: request.expectedRevision,
    }, signal))
  }

  /**
   * Shared write dispatch: parse, check capability, call, merge identity.
   * @param {'append'|'insert'|'replace'} capability - write kind.
   * @param {object} request - tool request.
   * @param {AbortSignal} [signal] - cancellation.
   * @param {(adapter: object, ref: object) => Promise<object>} call - adapter invocation.
   * @returns {Promise<object>}
   */
  async write(capability, request, signal, call) {
    const { adapter, ref } = this.registry.parse(request.document, request.platform)
    try {
      requireCapability(adapter, capability)
      const result = await call(adapter, ref)
      return projectWrite({
        platform: adapter.id,
        documentId: ref.documentId,
        url: ref.url,
        revision: result?.revision,
        tab: result?.tab,
        index: result?.index,
        occurrencesChanged: result?.occurrencesChanged,
        insertedChars: result?.insertedChars,
      })
    } catch (error) {
      throw asDocsError(error, { platform: adapter.id })
    }
  }

  /**
   * Start (or inspect) authorization for a platform.
   * @param {object} request - `{ platform?, account?, waitSeconds?, force? }`.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>} connect result.
   */
  async connect(request, signal) {
    const adapter = this.registry.choose(request.platform)
    if (typeof adapter.auth?.start !== 'function') {
      throw new DocsError(`${adapter.title} does not support an in-agent authorization flow`, {
        code: DOCS_ERROR.UNSUPPORTED,
        platform: adapter.id,
        hint: 'Configure the platform credentials directly, or install an adapter that implements auth.',
      })
    }
    const account = typeof request.account === 'string' && request.account.trim().length > 0
      ? request.account.trim()
      : adapter.auth.defaultAccount ?? 'default'
    try {
      if (request.force !== true) {
        const existing = await adapter.auth.status({ account, signal })
        if (existing?.connected === true) {
          return {
            platform: adapter.id,
            account,
            connected: true,
            status: 'connected',
            alreadyConnected: true,
            ...(isoExpiry(existing.expiresAt) === undefined ? {} : { expiresAt: isoExpiry(existing.expiresAt) }),
          }
        }
      }
      const started = await adapter.auth.start({ account, clientId: request.clientId, signal })
      const waitSeconds = Math.min(MAX_CONNECT_WAIT_SECONDS, Math.max(0, Math.trunc(Number(request.waitSeconds) || 0)))
      let status = await adapter.auth.status({ account, signal })
      const deadline = Date.now() + waitSeconds * 1000
      while (status?.connected !== true && Date.now() < deadline) {
        await delay(400, signal)
        status = await adapter.auth.status({ account, signal })
      }
      return {
        platform: adapter.id,
        account,
        connected: status?.connected === true,
        status: status?.connected === true ? 'connected' : 'pending',
        ...(typeof started?.url === 'string' ? { url: started.url } : {}),
        ...(isoExpiry(started?.expiresAt) === undefined ? {} : { expiresAt: isoExpiry(started.expiresAt) }),
        ...(typeof status?.detail === 'string' && status.detail.length > 0 ? { detail: status.detail } : {}),
      }
    } catch (error) {
      throw asDocsError(error, { platform: adapter.id, hint: 'Check the OAuth client configuration, then retry docs_connect.' })
    }
  }

  /**
   * Forget a platform authorization (and close pending authorization flows).
   * @param {object} request - `{ platform?, account? }`.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>}
   */
  async disconnect(request, signal) {
    const adapter = this.registry.choose(request.platform)
    if (typeof adapter.auth?.disconnect !== 'function') {
      throw new DocsError(`${adapter.title} has no stored authorization to disconnect`, {
        code: DOCS_ERROR.UNSUPPORTED,
        platform: adapter.id,
      })
    }
    const account = typeof request.account === 'string' && request.account.trim().length > 0
      ? request.account.trim()
      : adapter.auth.defaultAccount ?? 'default'
    try {
      await adapter.auth.disconnect({ account, signal })
      return { platform: adapter.id, account, connected: false, status: 'disconnected' }
    } catch (error) {
      throw asDocsError(error, { platform: adapter.id })
    }
  }

  /**
   * Escape hatch: run an adapter-specific action.
   * @param {object} request - `{ platform?, document?, action, payload? }`.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<object>}
   */
  async invoke(request, signal) {
    if (!this.config.allowCustomActions) {
      throw new DocsError('adapter-specific actions are disabled', {
        code: DOCS_ERROR.UNSUPPORTED,
        hint: 'Set allowCustomActions: true on the docs-connector row to enable docs_invoke.',
      })
    }
    let adapter
    let ref = null
    if (typeof request.document === 'string' && request.document.trim().length > 0) {
      const parsed = this.registry.parse(request.document, request.platform)
      adapter = parsed.adapter
      ref = parsed.ref
    } else {
      adapter = this.registry.choose(request.platform)
    }
    try {
      requireCapability(adapter, 'custom')
      const result = await adapter.invoke(ref, { action: request.action, payload: request.payload, account: request.account }, signal)
      return {
        platform: adapter.id,
        action: request.action,
        result: result === undefined ? null : result,
      }
    } catch (error) {
      throw asDocsError(error, { platform: adapter.id })
    }
  }
}

/**
 * Throw UNSUPPORTED when an adapter lacks a capability.
 * @param {object} adapter - adapter.
 * @param {string} capability - capability name.
 */
export function requireCapability(adapter, capability) {
  const capabilities = normalizeCapabilities(adapter)
  const supported = capabilities[capability] === true
  if (!supported) {
    throw new DocsError(`${adapter.title ?? adapter.id} does not support ${capability}`, {
      code: DOCS_ERROR.UNSUPPORTED,
      platform: adapter.id,
      hint: `Available operations: ${Object.entries(capabilities).filter(([, enabled]) => enabled === true).map(([name]) => name).join(', ') || 'none'}.`,
    })
  }
}

/** Resolve a logger without requiring the logger service. */
function safeLogger(ctx, name) {
  try {
    return ctx.logger?.(name) ?? undefined
  } catch {
    return undefined
  }
}
