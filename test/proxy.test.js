import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProxy, redactProxy, resolveProxy } from '../lib/adapters/google/proxy-fetch.js'
import { resolveGoogleConfig, GOOGLE_DEFAULT_CONFIG } from '../lib/adapters/google/config.js'

test('parseProxy accepts http, https, and socks5 URLs with credentials', () => {
  assert.deepEqual(parseProxy('http://127.0.0.1:7897'), { protocol: 'http:', host: '127.0.0.1', port: 7897 })
  assert.deepEqual(parseProxy('127.0.0.1:7897'), { protocol: 'http:', host: '127.0.0.1', port: 7897 })
  assert.deepEqual(parseProxy('socks5h://proxy.test:1080'), { protocol: 'socks5:', host: 'proxy.test', port: 1080 })
  assert.deepEqual(parseProxy('https://user:pass@proxy.test'), {
    protocol: 'https:',
    host: 'proxy.test',
    port: 443,
    auth: 'user:pass',
  })
  assert.throws(() => parseProxy('ftp://proxy.test'), /unsupported proxy protocol/)
  assert.throws(() => parseProxy('not a url'), /invalid/)
})

test('redactProxy hides credentials', () => {
  assert.equal(redactProxy('http://user:secret@proxy.test:8080'), 'http://***:***@proxy.test:8080/')
  assert.equal(redactProxy('http://proxy.test:8080'), 'http://proxy.test:8080/')
})

test('resolveProxy honors explicit config, direct, environment, NO_PROXY, and loopback', () => {
  const target = new URL('https://docs.googleapis.com/v1/documents/x')
  assert.equal(resolveProxy(target, { proxy: 'http://127.0.0.1:7897', env: {} }).host, '127.0.0.1')
  assert.equal(resolveProxy(target, { proxy: 'direct', env: { HTTPS_PROXY: 'http://env:1' } }), null)
  assert.equal(resolveProxy(target, { proxy: '', env: { HTTPS_PROXY: 'http://env:1' } }).port, 1)
  assert.equal(resolveProxy(target, { proxy: '', proxyFromEnv: false, env: { HTTPS_PROXY: 'http://env:1' } }), null)
  assert.equal(resolveProxy(target, { proxy: '', env: { HTTPS_PROXY: 'http://env:1', NO_PROXY: '.googleapis.com' } }), null)
  assert.equal(resolveProxy(target, { proxy: '', env: { HTTPS_PROXY: 'http://env:1', NO_PROXY: 'docs.googleapis.com' } }), null)
  assert.equal(resolveProxy(target, { proxy: '', env: { HTTPS_PROXY: 'http://env:1', NO_PROXY: 'example.com' } }).port, 1)
  assert.equal(resolveProxy(new URL('http://127.0.0.1:8080/x'), { proxy: 'http://env:1', env: {} }), null)
  assert.equal(resolveProxy(new URL('http://127.0.0.1:8080/x'), { proxy: 'http://env:1', env: {}, bypassLoopback: false }).host, 'env')
  assert.equal(resolveProxy(new URL('http://example.test/x'), { proxy: '', env: { HTTP_PROXY: 'http://plain:2' } }).port, 2)
  assert.equal(resolveProxy(new URL('http://example.test/x'), { proxy: '', env: { ALL_PROXY: 'socks5://all:3' } }).port, 3)
})

test('Google config exposes proxy settings with modern defaults', () => {
  const defaults = resolveGoogleConfig({})
  assert.equal(defaults.proxy, '')
  assert.equal(defaults.proxyFromEnv, true)
  assert.deepEqual(defaults.proxyBypass, [])
  assert.equal(defaults.guardWrites, true)
  assert.deepEqual(defaults.scopes, [...GOOGLE_DEFAULT_CONFIG.scopes])
  for (const scope of ['documents', 'spreadsheets', 'presentations', 'drive.metadata.readonly']) {
    assert.ok(defaults.scopes.some((value) => value.endsWith(`auth/${scope}`)), scope)
  }

  const configured = resolveGoogleConfig({
    proxy: 'http://127.0.0.1:7897',
    proxyFromEnv: false,
    proxyBypass: ['internal.test', 7],
    redirectPort: 1234,
    maxRetries: 99,
    timeoutMs: 10,
  })
  assert.equal(configured.proxy, 'http://127.0.0.1:7897')
  assert.equal(configured.proxyFromEnv, false)
  assert.deepEqual(configured.proxyBypass, ['internal.test'])
  assert.equal(configured.redirectPort, 1234)
  assert.equal(configured.maxRetries, 5)
  assert.equal(configured.timeoutMs, 1000)
})
