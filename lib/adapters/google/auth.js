/**
 * Google OAuth 2.0 authorization-code flow with PKCE and a loopback redirect.
 *
 * Design notes:
 * - The refresh token lives in the credential store as a `grant` record, one
 *   per local account label; it never enters configuration or logs.
 * - Refresh runs inside `modifyRecord`, the seam's read-decide-replace lock,
 *   so two harness processes cannot rotate the same refresh token at once.
 * - The loopback server binds 127.0.0.1 only and accepts exactly one state.
 * - A `refresh_token` is not guaranteed on every exchange; an absent field
 *   never overwrites the saved one.
 * @module @local/docs-connector/adapters/google/auth
 */
import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { DOCS_ERROR, DocsError } from '../../core/errors.js'
import { normalizeAccount } from './config.js'

/** How long one pending authorization stays usable. */
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000
/** Refresh an access token this long before it actually expires. */
const EXPIRY_SKEW_MS = 60 * 1000
/** Credential-record scope. Must match the lowercase-hyphenated plugin name. */
const RECORD_SCOPE = 'docs-connector'
/** Record holding non-secret adapter settings (the public OAuth client id). */
const CONFIG_RECORD = `${RECORD_SCOPE}/google-docs-config`

/**
 * @typedef {object} PendingFlow
 * @property {string} account
 * @property {string} state
 * @property {string} verifier
 * @property {string} redirectUri
 * @property {import('node:http').Server} server
 * @property {NodeJS.Timeout} [timer]
 * @property {boolean} settled
 * @property {string} [detail]
 */

/** PKCE verifier + S256 challenge. */
export function createPkce() {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
  return { verifier, challenge }
}

/** Constant-time string comparison with length safety. */
function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Minimal, CSP-locked HTML page for the redirect target. */
function htmlPage(title, message, status = 200) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.25rem;line-height:1.6"><h1 style="font-size:1.4rem">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'referrer-policy': 'no-referrer',
    },
    body,
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character])
}

/**
 * Read one JSON token response, tolerating a plain-text body.
 * @param {Response} response - token endpoint response.
 * @returns {Promise<object>} parsed payload (empty object when unparsable).
 */
async function readJson(response) {
  const text = await response.text()
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return { raw: text.slice(0, 500) }
  }
}

/** Build a combined cancellation signal for one HTTP call. */
function callSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(Math.max(1000, timeoutMs))
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

export class GoogleAuth {
  /**
   * @param {object} options
   * @param {import('@deepseek-ai/cordis').Context} options.ctx - context for `ctx.get('credentials')`.
   * @param {ReturnType<import('./config.js').resolveGoogleConfig>} options.config - resolved adapter config.
   * @param {typeof fetch} [options.fetchImpl] - fetch override (tests).
   * @param {object} [options.logger] - optional logger.
   * @param {(url: string) => boolean} [options.opener] - browser opener override.
   */
  constructor({ ctx, config, fetchImpl = globalThis.fetch, logger, opener }) {
    this.ctx = ctx
    this.config = config
    this.fetch = fetchImpl
    this.logger = logger
    this.opener = opener
    /** @type {Map<string, PendingFlow>} */
    this.pending = new Map()
    /** Last authorization failure per account, surfaced by status(). */
    this.lastErrors = new Map()
  }

  /** Credential service, when the composition provides one. */
  credentials() {
    try {
      return this.ctx.get('credentials', false)
    } catch {
      return undefined
    }
  }

  /** Deterministic credential-record key for an account. */
  recordKey(account) {
    return `${RECORD_SCOPE}/google-docs-${normalizeAccount(account)}`
  }

  /** Resolve a credential reference or ambient environment variable. */
  async resolveReference(reference) {
    if (typeof reference !== 'string' || reference.length === 0) return undefined
    const credentials = this.credentials()
    if (credentials !== undefined) {
      try {
        const hit = await credentials.resolve(reference)
        if (typeof hit?.value === 'string' && hit.value.length > 0) return hit.value
      } catch {
        // Fall through to the process environment; an invalid reference is not fatal.
      }
    }
    const ambient = process.env[reference]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }

