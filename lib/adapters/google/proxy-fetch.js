/**
 * Proxy-aware fetch for Google endpoints.
 *
 * Node's global fetch (undici) does not honor `HTTPS_PROXY`, and the Harness
 * ships no proxy-agent dependency. This module implements the two transports a
 * local proxy normally offers:
 *
 * - `http(s)://` proxies via the CONNECT method, then TLS to the target.
 * - `socks5://` / `socks5h://` proxies via a minimal RFC 1928 handshake.
 *
 * It returns a fetch-compatible object (`ok`, `status`, `headers.get`,
 * `text()`, `json()`), which is all the Google adapter uses. Loopback targets
 * bypass the proxy so OAuth callbacks and local tests are never tunnelled.
 * @module @local/docs-connector/adapters/google/proxy-fetch
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { DOCS_ERROR, DocsError } from '../../core/errors.js'

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]'])

/** @param {string} hostname - URL hostname. @returns {boolean} */
export function isLoopbackHost(hostname) {
  return LOOPBACK.has(String(hostname).toLowerCase())
}

/**
 * Parse a proxy URL into a transport descriptor.
 * @param {string} value - `http://`, `https://`, `socks5://`, or `socks5h://` URL.
 * @returns {{ protocol: string, host: string, port: number, auth?: string }}
 */
export function parseProxy(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DocsError('proxy URL is empty', { code: DOCS_ERROR.NOT_CONFIGURED, platform: 'google-docs' })
  }
  const raw = value.includes('://') ? value.trim() : `http://${value.trim()}`
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new DocsError(`proxy URL is invalid: ${redactProxy(raw)}`, {
      code: DOCS_ERROR.NOT_CONFIGURED,
      platform: 'google-docs',
      hint: 'Use http://127.0.0.1:7897 or socks5://127.0.0.1:1080.',
    })
  }
  const protocol = url.protocol === 'socks5h:' ? 'socks5:' : url.protocol
  if (!['http:', 'https:', 'socks5:'].includes(protocol)) {
    throw new DocsError(`unsupported proxy protocol "${url.protocol}"`, {
      code: DOCS_ERROR.NOT_CONFIGURED,
      platform: 'google-docs',
      hint: 'Supported proxy protocols: http, https, socks5.',
    })
  }
  const port = url.port === ''
    ? protocol === 'http:' ? 80 : protocol === 'https:' ? 443 : 1080
    : Number(url.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new DocsError('proxy port is invalid', { code: DOCS_ERROR.NOT_CONFIGURED, platform: 'google-docs' })
  }
  return {
    protocol,
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    ...(url.username === '' && url.password === ''
      ? {}
      : { auth: `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` }),
  }
}

/** Hide proxy credentials in diagnostics. */
export function redactProxy(value) {
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    if (url.username !== '' || url.password !== '') {
      url.username = '***'
      url.password = '***'
    }
    return url.toString()
  } catch {
    return '(invalid proxy URL)'
  }
}

/** Whether a host matches NO_PROXY (including the loopback default). */
function bypassed(hostname, port, { env, bypass = [], bypassLoopback = true }) {
  const host = String(hostname).toLowerCase()
  if (bypassLoopback && isLoopbackHost(host)) return true
  const entries = [
    ...bypass,
    ...String(env.NO_PROXY ?? env.no_proxy ?? '').split(','),
  ]
  for (const raw of entries) {
    const entry = String(raw).trim().toLowerCase()
    if (entry.length === 0) continue
    if (entry === '*') return true
    const [entryHost, entryPort] = entry.startsWith('[')
      ? [entry.slice(1, entry.indexOf(']')), entry.slice(entry.indexOf(']') + 2)]
      : entry.split(':')
    const candidate = (entryHost ?? '').replace(/^\*?\./, '')
    if (host === candidate || host.endsWith(`.${candidate}`)) {
      if (entryPort === undefined || entryPort === '' || Number(entryPort) === Number(port)) return true
    }
  }
  return false
}

