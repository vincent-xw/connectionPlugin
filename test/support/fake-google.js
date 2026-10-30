/**
 * A local stand-in for Google's OAuth token endpoint and Docs API.
 *
 * It is deliberately small but faithful to the request shapes this adapter
 * sends: bearer auth, `includeTabsContent=true`, `endOfSegmentLocation`,
 * location inserts, `tabsCriteria`, `writeControl.requiredRevisionId`, and
 * `addDocumentTab`. It also supports queued failures so retry and error mapping
 * can be tested without network access.
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

/** Turn plain tab text into Docs API paragraphs with coherent native indexes. */
export function paragraphContent(text) {
  const content = []
  let index = 0
  const parts = text.length === 0 ? ['\n'] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? [])
  for (const part of parts) {
    content.push({
      startIndex: index,
      endIndex: index + part.length,
      paragraph: {
        elements: [{ textRun: { content: part } }],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' },
      },
    })
    index += part.length
  }
  if (content.length === 0) {
    content.push({ startIndex: 0, endIndex: 1, paragraph: { elements: [{ textRun: { content: '\n' } }] } })
  }
  return content
}

/** Escape a literal find string for a RegExp. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Read a request body as text. */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** JSON response helper. */
function json(response, status, payload, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(payload))
}

/**
 * Start the fake service.
 * @param {object} [options]
 * @param {string} [options.title] - initial document title.
 * @param {Array<{title: string, text: string}>} [options.tabs] - initial tabs.
 * @returns {Promise<object>} fake server handle.
 */
