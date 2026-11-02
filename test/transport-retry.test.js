import test from 'node:test'
import assert from 'node:assert/strict'
import { GoogleApi } from '../lib/adapters/google/client.js'
import { resolveGoogleConfig } from '../lib/adapters/google/config.js'
import { DOCS_ERROR, DocsError } from '../lib/core/errors.js'

function makeApi(fetchImpl, overrides = {}) {
  const config = resolveGoogleConfig({
    clientId: 'test-client',
    maxRetries: 2,
    timeoutMs: 5000,
    ...overrides,
  })
  return new GoogleApi({ auth: { accessToken: async () => 'token' }, config, fetchImpl })
}

function phaseError(phase, message = phase) {
  const error = new DocsError(message, { code: DOCS_ERROR.UPSTREAM })
  error.phase = phase
  return error
}

function okResponse() {
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}

test('transport: a write retries a pre-send TLS failure and succeeds', async () => {
  let calls = 0
  const api = makeApi(async () => {
    calls += 1
    if (calls < 3) throw phaseError('tls')
    return okResponse()
  })
  const payload = await api.request({ method: 'POST', path: 'v1/documents/x:batchUpdate', body: {}, write: true })
  assert.deepEqual(payload, {})
  assert.equal(calls, 3)
})

test('transport: exhausted pre-send failures report WRITE_NOT_SENT', async () => {
  let calls = 0
  const api = makeApi(async () => {
    calls += 1
    throw phaseError('connect')
  })
  await assert.rejects(
    api.request({ method: 'POST', path: 'v1/documents/x:batchUpdate', body: {}, write: true }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.WRITE_NOT_SENT)
      assert.equal(error.retryable, true)
      assert.match(error.hint, /retrying is safe/i)
      return true
    },
  )
  assert.equal(calls, 3)
})

test('transport: a lost response is WRITE_RESULT_UNKNOWN and is not retried', async () => {
  let calls = 0
  const api = makeApi(async () => {
    calls += 1
    throw phaseError('request')
  })
  await assert.rejects(
    api.request({ method: 'POST', path: 'v1/documents/x:batchUpdate', body: {}, write: true }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.WRITE_RESULT_UNKNOWN)
      assert.equal(error.retryable, false)
      assert.match(error.hint, /read the document/i)
      return true
    },
  )
  assert.equal(calls, 1)
})

test('transport: reads still retry a lost response', async () => {
  let calls = 0
  const api = makeApi(async () => {
    calls += 1
    if (calls === 1) throw phaseError('request')
    return okResponse()
  })
  const payload = await api.request({ method: 'GET', path: 'v1/documents/x' })
  assert.deepEqual(payload, {})
  assert.equal(calls, 2)
})

test('transport: a direct ECONNREFUSED is treated as not sent, with the API name', async () => {
  const api = makeApi(async () => {
    throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  })
  await assert.rejects(
    api.request({ method: 'POST', base: 'https://sheets.googleapis.com', path: 'v4/spreadsheets/x:batchUpdate', body: {}, write: true }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.WRITE_NOT_SENT)
      assert.match(error.message, /Google Sheets/)
      return true
    },
  )
})


test('transport: an exhausted 5xx write is WRITE_RESULT_UNKNOWN', async () => {
  let calls = 0
  const api = makeApi(async () => {
    calls += 1
    return new Response(JSON.stringify({ error: { message: 'backend unavailable' } }), { status: 500 })
  })
  await assert.rejects(
    api.request({ method: 'POST', path: 'v1/documents/x:batchUpdate', body: {}, write: true }),
    (error) => {
      assert.equal(error.code, DOCS_ERROR.WRITE_RESULT_UNKNOWN)
      assert.equal(error.retryable, false)
      return true
    },
  )
  assert.equal(calls, 2)
})
