/**
 * Minimal local proxies used to verify the Google adapter's tunnel transport.
 *
 * - `startConnectProxy` implements HTTP CONNECT (the common http_proxy).
 * - `startSocks5Proxy` implements the no-auth SOCKS5 CONNECT handshake.
 *
 * Both count tunnels so a test can prove traffic actually went through them.
 */
import http from 'node:http'
import net from 'node:net'

/** Start an HTTP CONNECT proxy. */
export async function startConnectProxy() {
  const stats = { tunnels: 0, targets: [] }
  const server = http.createServer((_request, response) => {
    response.writeHead(400, { 'content-type': 'text/plain' })
    response.end('CONNECT only')
  })
  server.on('connect', (request, clientSocket, head) => {
    const [host, portText] = String(request.url ?? '').split(':')
    const port = Number(portText)
    stats.tunnels += 1
    stats.targets.push(`${host}:${port}`)
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    stats,
    close: () => new Promise((resolve) => {
      server.close(resolve)
      server.closeAllConnections?.()
    }),
  }
}

/** Start a no-auth SOCKS5 proxy. */
export async function startSocks5Proxy() {
  const stats = { tunnels: 0, targets: [] }
  const server = net.createServer((client) => {
    let buffer = Buffer.alloc(0)
    let stage = 'greeting'
    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 'greeting') {
        if (buffer.length < 2) return
        const methods = buffer[1]
        if (buffer.length < 2 + methods) return
        buffer = buffer.subarray(2 + methods)
        client.write(Buffer.from([0x05, 0x00]))
        stage = 'request'
      }
      if (stage === 'request') {
        if (buffer.length < 4) return
        if (buffer[0] !== 0x05 || buffer[1] !== 0x01) {
          client.destroy()
          return
        }
        const addressType = buffer[3]
        let offset = 4
        let host
        if (addressType === 0x01) {
          if (buffer.length < 4 + 4 + 2) return
          host = [...buffer.subarray(4, 8)].join('.')
          offset = 8
        } else if (addressType === 0x03) {
          const length = buffer[4]
          if (buffer.length < 5 + length + 2) return
          host = buffer.subarray(5, 5 + length).toString('utf8')
          offset = 5 + length
        } else if (addressType === 0x04) {
          if (buffer.length < 4 + 16 + 2) return
          host = '::1'
          offset = 20
        } else {
          client.destroy()
          return
        }
        const port = buffer.readUInt16BE(offset)
        buffer = buffer.subarray(offset + 2)
        stage = 'tunnel'
        stats.tunnels += 1
        stats.targets.push(`${host}:${port}`)
        const upstream = net.connect(port, host, () => {
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          if (buffer.length > 0) upstream.write(buffer)
          upstream.pipe(client)
          client.pipe(upstream)
        })
        upstream.on('error', () => client.destroy())
        client.on('error', () => upstream.destroy())
      }
    })
    client.on('error', () => {})
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    stats,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
