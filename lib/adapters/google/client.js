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
    if (reason === 'accessNotConfigured' || /has not been used in project|API is disabled|it is disabled/i.test(String(message))) {
      return new DocsError(`the Google API is not enabled for this project: ${message}`, {
        code: DOCS_ERROR.NOT_CONFIGURED,
        platform: 'google-docs',
        hint: 'Enable the API in Google Cloud Console (Google Docs API for read/write, Google Drive API for docs_list), wait a minute for propagation, then retry.',
        details,
      })
    }
    if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'quotaExceeded') {
      return new DocsError(`Google rate limit reached: ${message}`, {
        code: DOCS_ERROR.RATE_LIMITED,
        platform: 'google-docs',
        retryable: true,
        hint: 'Wait, then retry with a lower call rate.',
        details,
      })
    }
    const scopeProblem = reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || /scope/i.test(String(message))
    return new DocsError(`Google denied access: ${message}`, {
      code: DOCS_ERROR.FORBIDDEN,
      platform: 'google-docs',
      hint: scopeProblem
        ? 'The authorization lacks a required Google scope (documents for Docs, spreadsheets for Sheets, presentations for Slides, drive.metadata.readonly for listing); call docs_connect with force: true and approve the requested scopes.'
        : 'Confirm the document is shared with the authorized Google account and that the account may edit it.',
      details,
    })
  }
  if (status === 404) {
    return new DocsError('Google Docs could not find the document', {
      code: DOCS_ERROR.NOT_FOUND,
      platform: 'google-docs',
      hint: 'Check the document id and the authorized account; a 404 can also mean the document is not visible to it. A Google Sheet or Slides id always 404s here because the Docs API only serves Docs documents; use docs_list with type "spreadsheet" or "presentation" to confirm the kind.',
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
  url(path, query, base) {
    const root = (base ?? this.config.apiBase).replace(/\/$/, '')
    const url = new URL(path, `${root}/`)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue
      // Repeated query parameters (Sheets `ranges`) must stay separate keys.
      if (Array.isArray(value)) {
        for (const item of value) url.searchParams.append(key, String(item))
      } else {
        url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  /**
   * Issue one authenticated request with 401-refresh and bounded retries.
   * @param {object} request - `{ method, path, query?, body?, account, signal?, write?, base? }`.
   * @returns {Promise<object>} parsed JSON payload.
   */
  async request(request) {
    const { method, path, query, body, account, signal, write = false, base } = request
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
        response = await this.fetch(this.url(path, query, base), {
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

  /**
   * `files.list` on the Drive API (metadata only).
   *
   * Drive is a separate host from the Docs API, so the call takes an explicit
   * base URL. Only the fields the connector renders are requested; that keeps
   * the response small and matches the `drive.metadata.readonly` grant.
   */
  async listFiles({ query, pageSize, pageToken, orderBy = 'modifiedTime desc', account, signal } = {}) {
    return this.request({
      method: 'GET',
      base: this.config.driveApiBase,
      path: 'drive/v3/files',
      query: {
        q: query,
        pageSize,
        pageToken,
        orderBy,
        fields: 'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)',
        spaces: 'drive',
        includeItemsFromAllDrives: 'true',
        supportsAllDrives: 'true',
      },
      account,
      signal,
    })
  }

  /**
   * `files.get` metadata: the authority for an id's kind.
   *
   * Bare ids carry no type, and a URL may be pasted from anywhere, so every
   * read resolves the kind here before choosing an API. Metadata-only fields
   * keep this inside `drive.metadata.readonly`.
   */
  async getFileMetadata(documentId, { account, signal } = {}) {
    return this.request({
      method: 'GET',
      base: this.config.driveApiBase,
      path: `drive/v3/files/${encodeURIComponent(documentId)}`,
      query: { fields: 'id,name,mimeType,modifiedTime,trashed' },
      account,
      signal,
    })
  }

  /** `spreadsheets.get` structure only; cell values come from {@link getValues}. */
  async getSpreadsheet(documentId, { account, signal } = {}) {
    return this.request({
      method: 'GET',
      base: this.config.sheetsApiBase,
      path: `v4/spreadsheets/${encodeURIComponent(documentId)}`,
      query: {
        includeGridData: 'false',
        fields: 'spreadsheetId,properties.title,sheets.properties(sheetId,title,index,gridProperties)',
      },
      account,
      signal,
    })
  }

  /** `spreadsheets.values.batchGet`. `ranges` may be repeated. */
  async getValues(documentId, ranges, { majorDimension = 'ROWS', valueRenderOption = 'FORMATTED_VALUE', account, signal } = {}) {
    return this.request({
      method: 'GET',
      base: this.config.sheetsApiBase,
      path: `v4/spreadsheets/${encodeURIComponent(documentId)}/values:batchGet`,
      query: { ranges, majorDimension, valueRenderOption },
      account,
      signal,
    })
  }

  /**
   * `spreadsheets.create`: a new spreadsheet, optionally with named sheets and
   * their grid sizes. Values are written afterwards by {@link batchUpdateValues}.
   */
  async createSpreadsheet(body, { account, signal } = {}) {
    return this.request({
      method: 'POST',
      base: this.config.sheetsApiBase,
      path: 'v4/spreadsheets',
      body,
      account,
      signal,
      write: true,
    })
  }

  /** `spreadsheets.values.batchUpdate`: write many ranges in one call. */
  async batchUpdateValues(documentId, data, { valueInputOption = 'RAW', account, signal } = {}) {
    return this.request({
      method: 'POST',
      base: this.config.sheetsApiBase,
      path: `v4/spreadsheets/${encodeURIComponent(documentId)}/values:batchUpdate`,
      body: { valueInputOption, data },
      account,
      signal,
      write: true,
    })
  }

  /** `spreadsheets.values.update` on one A1 range. */
  async updateValues(documentId, range, values, { valueInputOption = 'USER_ENTERED', account, signal } = {}) {
    return this.request({
      method: 'PUT',
      base: this.config.sheetsApiBase,
      path: `v4/spreadsheets/${encodeURIComponent(documentId)}/values/${encodeURIComponent(range)}`,
      query: { valueInputOption },
      body: { range, majorDimension: 'ROWS', values },
      account,
      signal,
      write: true,
    })
  }

  /** `spreadsheets.values.append`: add rows after the last row of a range. */
  async appendValues(documentId, range, values, { valueInputOption = 'USER_ENTERED', insertDataOption = 'INSERT_ROWS', account, signal } = {}) {
    return this.request({
      method: 'POST',
      base: this.config.sheetsApiBase,
      path: `v4/spreadsheets/${encodeURIComponent(documentId)}/values/${encodeURIComponent(range)}:append`,
      query: { valueInputOption, insertDataOption },
      body: { majorDimension: 'ROWS', values },
      account,
      signal,
      write: true,
    })
  }

  /** `spreadsheets.batchUpdate`: formatting, merges, dimensions, sheet props. */
  async batchUpdateSpreadsheet(documentId, requests, { account, signal } = {}) {
    return this.request({
      method: 'POST',
      base: this.config.sheetsApiBase,
      path: `v4/spreadsheets/${encodeURIComponent(documentId)}:batchUpdate`,
      body: { requests },
      account,
      signal,
      write: true,
    })
  }

  /** `presentations.get`. */
  async getPresentation(documentId, { account, signal } = {}) {
    return this.request({
      method: 'GET',
      base: this.config.slidesApiBase,
      path: `v1/presentations/${encodeURIComponent(documentId)}`,
      account,
      signal,
    })
  }

  /** `presentations.batchUpdate`. */
  async presentationBatchUpdate(documentId, requests, { account, signal } = {}) {
    return this.request({
      method: 'POST',
      base: this.config.slidesApiBase,
      path: `v1/presentations/${encodeURIComponent(documentId)}:batchUpdate`,
      body: { requests },
      account,
      signal,
      write: true,
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