  /**
   * Current OAuth client id.
   *
   * Order: row config, credential reference/environment, then the non-secret
   * record written by a previous `docs_connect({ clientId })`. A client id is
   * public data, so it may travel through the conversation; a client secret
   * may not and is never persisted by this adapter.
   */
  async clientId() {
    if (this.config.clientId) return this.config.clientId
    const referenced = await this.resolveReference('GOOGLE_DOCS_CLIENT_ID')
    if (referenced) return referenced
    const credentials = this.credentials()
    if (credentials !== undefined) {
      try {
        const record = await credentials.readRecord(CONFIG_RECORD)
        const stored = record?.kind === 'grant' && typeof record.payload?.clientId === 'string' ? record.payload.clientId : ''
        if (stored.length > 0) return stored
      } catch {
        // Treat an unreadable settings record as absent.
      }
    }
    return ''
  }

  /** Remember a public client id supplied through the connect tool. */
  async rememberClientId(clientId) {
    const credentials = this.credentials()
    if (credentials === undefined || clientId.length === 0) return
    await credentials.modifyRecord(CONFIG_RECORD, async (current) => ({
      kind: 'grant',
      payload: {
        ...(current?.kind === 'grant' && current.payload !== null && typeof current.payload === 'object' ? current.payload : {}),
        clientId,
        updatedAt: new Date().toISOString(),
      },
    }))
  }

  /** Current OAuth client secret, if the client type needs one. */
  async clientSecret() {
    return this.config.clientSecret || (await this.resolveReference(this.config.clientSecretRef)) || ''
  }

  /** Reject misconfiguration before opening a browser. */
  async requireClientId() {
    const clientId = await this.clientId()
    if (clientId.length === 0) {
      throw new DocsError('Google OAuth client id is not configured', {
        code: DOCS_ERROR.NOT_CONFIGURED,
        platform: 'google-docs',
        hint: 'Call docs_connect with the public clientId of a "Desktop app" OAuth client (safe to share), or set clientId on the docs-connector-google row / GOOGLE_DOCS_CLIENT_ID.',
      })
    }
    if (this.credentials() === undefined) {
      throw new DocsError('the credential store is unavailable; Google tokens cannot be saved', {
        code: DOCS_ERROR.NOT_CONFIGURED,
        platform: 'google-docs',
        hint: 'Load @deepseek-ai/dsh-credentials-local in the composition.',
      })
    }
    return clientId
  }

  /**
   * Saved authorization state for an account.
   * @param {object} request - `{ account? }`.
   * @returns {Promise<{ connected: boolean, account: string, expiresAt?: number, detail?: string }>}
   */
  async status({ account } = {}) {
    const normalized = normalizeAccount(account ?? this.config.account)
    const credentials = this.credentials()
    if (credentials === undefined) {
      return { connected: false, account: normalized, detail: 'credential store unavailable' }
    }
    const record = await credentials.readRecord(this.recordKey(normalized))
    const payload = record?.kind === 'grant' && record.payload !== null && typeof record.payload === 'object' ? record.payload : undefined
    if (payload === undefined) {
      const detail = this.lastErrors.get(normalized)
      return { connected: false, account: normalized, ...(detail === undefined ? {} : { detail }) }
    }
    const expiresAt = Number.isFinite(payload.expiresAt) ? payload.expiresAt : undefined
    const usableAccess = typeof payload.accessToken === 'string' && payload.accessToken.length > 0 && expiresAt !== undefined && expiresAt > Date.now()
    const refreshable = typeof payload.refreshToken === 'string' && payload.refreshToken.length > 0
    if (refreshable) {
      return {
        connected: true,
        account: normalized,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      }
    }
    if (usableAccess) return { connected: true, account: normalized, ...(expiresAt === undefined ? {} : { expiresAt }) }
    return {
      connected: false,
      account: normalized,
      detail: 'the saved access token expired and no refresh token is available',
    }
  }

