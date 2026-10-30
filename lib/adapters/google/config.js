/**
 * Google Docs adapter configuration.
 *
 * Secrets stay out of the row config when possible: `clientSecretRef` names a
 * credential reference resolved through `ctx.credentials` (or the process
 * environment). `clientSecret` exists for harnesses without a credential
 * store but is discouraged and never logged.
 * @module @local/docs-connector/adapters/google/config
 */
import { DOCS_ERROR, DocsError } from '../../core/errors.js'

/** Required scope for create/edit; the read-only variant is suggested in errors. */
export const DOCUMENTS_SCOPE = 'https://www.googleapis.com/auth/documents'
export const DOCUMENTS_READONLY_SCOPE = 'https://www.googleapis.com/auth/documents.readonly'

/** Defaults applied to an empty adapter row. */
export const GOOGLE_DEFAULT_CONFIG = Object.freeze({
  clientId: '',
  clientSecretRef: 'GOOGLE_DOCS_CLIENT_SECRET',
  clientSecret: '',
  scopes: [DOCUMENTS_SCOPE],
  account: 'default',
  redirectPort: 0,
  redirectPath: '/',
  redirectUri: '',
  autoOpenBrowser: true,
  prompt: 'consent',
  includeGrantedScopes: true,
  timeoutMs: 30000,
  maxRetries: 2,
  guardWrites: true,
  refreshRevisionAfterWrite: true,
  allowRawActions: false,
  proxy: '',
  proxyFromEnv: true,
  proxyBypass: [],
  apiBase: 'https://docs.googleapis.com',
  authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revokeEndpoint: 'https://oauth2.googleapis.com/revoke',
})

/**
 * Validate and default the Google adapter row.
 * @param {unknown} raw - row config.
 * @returns {typeof GOOGLE_DEFAULT_CONFIG & { scopes: string[] }} resolved config.
 */
export function resolveGoogleConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {}
  const config = { ...GOOGLE_DEFAULT_CONFIG }
  for (const key of ['clientId', 'clientSecret', 'clientSecretRef', 'redirectUri', 'prompt', 'apiBase', 'authEndpoint', 'tokenEndpoint', 'revokeEndpoint', 'account', 'proxy']) {
    if (typeof input[key] === 'string') config[key] = input[key].trim()
  }
  if (typeof input.proxyFromEnv === 'boolean') config.proxyFromEnv = input.proxyFromEnv
  if (Array.isArray(input.proxyBypass)) config.proxyBypass = input.proxyBypass.filter((host) => typeof host === 'string')
  if (typeof input.redirectPath === 'string') config.redirectPath = input.redirectPath.startsWith('/') ? input.redirectPath : `/${input.redirectPath}`
  if (Array.isArray(input.scopes) && input.scopes.length > 0 && input.scopes.every((scope) => typeof scope === 'string' && scope.includes('/'))) {
    config.scopes = [...new Set(input.scopes)]
  }
  if (input.autoOpenBrowser !== undefined) config.autoOpenBrowser = input.autoOpenBrowser !== false
  if (input.guardWrites !== undefined) config.guardWrites = input.guardWrites !== false
  if (input.refreshRevisionAfterWrite !== undefined) config.refreshRevisionAfterWrite = input.refreshRevisionAfterWrite !== false
  if (input.allowRawActions !== undefined) config.allowRawActions = input.allowRawActions === true
  if (input.includeGrantedScopes !== undefined) config.includeGrantedScopes = input.includeGrantedScopes !== false
  const port = Number(input.redirectPort ?? config.redirectPort)
  config.redirectPort = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0
  for (const key of ['timeoutMs', 'maxRetries']) {
    const value = Number(input[key] ?? config[key])
    config[key] = Number.isFinite(value) && value >= 0 ? Math.trunc(value) : GOOGLE_DEFAULT_CONFIG[key]
  }
  if (config.maxRetries > 5) config.maxRetries = 5
  if (config.timeoutMs < 1000) config.timeoutMs = 1000
  if (!/^https?:\/\//.test(config.apiBase)) config.apiBase = GOOGLE_DEFAULT_CONFIG.apiBase
  return config
}

/**
 * Validate an account label (it becomes a credential-record segment).
 * @param {unknown} account - candidate.
 * @returns {string} normalized account.
 */
export function normalizeAccount(account) {
  const value = typeof account === 'string' && account.trim().length > 0 ? account.trim().toLowerCase() : 'default'
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(value)) {
    throw new DocsError(`invalid account label "${account}"`, {
      code: DOCS_ERROR.INVALID_INPUT,
      platform: 'google-docs',
      hint: 'Use lowercase letters, digits, and hyphens; start with a letter.',
    })
  }
  return value
}
