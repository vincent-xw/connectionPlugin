/**
 * Google Docs REST client.
 *
 * Owns URL construction, bearer-token injection, retry policy, and the mapping
 * from Google's error payloads to {@link DocsError} codes. It performs no
 * document conversion and no OAuth flow.
 * @module @local/docs-connector/adapters/google/client
 */
import { DOCS_ERROR, DocsError } from '../../core/errors.js'

/** HTTP statuses worth retrying when the request never mutated the document. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/** Sleep with cancellation support. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DocsError('cancelled', { code: DOCS_ERROR.CANCELLED, platform: 'google-docs' }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DocsError('cancelled', { code: DOCS_ERROR.CANCELLED, platform: 'google-docs' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
function retryAfterMs(headers) {
  const value = headers?.get?.('retry-after')
  if (value === null || value === undefined) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30000)
  return undefined
}

/** Read a response body as JSON, tolerating empty and malformed bodies. */
async function parseBody(response) {
  const text = await response.text()
  if (text.length === 0) return {}
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' ? value : { value }
  } catch {
    return { raw: text.slice(0, 1000) }
  }
}

/**
 * Map one Google API failure into the shared error vocabulary.
 * @param {number} status - HTTP status.
 * @param {object} payload - parsed error payload.
 * @param {boolean} write - whether the failed call mutates the document.
 * @returns {DocsError}
 */
export function mapGoogleError(status, payload, write) {
  const message = payload?.error?.message ?? payload?.error_description ?? payload?.message ?? `HTTP ${status}`
  const reason = payload?.error?.errors?.[0]?.reason
  const details = {
    status,
    ...(typeof reason === 'string' ? { reason } : {}),
  }
  if (status === 401) {
    return new DocsError('Google rejected the access token', {
      code: DOCS_ERROR.AUTH_REQUIRED,
      platform: 'google-docs',
      hint: 'The token expired or was revoked; call docs_connect to authorize again.',
      details,
    })
  }
  if (status === 403) {
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'quotaExceeded') {
      return new DocsError(`Google rate limit reached: ${message}`, {
        code: DOCS_ERROR.RATE_LIMITED,
        platform: 'google-docs',
        retryable: true,
        hint: 'Wait, then retry with a lower call rate.',
        details,
      })
    }
    return new DocsError(`Google denied access: ${message}`, {
      code: DOCS_ERROR.FORBIDDEN,
      platform: 'google-docs',
      hint: /scope/i.test(String(message))
        ? 'The authorization lacks the documents scope; call docs_connect with force: true and approve the requested scope.'
        : 'Confirm the document is shared with the authorized Google account and that the account may edit it.',
      details,
    })
  }
  if (status === 404) {
    return new DocsError('Google Docs could not find the document', {
      code: DOCS_ERROR.NOT_FOUND,
      platform: 'google-docs',
      hint: 'Check the document id and the authorized account; a 404 can also mean the document is not visible to it.',
      details,
    })
  }
  if (status === 400) {
    if (/revision/i.test(String(message)) || /write control/i.test(String(message))) {
      return new DocsError(`Google rejected the write because the revision is stale: ${message}`, {
        code: DOCS_ERROR.REVISION_CONFLICT,
        platform: 'google-docs',
        hint: `Read the document again, recompute the edit, and retry with the new expectedRevision.${write ? ' The rejected write was not applied.' : ''}`,
        details,
      })
    }
    return new DocsError(`Google rejected the request: ${message}`, {
      code: DOCS_ERROR.INVALID_INPUT,
      platform: 'google-docs',
      hint: 'Check tab ids, native indexes (UTF-16 code units), and request fields, then retry.',
      details,
    })
  }
  if (status === 429) {
    return new DocsError(`Google rate limit reached: ${message}`, {
      code: DOCS_ERROR.RATE_LIMITED,
      platform: 'google-docs',
      retryable: true,
      hint: 'Wait, then retry with a lower call rate.',
      details,
    })
  }
  return new DocsError(`Google Docs request failed (${status}): ${message}`, {
    code: DOCS_ERROR.UPSTREAM,
    platform: 'google-docs',
    retryable: status >= 500,
    details,
  })
}

export class GoogleApi {
  /**
   * @param {object} options
   * @param {import('./auth.js').GoogleAuth} options.auth - token provider.
   * @param {ReturnType<import('./config.js').resolveGoogleConfig>} options.config - resolved config.
   * @param {typeof fetch} [options.fetchImpl] - fetch override.
   * @param {object} [options.logger] - optional logger.
   */
  constructor({ auth, config, fetchImpl = globalThis.fetch, logger }) {
    this.auth = auth
    this.config = config
    this.fetch = fetchImpl
    this.logger = logger
  }