  /**
   * Start a fresh authorization flow. Returns immediately with the URL.
   * @param {object} request - `{ account?, signal? }`.
   * @returns {Promise<{ url: string, account: string, expiresAt: number }>}
   */
  async start({ account, clientId: providedClientId, signal } = {}) {
    const normalized = normalizeAccount(account ?? this.config.account)
    if (typeof providedClientId === 'string' && providedClientId.trim().length > 0) {
      await this.rememberClientId(providedClientId.trim())
    }
    const clientId = await this.requireClientId()
    this.closeFlow(normalized)
    const returned = await this.listen()
    const { server, port, redirectUri } = returned
    const { verifier, challenge } = createPkce()
    const state = randomBytes(32).toString('base64url')
    /** @type {PendingFlow} */
    const flow = { account: normalized, state, verifier, redirectUri, server, settled: false }
    server.on('request', (request, response) => {
      this.handleCallback(flow, request, response)
    })
    this.pending.set(normalized, flow)
    flow.timer = setTimeout(() => {
      if (flow.settled) return
      flow.detail = 'authorization timed out'
      this.lastErrors.set(normalized, flow.detail)
      this.closeFlow(normalized)
    }, AUTHORIZATION_TTL_MS)
    flow.timer.unref?.()
    let url
    try {
      url = this.buildAuthUrl({ clientId, redirectUri, state, challenge })
    } catch (error) {
      this.closeFlow(normalized)
      throw error
    }
    if (this.config.autoOpenBrowser && typeof this.opener === 'function') {
      try {
        this.opener(url)
      } catch (error) {
        this.logger?.warn?.('could not open the browser:', error instanceof Error ? error.message : error)
      }
    }
    if (signal?.aborted) {
      this.closeFlow(normalized)
      throw new DocsError('authorization cancelled', { code: DOCS_ERROR.CANCELLED, platform: 'google-docs' })
    }
    this.logger?.info?.(`google-docs: authorization started for account ${normalized} on port ${port}`)
    return { url, account: normalized, expiresAt: Date.now() + AUTHORIZATION_TTL_MS }
  }

