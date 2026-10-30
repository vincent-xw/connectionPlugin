/**
 * Stable error vocabulary shared by the registry, every adapter, and the
 * model-facing tools.
 *
 * Adapters are free to throw their own errors; the registry wraps unknown
 * failures into a {@link DocsError} so a tool always reports one shape. The
 * codes below are the ones the built-in tools word into concrete next steps.
 * @module @local/docs-connector/core/errors
 */

/** Machine-routable codes. `code` is an open string; these are the built-ins. */
export const DOCS_ERROR = Object.freeze({
  /** No adapter declares the requested platform (or none is registered). */
  UNKNOWN_PLATFORM: 'UNKNOWN_PLATFORM',
  /** More than one adapter could handle the request and none was named. */
  AMBIGUOUS_PLATFORM: 'AMBIGUOUS_PLATFORM',
  /** No adapter is registered at all, or the platform is unconfigured. */
  PLATFORM_UNAVAILABLE: 'PLATFORM_UNAVAILABLE',
  /** The adapter exists but does not implement the requested capability. */
  UNSUPPORTED: 'UNSUPPORTED',
  /** The caller's arguments are invalid. */
  INVALID_INPUT: 'INVALID_INPUT',
  /** The document reference cannot be parsed or does not resolve. */
  INVALID_REFERENCE: 'INVALID_REFERENCE',
  /** The document was not found or is not visible to the account. */
  NOT_FOUND: 'NOT_FOUND',
  /** The account lacks permission or the token lacks a required scope. */
  FORBIDDEN: 'FORBIDDEN',
  /** No usable credential; the user must authorize the platform. */
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  /** An authorization attempt failed or expired. */
  AUTH_FAILED: 'AUTH_FAILED',
  /** The OAuth client is not configured. */
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  /** The document changed since the revision the write was based on. */
  REVISION_CONFLICT: 'REVISION_CONFLICT',
  /** Provider-side quota or rate limit. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Provider-side failure (5xx, malformed response, network failure). */
  UPSTREAM: 'UPSTREAM',
  /** The caller cancelled the operation. */
  CANCELLED: 'CANCELLED',
});

/**
 * One operational failure with a routable code and an optional next step.
 *
 * `hint` is written for the model: it names the concrete remedy rather than
 * restating the failure. `details` is JSON-safe diagnostic data and must never
 * contain tokens.
 */
export class DocsError extends Error {
  /**
   * @param {string} message - human- and model-readable failure description.
   * @param {object} [options]
   * @param {string} [options.code] - one of {@link DOCS_ERROR}, or an adapter code.
   * @param {string} [options.platform] - adapter id that failed.
   * @param {string} [options.hint] - concrete next step.
   * @param {boolean} [options.retryable] - whether the same call may be retried.
   * @param {unknown} [options.details] - JSON-safe diagnostics.
   * @param {unknown} [options.cause] - original error.
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DocsError'
    this.code = options.code ?? DOCS_ERROR.UPSTREAM
    if (options.platform !== undefined) this.platform = options.platform
    if (options.hint !== undefined) this.hint = options.hint
    this.retryable = options.retryable === true
    if (options.details !== undefined) this.details = options.details
  }

  /** Render the failure for a tool result: code, message, then the hint. */
  toModelMessage() {
    const head = `[${this.code}] ${this.message}`
    return this.hint === undefined ? head : `${head}\nNext: ${this.hint}`
  }

  /** JSON-safe wire form (never contains secrets). */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.platform === undefined ? {} : { platform: this.platform }),
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

/**
 * Coerce an arbitrary thrown value into a {@link DocsError}.
 * @param {unknown} error - thrown value.
 * @param {object} [fallback] - code/platform/hint applied to unknown errors.
 * @returns {DocsError}
 */
export function asDocsError(error, fallback = {}) {
  if (error instanceof DocsError) return error
  const message = error instanceof Error ? error.message : String(error)
  const cancelled = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')
  return new DocsError(message || 'document operation failed', {
    code: cancelled ? DOCS_ERROR.CANCELLED : fallback.code ?? DOCS_ERROR.UPSTREAM,
    platform: fallback.platform,
    hint: cancelled ? 'The call was cancelled; retry when the caller is ready.' : fallback.hint,
    retryable: !cancelled && fallback.retryable === true,
    cause: error,
  })
}

/**
 * Throw a {@link DocsError} when a required string is missing or blank.
 * @param {unknown} value - candidate.
 * @param {string} name - argument name used in the message.
 * @param {object} [options] - `allowEmpty` accepts `''`.
 * @returns {string} the trimmed string.
 */
export function requireString(value, name, options = {}) {
  if (typeof value !== 'string') {
    throw new DocsError(`${name} must be a string`, {
      code: DOCS_ERROR.INVALID_INPUT,
      hint: `Provide ${name} as a plain string.`,
    })
  }
  if (!options.allowEmpty && value.trim().length === 0) {
    throw new DocsError(`${name} must not be empty`, {
      code: DOCS_ERROR.INVALID_INPUT,
      hint: `Provide a non-empty ${name}.`,
    })
  }
  return options.allowEmpty ? value : value.trim()
}

/**
 * Throw a {@link DocsError} when a boolean flag has the wrong type.
 * @param {unknown} value - candidate.
 * @param {string} name - argument name.
 * @param {boolean} fallback - value used when `undefined`.
 * @returns {boolean}
 */
export function optionalBoolean(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new DocsError(`${name} must be a boolean`, {
      code: DOCS_ERROR.INVALID_INPUT,
      hint: `Pass ${name} as true or false.`,
    })
  }
  return value
}