export async function startFakeGoogle({ title = 'Test Doc', tabs = [{ title: 'Tab 1', text: 'Hello\n' }] } = {}) {
  let accessCounter = 0
  let documentCounter = 0
  const documents = new Map()
  const accessTokens = new Set()
  const refreshTokens = new Set()
  const codes = new Map()
  const tokenRequests = []
  const failures = []

  const createDocument = ({ initialTabs = [], documentTitle = title } = {}) => {
    documentCounter += 1
    const id = `doc-${documentCounter}`
    const document = {
      documentId: id,
      title: documentTitle,
      revision: 1,
      tabs: initialTabs.map((tab, index) => ({
        tabId: `t.${index}`,
        title: tab.title,
        index,
        text: tab.text,
        childTabs: [],
      })),
    }
    documents.set(id, document)
    return document
  }
  createDocument({ initialTabs: tabs })

  const issueAccess = () => {
    accessCounter += 1
    const token = `access-${accessCounter}`
    accessTokens.add(token)
    return token
  }

  const findTab = (document, tabId) => {
    if (tabId === undefined) return document.tabs[0]
    return document.tabs.find((tab) => tab.tabId === tabId)
  }

  const applyBatchUpdate = (document, body) => {
    const required = body?.writeControl?.requiredRevisionId
    if (required !== undefined && required !== `rev-${document.revision}`) {
      return {
        status: 400,
        payload: { error: { code: 400, message: `The document has changed since the requested revision ${required}`, status: 'FAILED_PRECONDITION' } },
      }
    }
    const replies = []
    for (const request of body?.requests ?? []) {
      if (request.insertText !== undefined) {
        const { text, endOfSegmentLocation, location } = request.insertText
        const tabId = endOfSegmentLocation?.tabId ?? location?.tabId
        const tab = findTab(document, tabId)
        if (tab === undefined) return { status: 400, payload: { error: { message: `no tab ${tabId}` } } }
        if (endOfSegmentLocation !== undefined) {
          const at = tab.text.endsWith('\n') ? Math.max(0, tab.text.length - 1) : tab.text.length
          tab.text = tab.text.slice(0, at) + text + tab.text.slice(at)
        } else {
          if (!Number.isInteger(location?.index) || location.index < 0 || location.index > tab.text.length) {
            return { status: 400, payload: { error: { message: `invalid index ${location?.index}` } } }
          }
          tab.text = tab.text.slice(0, location.index) + text + tab.text.slice(location.index)
        }
        replies.push({ insertText: {} })
        continue
      }
      if (request.replaceAllText !== undefined) {
        const { containsText, replaceText, tabsCriteria } = request.replaceAllText
        const find = String(containsText?.text ?? '')
        if (find.length === 0) return { status: 400, payload: { error: { message: 'containsText.text is empty' } } }
        const targets = Array.isArray(tabsCriteria?.tabIds)
          ? document.tabs.filter((tab) => tabsCriteria.tabIds.includes(tab.tabId))
          : document.tabs
        let occurrences = 0
        const pattern = new RegExp(escapeRegExp(find), containsText?.matchCase === true ? 'g' : 'gi')
        for (const tab of targets) {
          const matches = tab.text.match(pattern)
          occurrences += matches === null ? 0 : matches.length
          tab.text = tab.text.replace(pattern, String(replaceText ?? ''))
        }
        replies.push({ replaceAllText: { occurrencesChanged: occurrences } })
        continue
      }
      if (request.addDocumentTab !== undefined) {
        const index = document.tabs.length
        const tabId = `t.${index}`
        const tabTitle = String(request.addDocumentTab?.tabProperties?.title ?? `Tab ${index + 1}`)
        document.tabs.push({ tabId, title: tabTitle, index, text: '\n', childTabs: [] })
        replies.push({ addDocumentTab: { tabProperties: { tabId, title: tabTitle, index } } })
        continue
      }
      return { status: 400, payload: { error: { message: `unsupported request ${Object.keys(request)[0]}` } } }
    }
    document.revision += 1
    return { status: 200, payload: { documentId: document.documentId, replies, writeControl: { requiredRevisionId: `rev-${document.revision}` } } }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    const bodyText = request.method === 'POST' ? await readBody(request) : ''

    const queued = failures.findIndex((failure) => (failure.method === undefined || failure.method === request.method) && (failure.path === undefined || failure.path.test(path)))
    if (queued !== -1) {
      const [failure] = failures.splice(queued, 1)
      json(response, failure.status, failure.body ?? { error: { message: 'injected failure' } }, failure.headers ?? {})
      return
    }

    if (path === '/token') {
      const form = new URLSearchParams(bodyText)
      tokenRequests.push(Object.fromEntries(form))
      const grant = form.get('grant_type')
      if (grant === 'authorization_code') {
        const code = form.get('code')
        const pending = codes.get(code)
        if (pending === undefined) return json(response, 400, { error: 'invalid_grant', error_description: 'bad code' })
        if (pending.used) return json(response, 400, { error: 'invalid_grant', error_description: 'code already used' })
        const expected = createHash('sha256').update(form.get('code_verifier') ?? '', 'ascii').digest('base64url')
        if (expected !== pending.challenge) return json(response, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
        if (form.get('client_id') !== pending.clientId) return json(response, 400, { error: 'invalid_client' })
        pending.used = true
        const refresh = `refresh-1`
        refreshTokens.add(refresh)
        return json(response, 200, {
          access_token: issueAccess(),
          expires_in: 3600,
          refresh_token: refresh,
          scope: 'https://www.googleapis.com/auth/documents',
          token_type: 'Bearer',
        })
      }
      if (grant === 'refresh_token') {
        const refresh = form.get('refresh_token')
        if (!refreshTokens.has(refresh)) return json(response, 400, { error: 'invalid_grant', error_description: 'unknown refresh token' })
        return json(response, 200, {
          access_token: issueAccess(),
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/documents',
          token_type: 'Bearer',
        })
      }
      return json(response, 400, { error: 'unsupported_grant_type' })
    }

    if (path === '/revoke') {
      json(response, 200, {})
      return
    }

    const authorized = request.headers.authorization
    const token = typeof authorized === 'string' && authorized.startsWith('Bearer ') ? authorized.slice(7) : undefined
    if (token === undefined || !accessTokens.has(token)) {
      json(response, 401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } })
      return
    }

    if (path === '/v1/documents' && request.method === 'POST') {
      const payload = JSON.parse(bodyText || '{}')
      const document = createDocument({
        initialTabs: [{ title: 'Tab 1', text: '\n' }],
        documentTitle: typeof payload.title === 'string' ? payload.title : title,
      })
      json(response, 200, { documentId: document.documentId, title: document.title, revisionId: `rev-${document.revision}` })
      return
    }

    const getMatch = /^\/v1\/documents\/([^/:]+)$/.exec(path)
    if (getMatch !== null && request.method === 'GET') {
      const document = documents.get(decodeURIComponent(getMatch[1]))
      if (document === undefined) return json(response, 404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND' } })
      if (url.searchParams.get('includeTabsContent') !== 'true') {
        return json(response, 400, { error: { message: 'includeTabsContent=true expected' } })
      }
      json(response, 200, {
        documentId: document.documentId,
        title: document.title,
        revisionId: `rev-${document.revision}`,
        tabs: document.tabs.map((tab) => ({
          tabProperties: { tabId: tab.tabId, title: tab.title, index: tab.index },
          documentTab: { body: { content: paragraphContent(tab.text) } },
          childTabs: tab.childTabs,
        })),
      })
      return
    }

    const batchMatch = /^\/v1\/documents\/([^/:]+):batchUpdate$/.exec(path)
    if (batchMatch !== null && request.method === 'POST') {
      const document = documents.get(decodeURIComponent(batchMatch[1]))
      if (document === undefined) return json(response, 404, { error: { code: 404, message: 'Requested entity was not found.' } })
      let payload
      try {
        payload = JSON.parse(bodyText || '{}')
      } catch {
        return json(response, 400, { error: { message: 'invalid JSON' } })
      }
      const result = applyBatchUpdate(document, payload)
      json(response, result.status, result.payload)
      return
    }

    json(response, 404, { error: { message: `no route ${request.method} ${path}` } })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  return {
    baseUrl,
    documents,
    accessTokens,
    refreshTokens,
    tokenRequests,
    failures,
    codes,
    state: { documents },
    addCode(code, { clientId, challenge }) {
      codes.set(code, { clientId, challenge, used: false })
    },
    document(id) {
      return documents.get(id)
    },
    close() {
      return new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections?.()
      })
    },
  }
}