/**
 * Resolve the proxy for one target.
 * @param {URL} target - destination URL.
 * @param {object} [options]
 * @param {string} [options.proxy] - explicit `proxy` config (`direct`/`none` disables).
 * @param {boolean} [options.proxyFromEnv] - honor HTTPS_PROXY/HTTP_PROXY/ALL_PROXY.
 * @param {string[]} [options.bypass] - extra NO_PROXY hosts.
 * @param {boolean} [options.bypassLoopback] - loopback never proxied (default true).
 * @param {object} [options.env] - environment source.
 * @returns {object|null} proxy descriptor, or null for a direct connection.
 */
export function resolveProxy(target, options = {}) {
  const env = options.env ?? process.env
  const bypassLoopback = options.bypassLoopback !== false
  if (bypassed(target.hostname, target.port, { env, bypass: options.bypass, bypassLoopback })) return null
  const explicit = typeof options.proxy === 'string' ? options.proxy.trim() : ''
  if (explicit === 'direct' || explicit === 'none') return null
  if (explicit.length > 0) return parseProxy(explicit)
  if (options.proxyFromEnv === false) return null
  const candidate = target.protocol === 'https:'
    ? env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy
    : env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy
  return typeof candidate === 'string' && candidate.length > 0 ? parseProxy(candidate) : null
}

/** Build a fetch-compatible response from a buffered body. */
function makeResponse(status, headers, buffer) {
  const text = buffer.toString('utf8')
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        const value = headers[String(name).toLowerCase()]
        return value === undefined ? null : Array.isArray(value) ? value.join(', ') : String(value)
      },
      raw: headers,
    },
    async text() {
      return text
    },
    async json() {
      return JSON.parse(text)
    },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    },
  }
}

/** Abort error compatible with the caller's cancellation checks. */
function abortError(signal) {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  const error = new Error('the request was aborted')
  error.name = 'AbortError'
  return error
}

/** Normalize fetch headers into a plain lowercase-keyed object. */
function normalizeHeaders(headers) {
  if (headers === undefined || headers === null) return {}
  if (typeof headers.forEach === 'function' && !Array.isArray(headers)) {
    const output = {}
    headers.forEach((value, key) => {
      output[String(key).toLowerCase()] = value
    })
    return output
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers.map(([key, value]) => [String(key).toLowerCase(), value]))
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value]))
}

/** Effective target port. */
function targetPort(target) {
  if (target.port !== '') return Number(target.port)
  return target.protocol === 'https:' ? 443 : 80
}

/** Decode a complete chunked body, or return null when more bytes are needed. */
function decodeChunked(buffer) {
  const parts = []
  let offset = 0
  while (true) {
    const lineEnd = buffer.indexOf('\r\n', offset)
    if (lineEnd === -1) return null
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString('latin1').split(';')[0], 16)
    if (!Number.isFinite(size)) throw new DocsError('proxy response has an invalid chunk length', { code: DOCS_ERROR.UPSTREAM, platform: 'google-docs' })
    offset = lineEnd + 2
    if (size === 0) {
      if (buffer.length < offset + 2) return null
      return Buffer.concat(parts)
    }
    if (buffer.length < offset + size + 2) return null
    parts.push(buffer.subarray(offset, offset + size))
    offset += size + 2
  }
}

/**
 * Write one HTTP/1.1 request over an already-open (possibly TLS) socket and
 * parse the response manually. Node's `http.request({ createConnection })`
 * does not reliably adopt an externally established TLS socket, so the
 * tunnel transport owns the wire format instead. Requests use
 * `connection: close`, which bounds the response by EOF.
 */