  /** Build an absolute API URL. */
  url(path, query) {
    const url = new URL(path, `${this.config.apiBase.replace(/\/$/, '')}/`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  /**
   * Issue one authenticated request with 401-refresh and bounded retries.
   * @param {object} request - `{ method, path, query?, body?, account, signal?, write? }`.
   * @returns {Promise<object>} parsed JSON payload.
   */
  async request(request) {
    const { method, path, query, body, account, signal, write = false } = request
    const attempts = write ? Math.min(1, this.config.maxRetries) : this.config.maxRetries
    let refreshed = false
    let lastError
    for (let attempt = 0; attempt <= attempts; attempt++) {
      let token
      try {
        token = await this.auth.accessToken(account, { signal })
      } catch (error) {
        throw error instanceof DocsError ? error : new DocsError(String(error?.message ?? error), {
          code: DOCS_ERROR.AUTH_REQUIRED,
          platform: 'google-docs',
        })
      }
      const timeout = AbortSignal.timeout(this.config.timeoutMs)
      const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      let response
      try {
        response = await this.fetch(this.url(path, query), {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: combined,
        })
      } catch (error) {
        const cancelled = signal?.aborted === true
        const timedOut = error instanceof Error && error.name === 'TimeoutError'
        if (cancelled) throw new DocsError('the Google Docs call was cancelled', {
          code: DOCS_ERROR.CANCELLED,
          platform: 'google-docs',
          cause: error,
        })
        if (!write && attempt < attempts) {
          lastError = error
          await sleep(backoff(attempt), signal)
          continue
        }
        throw new DocsError(timedOut ? 'the Google Docs call timed out' : `cannot reach Google Docs: ${error instanceof Error ? error.message : error}`, {
          code: DOCS_ERROR.UPSTREAM,
          platform: 'google-docs',
          retryable: true,
          hint: write
            ? 'The write may or may not have been applied. Read the document before retrying so content is not duplicated.'
            : 'Retry the read; it is safe to repeat.',
          cause: error,
        })
      }
      if (response.status === 401 && !refreshed) {
        refreshed = true
        try {
          await this.auth.accessToken(account, { force: true, signal })
        } catch (error) {
          throw error instanceof DocsError ? error : new DocsError('Google authorization expired', {
            code: DOCS_ERROR.AUTH_REQUIRED,
            platform: 'google-docs',
            hint: 'Call docs_connect to authorize again.',
            cause: error,
          })
        }
        // Retry immediately with the fresh token; this does not consume a retry.
        attempt -= 1
        continue
      }
      const payload = await parseBody(response)
      if (response.ok) return payload
      const mapped = mapGoogleError(response.status, payload, write)
      if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
        lastError = mapped
        const wait = retryAfterMs(response.headers) ?? backoff(attempt)
        await sleep(wait, signal)
        continue
      }
      throw mapped
    }
    throw lastError instanceof DocsError
      ? lastError
      : new DocsError('Google Docs request failed after retries', {
        code: DOCS_ERROR.UPSTREAM,
        platform: 'google-docs',
        retryable: true,
      })
  }

  /** `documents.get` with tab content enabled. */
  async getDocument(documentId, { account, signal } = {}) {
    return this.request({
      method: 'GET',
      path: `v1/documents/${encodeURIComponent(documentId)}`,
      query: { includeTabsContent: 'true' },
      account,
      signal,
    })
  }

  /** `documents.create` (title only; body needs batchUpdate). */
  async createDocument(title, { account, signal } = {}) {
    return this.request({
      method: 'POST',
      path: 'v1/documents',
      body: { title },
      account,
      signal,
      write: true,
    })
  }

  /** `documents.batchUpdate` with optional revision guard. */
  async batchUpdate(documentId, requests, { account, writeControl, signal } = {}) {
    return this.request({
      method: 'POST',
      path: `v1/documents/${encodeURIComponent(documentId)}:batchUpdate`,
      body: {
        requests,
        ...(writeControl === undefined ? {} : { writeControl }),
      },
      account,
      signal,
      write: true,
    })
  }
}

/** Exponential backoff with jitter. */
function backoff(attempt) {
  const base = Math.min(8000, 400 * 2 ** attempt)
  return Math.round(base * (0.7 + Math.random() * 0.6))
}
