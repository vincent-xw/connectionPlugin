import test from 'node:test'
import assert from 'node:assert/strict'
import { GoogleAuth } from '../lib/adapters/google/auth.js'
import { resolveGoogleConfig } from '../lib/adapters/google/config.js'
import { MemoryCredentials, fakeContext } from './support/memory-credentials.js'
import { DOCS_ERROR, DocsError } from '../lib/core/errors.js'

const KEY = 'docs-connector/google-docs-default'

function seed(credentials) {
  credentials.records.set(KEY, {
    kind: 'grant',
    payload: {
      version: 1,
      accessToken: 'old',
      expiresAt: Date.now() - 1000,
      refreshToken: 'refresh-token',
      clientId: 'client-1',
      account: 'default',
    },
  })
}

function setup(fetchImpl) {
  const credentials = new MemoryCredentials()
  seed(credentials)
  const ctx = fakeContext({ credentials })
  const config = resolveGoogleConfig({
    clientId: 'client-1',
    clientSecret: 'secret-1',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    maxRetries: 2,
    timeoutMs: 5000,
  })
  const auth = new GoogleAuth({ ctx, config, fetchImpl })
  return { credentials, auth }
}

function phaseError(phase) {
  const error = new DocsError('tls reset', { code: DOCS_ERROR.UPSTREAM })
  error.phase = phase
  return error
}

test('auth: a token refresh retries a pre-send TLS reset', async () => {
  let calls = 0
  const { auth, credentials } = setup(async () => {
    calls += 1
    if (calls === 1) throw phaseError('tls')
    return new Response(JSON.stringify({ access_token: 'new', expires_in: 3600, token_type: 'Bearer' }), { status: 200 })
  })
  const token = await auth.accessToken('default')
  assert.equal(token, 'new')
  assert.equal(calls, 2)
  assert.equal(credentials.records.get(KEY).payload.accessToken, 'new')
})

test('auth: exhausted token refresh failures stay UPSTREAM', async () => {
  let calls = 0
  const { auth } = setup(async () => {
    calls += 1
    throw phaseError('connect')
  })
  await assert.rejects(auth.accessToken('default'), (error) => {
    assert.equal(error.code, DOCS_ERROR.UPSTREAM)
    assert.match(error.message, /token endpoint/)
    return true
  })
  assert.equal(calls, 3)
})