function writeHttpRequest(socket, target, init, resolve, reject) {
  const method = String(init.method ?? 'GET').toUpperCase()
  const headers = { ...normalizeHeaders(init.headers), host: target.host, connection: 'close' }
  if (headers['accept-encoding'] === undefined) headers['accept-encoding'] = 'identity'
  const body = init.body === undefined || init.body === null ? null : Buffer.from(String(init.body))
  if (body !== null) headers['content-length'] = String(body.length)
  const requestHead = Buffer.from(
    `${method} ${target.pathname}${target.search} HTTP/1.1\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`,
    'latin1',
  )
  let buffer = Buffer.alloc(0)
  let settled = false
  const finish = (fn, value) => {
    if (settled) return
    settled = true
    socket.removeAllListeners('data')
    socket.removeAllListeners('end')
    // Tunnelled TLS connections can report a late record error after the full
    // HTTP response (some proxies close the tunnel without close_notify).
    // Keep a listener so that late error cannot crash the host, then release
    // the socket.
    socket.on('error', () => {})
    try {
      socket.destroy()
    } catch {
      // Ignore teardown races.
    }
    fn(value)
  }
  const tryParse = () => {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const lines = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n')
    const statusLine = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines[0] ?? '')
    if (statusLine === null) {
      finish(reject, new DocsError('proxy returned a malformed HTTP response', { code: DOCS_ERROR.UPSTREAM, platform: 'google-docs' }))
      return
    }
    const status = Number(statusLine[1])
    const responseHeaders = {}
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      const key = line.slice(0, colon).trim().toLowerCase()
      const value = line.slice(colon + 1).trim()
      responseHeaders[key] = responseHeaders[key] === undefined ? value : `${responseHeaders[key]}, ${value}`
    }
    const bodyStart = headerEnd + 4
    if (method === 'HEAD' || status === 204 || status === 304) {
      finish(resolve, makeResponse(status, responseHeaders, Buffer.alloc(0)))
      return
    }
    const chunked = String(responseHeaders['transfer-encoding'] ?? '').toLowerCase().includes('chunked')
    if (chunked) {
      let decoded
      try {
        decoded = decodeChunked(buffer.subarray(bodyStart))
      } catch (error) {
        finish(reject, error)
        return
      }
      if (decoded !== null) finish(resolve, makeResponse(status, responseHeaders, decoded))
      return
    }
    const length = Number(responseHeaders['content-length'])
    if (Number.isInteger(length) && length >= 0) {
      if (buffer.length >= bodyStart + length) {
        finish(resolve, makeResponse(status, responseHeaders, buffer.subarray(bodyStart, bodyStart + length)))
      }
      return
    }
    // No framing headers: wait for EOF, handled by the 'end' listener.
  }
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    tryParse()
  })
  socket.once('end', () => {
    if (settled) return
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      finish(reject, new DocsError('proxy closed the connection before a response arrived', { code: DOCS_ERROR.UPSTREAM, platform: 'google-docs' }))
      return
    }
    const lines = buffer.subarray(0, headerEnd).toString('latin1').split('\r\n')
    const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(lines[0] ?? '')?.[1] ?? 0)
    const responseHeaders = {}
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      responseHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
    }
    finish(resolve, makeResponse(status, responseHeaders, buffer.subarray(headerEnd + 4)))
  })
  socket.once('error', (error) => finish(reject, error))
  socket.write(requestHead)
  if (body !== null) socket.write(body)
}

/** Complete TLS to the target after a tunnel is open. */
function secureTunnel(socket, target, init, resolve, reject) {
  if (target.protocol !== 'https:') {
    writeHttpRequest(socket, target, init, resolve, reject)
    return
  }
  const options = { socket, servername: isLoopbackHost(target.hostname) ? undefined : target.hostname }
  const tlsSocket = tls.connect(options)
  tlsSocket.once('secureConnect', () => writeHttpRequest(tlsSocket, target, init, resolve, reject))
  tlsSocket.once('error', reject)
}

