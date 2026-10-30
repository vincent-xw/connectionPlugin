/**
 * Platform-neutral adapter registry.
 *
 * The registry owns only what every platform shares: identity, capability
 * discovery, document-reference parsing, and default-platform selection. It
 * never knows a concrete API. Adapters may expose extra methods or metadata;
 * the registry copies them into `info` untouched so a specialized tool can
 * use them.
 * @module @local/docs-connector/core/registry
 */
import { DOCS_ERROR, DocsError } from './errors.js'

/** Adapter ids are lowercase hyphenated identifiers, matching credential-key grammar. */
const ADAPTER_ID = /^[a-z][a-z0-9-]*$/

/**
 * Capabilities the registry understands. `custom` enables `docs_invoke`;
 * `auth` enables connect/disconnect; `tabs` and `revisions` are informative
 * hints for tools but do not change dispatch.
 */
export const CAPABILITIES = Object.freeze(['read', 'create', 'append', 'insert', 'replace', 'custom', 'auth', 'tabs', 'revisions'])

/** Method that implements each action capability. */
const CAPABILITY_METHOD = Object.freeze({
  read: 'read',
  create: 'create',
  append: 'append',
  insert: 'insert',
  replace: 'replace',
  custom: 'invoke',
})

/**
 * Normalize declared capabilities. An omitted capability is inferred from the
 * presence of its method, so a small adapter can just implement `read` and
 * `parseRef`; an explicit `false` always wins.
 * @param {object} adapter - adapter candidate.
 * @returns {Record<string, boolean>}
 */
export function normalizeCapabilities(adapter) {
  const declared = adapter.capabilities !== null && typeof adapter.capabilities === 'object' ? adapter.capabilities : {}
  const capabilities = {}
  for (const name of CAPABILITIES) {
    const method = CAPABILITY_METHOD[name]
    const inferred = name === 'auth'
      ? adapter.auth !== null && typeof adapter.auth === 'object'
      : name === 'tabs' || name === 'revisions'
        ? false
        : method !== undefined && typeof adapter[method] === 'function'
    capabilities[name] = declared[name] === false ? false : declared[name] === true ? true : inferred
  }
  return capabilities
}

/**
 * Validate one adapter before it becomes reachable.
 * @param {unknown} adapter - candidate.
 * @returns {{ info: object, adapter: object }} normalized adapter and its public info.
 * @throws {DocsError} INVALID_INPUT on a contract violation.
 */
export function validateAdapter(adapter) {
  if (adapter === null || typeof adapter !== 'object') {
    throw new DocsError('adapter must be an object', { code: DOCS_ERROR.INVALID_INPUT })
  }
  const id = adapter.id
  if (typeof id !== 'string' || !ADAPTER_ID.test(id)) {
    throw new DocsError(`adapter id ${JSON.stringify(id)} must be a lowercase hyphenated identifier`, {
      code: DOCS_ERROR.INVALID_INPUT,
      hint: 'Use an id such as "google-docs" or "notion".',
    })
  }
  const title = typeof adapter.title === 'string' && adapter.title.trim().length > 0 ? adapter.title.trim() : id
  if (typeof adapter.parseRef !== 'function') {
    throw new DocsError(`adapter "${id}" must implement parseRef(input)`, {
      code: DOCS_ERROR.INVALID_INPUT,
      platform: id,
    })
  }
  const capabilities = normalizeCapabilities(adapter)
  for (const [name, method] of Object.entries(CAPABILITY_METHOD)) {
    if (capabilities[name] && typeof adapter[method] !== 'function') {
      throw new DocsError(`adapter "${id}" declares "${name}" but has no ${method}() method`, {
        code: DOCS_ERROR.INVALID_INPUT,
        platform: id,
      })
    }
  }
  if (capabilities.auth) {
    for (const method of ['status', 'start', 'disconnect']) {
      if (typeof adapter.auth[method] !== 'function') {
        throw new DocsError(`adapter "${id}" declares auth but auth.${method}() is missing`, {
          code: DOCS_ERROR.INVALID_INPUT,
          platform: id,
        })
      }
    }
  }
  const info = {
    id,
    title,
    capabilities,
    ...(adapter.auth?.defaultAccount === undefined ? {} : { defaultAccount: adapter.auth.defaultAccount }),
    ...(adapter.description === undefined ? {} : { description: adapter.description }),
    ...(adapter.refExample === undefined ? {} : { refExample: adapter.refExample }),
    ...(adapter.metadata === undefined ? {} : { metadata: adapter.metadata }),
  }
  return { info, adapter }
}