  /** Bind the loopback callback server and compute the exact redirect URI. */
  async listen() {
    const explicit = this.config.redirectUri
    let host = '127.0.0.1'
    let port = this.config.redirectPort
    let path = this.config.redirectPath
    if (explicit.length > 0) {
      let parsed
      try {
        parsed = new URL(explicit)
      } catch {
        throw new DocsError('redirectUri is not a valid URL', {
          code: DOCS_ERROR.NOT_CONFIGURED,
          platform: 'google-docs',
          hint: 'Use an absolute http://127.0.0.1:<port>/... redirect URI.',
        })
      }
      if (parsed.protocol !== 'http:') {
        throw new DocsError('the loopback listener only accepts http redirect URIs', {
          code: DOCS_ERROR.NOT_CONFIGURED,
          platform: 'google-docs',
          hint: 'Use http://127.0.0.1:<port>/... ; the listener terminates plain HTTP locally.',
        })
      }
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname)) {
        throw new DocsError('only loopback redirect URIs can be served by this harness', {
          code: DOCS_ERROR.NOT_CONFIGURED,
          platform: 'google-docs',
          hint: 'Set redirectUri to http://127.0.0.1:<port>/... or run the harness on the machine where the browser completes authorization.',
        })
      }
      host = parsed.hostname === 'localhost' ? '127.0.0.1' : parsed.hostname.replace(/^\[|\]$/g, '')
      port = parsed.port === '' ? 80 : Number(parsed.port)
      path = parsed.pathname
    }
    const server = createServer()
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        reject(new DocsError(`cannot start the OAuth loopback listener on ${host}:${port}`, {
          code: DOCS_ERROR.NOT_CONFIGURED,
          platform: 'google-docs',
          hint: error?.code === 'EADDRINUSE'
            ? 'That port is busy; set redirectPort to 0 for an automatic port, or pick another fixed port.'
            : 'Check that the harness may bind a loopback port.',
          cause: error,
        }))
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ host, port })
    })
    const address = server.address()
    const actualPort = typeof address === 'object' && address !== null ? address.port : port
    server.on('error', (error) => {
      this.logger?.warn?.('OAuth loopback listener failed:', error instanceof Error ? error.message : error)
    })
    const redirectUri = explicit.length > 0 ? explicit : `http://127.0.0.1:${actualPort}${path}`
    return { server, port: actualPort, redirectUri }
  }

  /** Build the Google authorization URL. */
  buildAuthUrl({ clientId, redirectUri, state, challenge }) {
    const url = new URL(this.config.authEndpoint)
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', this.config.scopes.join(' '))
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('access_type', 'offline')
    if (this.config.prompt.length > 0) url.searchParams.set('prompt', this.config.prompt)
    if (this.config.includeGrantedScopes) url.searchParams.set('include_granted_scopes', 'true')
    return url.toString()
  }

  /** Handle one loopback callback. Runs asynchronously; errors are answered, never thrown. */
  async handleCallback(flow, request, response) {
    const send = (page, after) => {
      if (response.writableEnded) {
        after?.()
        return
      }
      response.writeHead(page.status, page.headers)
      response.end(page.body, after)
    }
    try {
      if (request.method !== 'GET') {
        send(htmlPage('Method not allowed', 'The OAuth callback only accepts GET.', 405))
        return
      }
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${flow.server.address()?.port ?? 80}`)
      const expectedPath = new URL(flow.redirectUri).pathname
      if (url.pathname !== expectedPath) {
        send(htmlPage('Not found', 'This path is not the OAuth callback.', 404))
        return
      }
      const error = url.searchParams.get('error')
      if (error !== null) {
        flow.detail = url.searchParams.get('error_description') ?? error
        this.lastErrors.set(flow.account, flow.detail)
        send(htmlPage('Authorization cancelled', 'Google reported that authorization did not complete. Return to DeepSeek Harness for details.', 400), () => this.closeFlow(flow.account))
        return
      }
      const state = url.searchParams.get('state')
      if (state === null || !safeEqual(state, flow.state)) {
        this.logger?.warn?.('google-docs: rejected an OAuth callback with a mismatched state')
        send(htmlPage('Invalid state', 'The authorization response did not match this request. Start again from DeepSeek Harness.', 400))
        return
      }
      const code = url.searchParams.get('code')
      if (code === null || code.length === 0) {
        send(htmlPage('Missing code', 'The authorization response carried no code.', 400))
        return
      }
      await this.exchangeCode(flow, code)
      flow.settled = true
      this.lastErrors.delete(flow.account)
      send(htmlPage('Authorization complete', 'You can close this window and return to DeepSeek Harness.'), () => this.closeFlow(flow.account))
    } catch (error) {
      flow.detail = error instanceof DocsError ? error.message : error instanceof Error ? error.message : String(error)
      this.lastErrors.set(flow.account, flow.detail)
      this.logger?.warn?.('google-docs: authorization failed:', flow.detail)
      send(htmlPage('Authorization failed', `Google authorization did not complete: ${flow.detail}`, 500), () => this.closeFlow(flow.account))
    }
  }

  /** Exchange an authorization code and persist the grant. */
  async exchangeCode(flow, code) {
    const clientId = await this.requireClientId()
    const secret = await this.clientSecret()
    const form = new URLSearchParams({
      code,
      client_id: clientId,
      redirect_uri: flow.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: flow.verifier,
    })
    if (secret.length > 0) form.set('client_secret', secret)
    const response = await this.fetch(this.config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: callSignal(Math.min(this.config.timeoutMs, 15000)),
    })
    const payload = await readJson(response)
    if (!response.ok || typeof payload.access_token !== 'string' || payload.access_token.length === 0) {
      const reason = payload.error_description ?? payload.error ?? `HTTP ${response.status}`
      throw new DocsError(`Google rejected the authorization code: ${reason}`, {
        code: DOCS_ERROR.AUTH_FAILED,
        platform: 'google-docs',
        hint: 'Check that the OAuth client allows this redirect URI, then run docs_connect again.',
      })
    }
    const account = flow.account
    await this.storeTokens(account, payload, clientId, 'authorization')
    this.logger?.info?.(`google-docs: authorization completed for account ${account}`)
  }

  /** Merge a token response into the credential record without dropping a saved refresh token. */
  async storeTokens(account, tokens, clientId, source) {
    const credentials = this.credentials()
    if (credentials === undefined) {
      throw new DocsError('the credential store is unavailable; Google tokens cannot be saved', {
        code: DOCS_ERROR.NOT_CONFIGURED,
        platform: 'google-docs',
      })
    }
    const key = this.recordKey(account)
    const expiresIn = Number(tokens.expires_in)
    await credentials.modifyRecord(key, async (current) => {
      const previous = current?.kind === 'grant' && current.payload !== null && typeof current.payload === 'object' ? current.payload : {}
      const refreshToken = typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0
        ? tokens.refresh_token
        : previous.refreshToken
      return {
        kind: 'grant',
        payload: {
          version: 1,
          accessToken: tokens.access_token,
          ...(typeof refreshToken === 'string' && refreshToken.length > 0 ? { refreshToken } : {}),
          ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
          ...(typeof tokens.scope === 'string' ? { scope: tokens.scope } : {}),
          ...(typeof tokens.token_type === 'string' ? { tokenType: tokens.token_type } : {}),
          clientId,
          account,
          source,
          obtainedAt: previous.obtainedAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }
    })
  }

  /**
   * Return a usable access token, refreshing it when expired.
   * @param {string} account - account label.
   * @param {object} [options] - `{ force?, signal? }`.
   * @returns {Promise<string>} bearer token.
   */
  async accessToken(account, { force = false, signal } = {}) {
    const normalized = normalizeAccount(account ?? this.config.account)
    const credentials = this.credentials()
    if (credentials === undefined) {
      throw new DocsError('the credential store is unavailable', {
        code: DOCS_ERROR.NOT_CONFIGURED,
        platform: 'google-docs',
      })
    }
    const key = this.recordKey(normalized)
    const record = await credentials.readRecord(key)
    const payload = record?.kind === 'grant' && record.payload !== null && typeof record.payload === 'object' ? record.payload : undefined
    if (payload === undefined) {
      throw new DocsError('Google Docs is not authorized for this account', {
        code: DOCS_ERROR.AUTH_REQUIRED,
        platform: 'google-docs',
        hint: 'Call docs_connect and have the user approve the authorization URL.',
      })
    }
    if (!force && typeof payload.accessToken === 'string' && Number.isFinite(payload.expiresAt) && payload.expiresAt > Date.now() + EXPIRY_SKEW_MS) {
      return payload.accessToken
    }
    let refreshedToken
    await credentials.modifyRecord(key, async (current) => {
      const state = current?.kind === 'grant' && current.payload !== null && typeof current.payload === 'object' ? current.payload : undefined
      if (state === undefined) {
        throw new DocsError('Google Docs authorization disappeared during refresh', {
          code: DOCS_ERROR.AUTH_REQUIRED,
          platform: 'google-docs',
          hint: 'Call docs_connect to authorize again.',
        })
      }
      if (!force && typeof state.accessToken === 'string' && Number.isFinite(state.expiresAt) && state.expiresAt > Date.now() + EXPIRY_SKEW_MS) {
        refreshedToken = state.accessToken
        return undefined
      }
      if (typeof state.refreshToken !== 'string' || state.refreshToken.length === 0) {
        throw new DocsError('the saved Google authorization has no refresh token', {
          code: DOCS_ERROR.AUTH_REQUIRED,
          platform: 'google-docs',
          hint: 'Call docs_connect with force: true to obtain a refresh token.',
        })
      }
      const tokens = await this.refresh(state, signal)
      const expiresIn = Number(tokens.expires_in)
      refreshedToken = tokens.access_token
      return {
        kind: 'grant',
        payload: {
          ...state,
          accessToken: tokens.access_token,
          ...(typeof tokens.refresh_token === 'string' && tokens.refresh_token.length > 0 ? { refreshToken: tokens.refresh_token } : {}),
          ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
          ...(typeof tokens.scope === 'string' ? { scope: tokens.scope } : {}),
          refreshedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }
    })
    if (typeof refreshedToken !== 'string' || refreshedToken.length === 0) {
      throw new DocsError('Google access token refresh produced no token', {
        code: DOCS_ERROR.AUTH_REQUIRED,
        platform: 'google-docs',
        hint: 'Call docs_connect to authorize again.',
      })
    }
    return refreshedToken
  }

  /** Exchange a refresh token for a new access token. */
  async refresh(payload, signal) {
    const clientId = payload.clientId || (await this.requireClientId())
    const secret = await this.clientSecret()
    const form = new URLSearchParams({
      client_id: clientId,
      refresh_token: payload.refreshToken,
      grant_type: 'refresh_token',
    })
    if (secret.length > 0) form.set('client_secret', secret)
    let response
    try {
      for (let attempt = 0; ; attempt++) {
        response = await this.fetch(this.config.tokenEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: form.toString(),
          signal: callSignal(Math.min(this.config.timeoutMs, 15000), signal),
        })
        if ((response.status === 429 || response.status >= 500) && attempt < 1) {
          await new Promise((resolve) => setTimeout(resolve, 300))
          continue
        }
        break
      }
    } catch (error) {
      if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
        throw new DocsError('timed out refreshing the Google access token', {
          code: DOCS_ERROR.UPSTREAM,
          platform: 'google-docs',
          retryable: true,
          cause: error,
        })
      }
      throw new DocsError(`cannot reach Google's token endpoint: ${error instanceof Error ? error.message : error}`, {
        code: DOCS_ERROR.UPSTREAM,
        platform: 'google-docs',
        retryable: true,
        cause: error,
      })
    }
    const body = await readJson(response)
    if (response.ok && typeof body.access_token === 'string' && body.access_token.length > 0) return body
    const reason = body.error_description ?? body.error ?? `HTTP ${response.status}`
    if (body.error === 'invalid_client') {
      throw new DocsError(`Google rejected the OAuth client credentials: ${reason}`, {
        code: DOCS_ERROR.NOT_CONFIGURED,
        platform: 'google-docs',
        hint: 'Check clientId and the client secret reference (GOOGLE_DOCS_CLIENT_SECRET), then authorize again.',
      })
    }
    if (body.error === 'invalid_grant' || response.status === 400 || response.status === 401) {
      throw new DocsError(`Google refused to refresh the access token: ${reason}`, {
        code: DOCS_ERROR.AUTH_REQUIRED,
        platform: 'google-docs',
        hint: 'The authorization was revoked or expired; call docs_connect to authorize again.',
      })
    }
    throw new DocsError(`Google token refresh failed: ${reason}`, {
      code: DOCS_ERROR.UPSTREAM,
      platform: 'google-docs',
      retryable: response.status >= 500 || response.status === 429,
    })
  }

  /** Forget the saved grant (best-effort Google revoke) and close pending flows. */
  async disconnect({ account } = {}) {
    const normalized = normalizeAccount(account ?? this.config.account)
    this.lastErrors.delete(normalized)
    this.closeFlow(normalized)
    const credentials = this.credentials()
    if (credentials === undefined) return
    const key = this.recordKey(normalized)
    const record = await credentials.readRecord(key)
    const payload = record?.kind === 'grant' ? record.payload : undefined
    const token = payload?.refreshToken ?? payload?.accessToken
    if (typeof token === 'string' && token.length > 0) {
      try {
        await this.fetch(this.config.revokeEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token }).toString(),
          signal: callSignal(Math.min(this.config.timeoutMs, 10000)),
        })
      } catch {
        // Revocation is best-effort; local deletion is the contract.
      }
    }
    await credentials.deleteRecord(key)
  }

  /** Close one pending flow. */
  closeFlow(account) {
    const flow = this.pending.get(account)
    if (flow === undefined) return
    this.pending.delete(account)
    if (flow.timer !== undefined) clearTimeout(flow.timer)
    try {
      flow.server.close()
      flow.server.closeAllConnections?.()
    } catch {
      // Already closed.
    }
  }

  /** Close every pending flow; called when the plugin unloads. */
  close() {
    for (const account of [...this.pending.keys()]) this.closeFlow(account)
  }
}