/** Tunnel through an HTTP proxy with CONNECT. */
function httpProxyTunnel(proxy, target, init, onSocket, reject) {
  const transport = proxy.protocol === 'https:' ? https : http
  const authority = `${target.hostname}:${targetPort(target)}`
  const request = transport.request({
    host: proxy.host,
    port: proxy.port,
    method: 'CONNECT',
    path: authority,
    headers: {
      host: authority,
      ...(proxy.auth === undefined ? {} : { 'proxy-authorization': `Basic ${Buffer.from(proxy.auth).toString('base64')}` }),
    },
    ...(proxy.protocol === 'https:' ? { servername: proxy.host } : {}),
    signal: init.signal,
  })
  request.once('connect', (response, socket, head) => {
    if (response.statusCode !== 200) {
      socket.destroy()
      reject(new DocsError(`HTTP proxy refused CONNECT with status ${response.statusCode}`, {
        code: response.statusCode === 407 ? DOCS_ERROR.NOT_CONFIGURED : DOCS_ERROR.UPSTREAM,
        platform: 'google-docs',
        hint: response.statusCode === 407
          ? 'The proxy requires authentication; put the credentials in the proxy URL.'
          : 'Check that the proxy allows CONNECT to docs.googleapis.com:443.',
      }))
      return
    }
    if (head !== undefined && head.length > 0) socket.unshift(head)
    onSocket(socket)
  })
  request.once('error', (error) => {
    reject(proxyFailure(error, proxy))
  })
  request.end()
}

/** Minimal sequential reader for the SOCKS5 handshake. */
function createReader(socket) {
  let buffer = Buffer.alloc(0)
  let pending
  const flush = () => {
    if (pending === undefined || buffer.length < pending.size) return
    const slice = buffer.subarray(0, pending.size)
    buffer = buffer.subarray(pending.size)
    const waiter = pending
    pending = undefined
    waiter.resolve(slice)
  }
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    flush()
  })
  socket.on('close', () => {
    if (pending !== undefined) {
      const waiter = pending
      pending = undefined
      waiter.reject(new DocsError('the SOCKS5 proxy closed the connection', {
        code: DOCS_ERROR.UPSTREAM,
        platform: 'google-docs',
      }))
    }
  })
  return (size) => new Promise((resolve, reject) => {
    pending = { size, resolve, reject }
    flush()
  })
}

/** SOCKS5 greeting/auth/CONNECT handshake. */
async function socks5Tunnel(proxy, target, init, onSocket, reject) {
  const socket = net.connect({ host: proxy.host, port: proxy.port })
  const reader = createReader(socket)
  const onAbort = () => {
    socket.destroy()
    reject(abortError(init.signal))
  }
  init.signal?.addEventListener('abort', onAbort, { once: true })
  socket.once('error', (error) => reject(proxyFailure(error, proxy)))
  try {
    await new Promise((resolve, rejectConnect) => {
      socket.once('connect', resolve)
      socket.once('error', rejectConnect)
    })
    socket.write(proxy.auth === undefined ? Buffer.from([0x05, 0x01, 0x00]) : Buffer.from([0x05, 0x02, 0x00, 0x02]))
    const greeting = await reader(2)
    if (greeting[0] !== 0x05) throw new DocsError('the proxy is not a SOCKS5 server', { code: DOCS_ERROR.NOT_CONFIGURED, platform: 'google-docs' })
    if (greeting[1] === 0x02) {
      if (proxy.auth === undefined) throw new DocsError('the SOCKS5 proxy requires a username and password', { code: DOCS_ERROR.NOT_CONFIGURED, platform: 'google-docs' })
      const [user, password] = proxy.auth.split(':')
      const username = Buffer.from(user ?? '', 'utf8')
      const secret = Buffer.from(password ?? '', 'utf8')
      socket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([secret.length]), secret]))
      const authReply = await reader(2)
      if (authReply[1] !== 0x00) throw new DocsError('the SOCKS5 proxy rejected the credentials', { code: DOCS_ERROR.NOT_CONFIGURED, platform: 'google-docs' })
    } else if (greeting[1] !== 0x00) {
      throw new DocsError('the SOCKS5 proxy offered no supported authentication method', { code: DOCS_ERROR.NOT_CONFIGURED, platform: 'google-docs' })
    }
    const host = Buffer.from(target.hostname, 'utf8')
    if (host.length > 255) throw new DocsError('target hostname is too long for SOCKS5', { code: DOCS_ERROR.INVALID_INPUT, platform: 'google-docs' })
    const port = targetPort(target)
    socket.write(Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
      host,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]))
    const head = await reader(4)
    if (head[0] !== 0x05 || head[1] !== 0x00) {
      throw new DocsError(`the SOCKS5 proxy refused the connection (code ${head[1]})`, {
        code: DOCS_ERROR.UPSTREAM,
        platform: 'google-docs',
        hint: 'Check that the proxy can reach docs.googleapis.com:443.',
      })
    }
    const addressType = head[3]
    if (addressType === 0x01) await reader(4 + 2)
    else if (addressType === 0x04) await reader(16 + 2)
    else {
      const length = (await reader(1))[0]
      await reader(length + 2)
    }
    init.signal?.removeEventListener('abort', onAbort)
    onSocket(socket)
  } catch (error) {
    socket.destroy()
    reject(error instanceof DocsError ? error : proxyFailure(error, proxy))
  }
}