/** A small registry over adapters. One instance lives per `ctx.docs` service. */
export class AdapterRegistry {
  /**
   * @param {object} [options]
   * @param {string} [options.defaultPlatform]
   * @param {(event: object) => void} [options.onRegister]
   */
  constructor(options = {}) {
    /** @type {Map<string, object>} */
    this.adapters = new Map()
    /** @type {Map<string, object>} */
    this.infos = new Map()
    this.defaultPlatform = typeof options.defaultPlatform === 'string' ? options.defaultPlatform : ''
    this.onRegister = options.onRegister
  }

  /**
   * Register an adapter. Duplicate ids are rejected rather than replaced.
   * @param {object} adapter - validated adapter.
   * @returns {() => void} disposer; idempotent.
   */
  register(adapter) {
    const { info, adapter: accepted } = validateAdapter(adapter)
    if (this.adapters.has(info.id)) {
      throw new DocsError(`a document adapter with id "${info.id}" is already registered`, {
        code: DOCS_ERROR.INVALID_INPUT,
        platform: info.id,
        hint: 'Give each adapter a unique id, or remove the other row first.',
      })
    }
    this.adapters.set(info.id, accepted)
    this.infos.set(info.id, info)
    this.onRegister?.(info)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.adapters.get(info.id) === accepted) {
        this.adapters.delete(info.id)
        this.infos.delete(info.id)
      }
    }
  }

  /** @param {string} id - adapter id. @returns {object|undefined} adapter value. */
  get(id) {
    return this.adapters.get(id)
  }

  /** @returns {object[]} stable, registration-ordered public info. */
  list() {
    return [...this.infos.values()].map((info) => ({
      ...info,
      capabilities: { ...info.capabilities },
      default: info.id === this.defaultPlatform,
    }))
  }

  /**
   * Resolve the adapter that should serve a call.
   * @param {string} [platform] - explicit adapter id.
   * @returns {object} registered adapter.
   * @throws {DocsError} when the platform is unknown, absent, or ambiguous.
   */
  choose(platform) {
    if (typeof platform === 'string' && platform.trim().length > 0) {
      const id = platform.trim()
      const adapter = this.adapters.get(id)
      if (adapter === undefined) {
        throw new DocsError(`unknown document platform "${id}"`, {
          code: DOCS_ERROR.UNKNOWN_PLATFORM,
          platform: id,
          hint: this.adapters.size === 0
            ? 'No document adapter is loaded. Install one (for Google Docs: the docs-connector bundle with the google adapter row).'
            : `Registered platforms: ${[...this.adapters.keys()].join(', ')}.`,
        })
      }
      return adapter
    }
    if (this.defaultPlatform && this.adapters.has(this.defaultPlatform)) {
      return this.adapters.get(this.defaultPlatform)
    }
    if (this.adapters.size === 1) return [...this.adapters.values()][0]
    if (this.adapters.size === 0) {
      throw new DocsError('no document adapter is registered', {
        code: DOCS_ERROR.PLATFORM_UNAVAILABLE,
        hint: 'Install the docs-connector bundle with at least one adapter row.',
      })
    }
    throw new DocsError('multiple document platforms are registered; pass platform explicitly', {
      code: DOCS_ERROR.AMBIGUOUS_PLATFORM,
      hint: `Pass platform: ${[...this.adapters.keys()].join(' | ')}.`,
    })
  }

  /**
   * Parse a document reference: a platform URL, a native id, or
   * `<platform>:<native-id>`.
   * @param {string} input - user/model supplied reference.
   * @param {string} [platform] - explicit platform hint.
   * @returns {{ adapter: object, ref: { platform: string, documentId: string, url?: string } }}
   * @throws {DocsError} INVALID_REFERENCE when no adapter accepts the input.
   */
  parse(input, platform) {
    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new DocsError('document reference must be a non-empty string', {
        code: DOCS_ERROR.INVALID_REFERENCE,
        hint: 'Pass a document URL or a platform document id.',
      })
    }
    const raw = input.trim()
    const prefixed = /^([a-z][a-z0-9-]*):(.+)$/.exec(raw)
    if (prefixed !== null && this.adapters.has(prefixed[1])) {
      return this.parseWith(this.adapters.get(prefixed[1]), prefixed[2], prefixed[1])
    }
    if (typeof platform === 'string' && platform.trim().length > 0) {
      return this.parseWith(this.choose(platform), raw, platform.trim())
    }
    const matches = []
    for (const adapter of this.adapters.values()) {
      try {
        const ref = adapter.parseRef(raw)
        if (ref !== null && typeof ref === 'object') matches.push({ adapter, ref })
      } catch {
        // An adapter that does not recognize the input is expected to throw or
        // return null; a parse failure is not a registry failure.
        continue
      }
    }
    if (matches.length === 1) {
      const [{ adapter, ref }] = matches
      return { adapter, ref: this.normalizeRef(adapter, ref) }
    }
    if (matches.length > 1) {
      throw new DocsError(`document reference "${raw}" matches more than one platform`, {
        code: DOCS_ERROR.AMBIGUOUS_PLATFORM,
        hint: `Pass platform (${matches.map((match) => match.adapter.id).join(' | ')}) or prefix the reference as <platform>:<id>.`,
      })
    }
    throw new DocsError(`cannot recognize document reference "${raw}"`, {
      code: DOCS_ERROR.INVALID_REFERENCE,
      hint: this.adapters.size === 0
        ? 'No document adapter is loaded.'
        : `Pass a URL or id understood by ${[...this.adapters.keys()].join(', ')}, or prefix it as <platform>:<id>.`,
    })
  }

  /**
   * Parse with one adapter and normalize the ref.
   * @param {object} adapter - adapter.
   * @param {string} input - reference body.
   * @param {string} platform - asserted id.
   * @returns {{ adapter: object, ref: object }}
   */
  parseWith(adapter, input, platform) {
    let ref
    try {
      ref = adapter.parseRef(input.trim())
    } catch (error) {
      throw new DocsError(`${adapter.title} does not recognize the document reference`, {
        code: DOCS_ERROR.INVALID_REFERENCE,
        platform,
        hint: error instanceof Error ? error.message : 'Pass a document URL or id.',
        cause: error,
      })
    }
    if (ref === null || typeof ref !== 'object') {
      throw new DocsError(`${adapter.title} does not recognize the document reference`, {
        code: DOCS_ERROR.INVALID_REFERENCE,
        platform,
        hint: adapter.refExample === undefined ? 'Pass a document URL or id.' : `Example: ${adapter.refExample}`,
      })
    }
    return { adapter, ref: this.normalizeRef(adapter, ref) }
  }

  /**
   * Normalize an adapter-produced ref.
   * @param {object} adapter - source adapter.
   * @param {object} ref - candidate.
   * @returns {{ platform: string, documentId: string, url?: string }}
   */
  normalizeRef(adapter, ref) {
    const documentId = typeof ref.documentId === 'string' ? ref.documentId.trim() : ''
    if (documentId.length === 0) {
      throw new DocsError('adapter returned a document reference without documentId', {
        code: DOCS_ERROR.UPSTREAM,
        platform: adapter.id,
      })
    }
    return {
      platform: adapter.id,
      documentId,
      ...(typeof ref.url === 'string' && ref.url.length > 0 ? { url: ref.url } : {}),
    }
  }
}