/** Wrap a socket-level failure with an actionable proxy error. */
function proxyFailure(error, proxy) {
  if (error instanceof DocsError) return error
  const code = error?.code
  return new DocsError(`cannot reach the proxy at ${proxy.host}:${proxy.port}${code === undefined ? '' : ` (${code})`}`, {
    code: DOCS_ERROR.UPSTREAM,
    platform: 'google-docs',
    hint: 'Check that the local proxy is running and that the proxy address is correct.',
    cause: error,
  })
}

/**
 * Create a fetch-compatible function that honors a proxy.
 * @param {object} [options]
 * @param {string} [options.proxy] - explicit proxy (`direct`/`none` disables).
 * @param {boolean} [options.proxyFromEnv] - honor environment proxies (default true).
 * @param {string[]} [options.bypass] - extra NO_PROXY hosts.
 * @param {boolean} [options.bypassLoopback] - never proxy loopback targets (default true).
 * @param {object} [options.env] - environment source (tests).
 * @param {typeof fetch} [options.fetchImpl] - direct transport (default global fetch).
 * @returns {typeof fetch}
 */
export function createProxiedFetch({
  proxy = '',
  proxyFromEnv = true,
  bypass = [],
  bypassLoopback = true,
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  return async function proxiedFetch(url, init = {}) {
    const target = new URL(String(url))
    const resolved = resolveProxy(target, { proxy, proxyFromEnv, bypass, bypassLoopback, env })
    if (resolved === null) return fetchImpl(url, init)
    return proxyRequest(target, resolved, init)
  }
}

/**
 * Run one request through a proxy.
 * @param {URL} target - destination.
 * @param {object} proxy - proxy descriptor.
 * @param {object} init - fetch init.
 * @returns {Promise<object>} fetch-compatible response.
 */
export function proxyRequest(target, proxy, init = {}) {
  return new Promise((resolve, reject) => {
    const signal = init.signal
    if (signal?.aborted) {
      reject(abortError(signal))
      return
    }
    let socket
    const onAbort = () => {
      try {
        socket?.destroy()
      } catch {
        // Ignore teardown failures.
      }
      reject(abortError(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const settle = (fn) => (value) => {
      signal?.removeEventListener('abort', onAbort)
      fn(value)
    }
    const resolveOnce = settle(resolve)
    const rejectOnce = settle(reject)
    const openTunnel = (tunnelled) => {
      socket = tunnelled
      secureTunnel(tunnelled, target, init, resolveOnce, rejectOnce)
    }
    if (proxy.protocol === 'socks5:') {
      socks5Tunnel(proxy, target, init, openTunnel, rejectOnce)
    } else {
      httpProxyTunnel(proxy, target, init, openTunnel, rejectOnce)
    }
  })
}
