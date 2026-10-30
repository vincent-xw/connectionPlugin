# Adapter 开发指南

本插件把“平台差异”全部关在 Adapter 里。一个平台 = 一个包 + 一行 composition。本文用两个例子讲清楚契约：

1. 只读的 Notion 风格 adapter（最小实现）；
2. 带本地 token 的授权 adapter（可选能力）。

类型定义见 [`../lib/types/index.d.ts`](../lib/types/index.d.ts)。

---

## 1. 契约

### 1.1 必填

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 小写连字符，如 `notion`、`feishu-docs`；同时用于凭据 key |
| `title` | `string` | 展示名 |
| `parseRef` | `(input) => DocRef \| null` | 识别 URL / 原生 id；不识别返回 `null` 或抛错 |

`DocRef`：

```ts
{ platform: string, documentId: string, url?: string }
```

> `platform` 字段可以省略，Registry 会用 adapter id 补上。

### 1.2 能力（全部可选，按方法推断）

| 能力 | 方法 | 工具 |
| --- | --- | --- |
| `read` | `read(ref, options, signal)` | `docs_read` |
| `create` | `create(request, signal)` | `docs_create` |
| `append` | `append(ref, request, signal)` | `docs_append` |
| `insert` | `insert(ref, request, signal)` | `docs_insert` |
| `replace` | `replace(ref, request, signal)` | `docs_replace` |
| `custom` | `invoke(ref, {action,payload}, signal)` | `docs_invoke` |
| `auth` | `auth.status/start/disconnect` | `docs_connect` / `docs_disconnect` |
| `tabs` / `revisions` | 仅提示 | 工具描述/计划使用 |

显式 `capabilities: { read: false }` 可以关闭自动推断。

### 1.3 可选

| 成员 | 说明 |
| --- | --- |
| `description` | 展示在 `docs_platforms` |
| `refExample` | 引用示例 |
| `metadata` | 原样透传，给专用工具用 |
| `formatRef(ref)` | 生成规范 URL |
| `close()` | 释放定时器/连接；插件卸载时自动调用 |

---

## 2. 最小只读 adapter（Notion 风格）

目录：

```text
my-notion-adapter/
├── package.json
├── cordis.patch.yml
└── index.js
```

`package.json`：

```json
{
  "name": "@local/notion-docs",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: notion-docs
      name: '@local/notion-docs'
      config:
        tokenRef: NOTION_TOKEN
```

`index.js`：

```js
export const name = 'notion-docs'
export const inject = ['docs', 'credentials']   // 等 ctx.docs 与凭据服务就绪

export function apply(ctx, config) {
  const tokenRef = config?.tokenRef ?? 'NOTION_TOKEN'

  const adapter = {
    id: 'notion',
    title: 'Notion',
    description: 'Read Notion pages as documents.',
    refExample: 'https://www.notion.so/<pageId>',

    parseRef(input) {
      const match = /notion\.so\/(?:[^/]+-)?([0-9a-f]{32})/i.exec(input)
      if (!match) return null
      return { documentId: match[1], url: `https://www.notion.so/${match[1]}` }
    },

    async read(ref, _options, signal) {
      const token = await ctx.credentials.resolve(tokenRef)
      if (!token) throw docsError('Notion token is not configured', 'NOT_CONFIGURED', `Store a credential reference named ${tokenRef}.`)

      const response = await fetch(`https://api.notion.com/v1/blocks/${ref.documentId}/children`, {
        headers: {
          authorization: `Bearer ${token.value}`,
          'notion-version': '2022-06-28',
        },
        signal,
      })
      if (!response.ok) {
        throw docsError(
          `Notion returned ${response.status}`,
          response.status === 404 ? 'NOT_FOUND' : 'UPSTREAM',
          response.status === 404 ? 'Check the page id and sharing settings.' : 'Retry the read.',
        )
      }
      const page = await response.json()

      return {
        platform: 'notion',
        documentId: ref.documentId,
        title: page.title ?? 'Notion page',
        url: ref.url,
        // Notion 没有文档级 revision；不提供也可以，写入时就不会带 revision guard。
        tabs: [{
          id: 'body',
          title: page.title ?? 'Notion page',
          blocks: page.results.map(toBlock),
        }],
      }
    },
  }

  return ctx.docs.registerAdapter(adapter, ctx)
}

// 零依赖错误写法：普通 Error + 两个属性，core 会识别。
function docsError(message, code, hint) {
  const error = new Error(message)
  error.code = code
  error.hint = hint
  error.platform = 'notion'
  return error
}

function toBlock(block) {
  const text = block?.paragraph?.rich_text?.map((run) => run.plain_text).join('') ?? ''
  if (block.type === 'heading_1') return { type: 'heading', level: 1, text }
  if (block.type === 'heading_2') return { type: 'heading', level: 2, text }
  if (block.type === 'bulleted_list_item') return { type: 'list', text, level: 0 }
  return { type: 'paragraph', text }
}
```

> **零依赖约定**：上面的 `docsError()` 只是给普通 `Error` 挂 `code` / `hint` / `platform` 属性。
> 核心的 `asDocsError()` 会识别这些字段（`code` 必须在 `DOCS_ERROR` 词表内），所以 adapter 包**不需要 import 本项目的任何运行时模块**。
>
> 如果你确实能解析到本包（例如在同一个 pnpm workspace），也可以：
>
> ```js
> import { DocsError, DOCS_ERROR } from '@local/docs-connector/core'
> throw new DocsError('...', { code: DOCS_ERROR.FORBIDDEN, platform: 'notion' })
> ```
>
> 这只是可选糖。`lib/types/index.d.ts` 是纯类型，编译期使用，不产生运行时依赖。

安装：

```bash
dsh plugin --profile <profile> add link:/absolute/path/my-notion-adapter
```

---

## 3. 授权能力（可选）

如果平台需要 OAuth/本地 token，实现 `auth`：

```js
const adapter = {
  id: 'feishu-docs',
  title: 'Feishu Docs',
  parseRef: (input) => input.startsWith('feishu:') ? { documentId: input.slice(7) } : null,

  // 读取时用 token；这里省略 read 实现
  async read(ref, options, signal) { /* ... */ },

  auth: {
    defaultAccount: 'default',

    async status({ account = 'default' }) {
      const record = await ctx.credentials.readRecord(`my-feishu/token-${account}`)
      return { connected: record !== undefined, account }
    },

    async start({ account = 'default' }) {
      // 返回 URL 后由用户在浏览器完成；adapter 负责在后台完成换取
      return { url: `https://open.feishu.cn/open-apis/authen/v1/authorize?...` }
    },

    async disconnect({ account = 'default' }) {
      await ctx.credentials.deleteRecord(`my-feishu/token-${account}`)
    },
  },
}
```

约定：

- `start()` **立即返回** `{ url }`，不要在工具调用里阻塞等人。
- 授权完成后把 token 写入 `ctx.credentials` 的 `grant` record；`status()` 从同一位置读。
- 刷新 token 建议放在 `modifyRecord()` 的 mutation 内（跨进程锁），参考 Google adapter 的 `accessToken()`。
- `defaultAccount` 决定 `docs_connect`/`docs_read` 不传 `account` 时用哪个。

---

## 4. 文档模型与渲染

`read()` 返回 `DocumentSnapshot`：

```ts
{
  platform, documentId, title, url?, revision?,
  tabs: [{
    id, title, index?, depth?,
    blocks?: DocBlock[],   // 推荐
    text?: string,         // 直出时用；优先于 blocks
    startIndex?, endIndex? // 原生 index，供 docs_insert
  }]
}
```

### blocks

| type | 字段 | 渲染 |
| --- | --- | --- |
| `heading` | `level` 1-6, `text` | `# ...` |
| `paragraph` | `text` | 原样 |
| `list` | `text`, `level`, `ordered` | `-` / `1.` + 缩进 |
| `table` | `rows: string[][]` | Markdown 表格 |
| `image` | `alt` | `[image: alt]` |
| `break` | `kind` | `---` |
| `raw` | `text` | 原样 |

多 Tab 时 core 会自动加 `## Tab: 标题 \`id\`` 头，模型据此选择写入目标。单 Tab 默认不加。

### index

`docs_insert` 的 `index` 使用平台原生单位。Google 是 **UTF-16 code unit**，且受段落/表格结构约束。请把 `startIndex/endIndex` 填到 tab 上，core 会展示给模型；adapter 自己仍要校验范围。

---

## 5. 写入语义

### 5.1 返回值

```ts
{
  revision?: string,            // 写入后的 revision（能拿到就返回）
  tab?: string,
  index?: number,
  occurrencesChanged?: number,  // replace
  insertedChars?: number,
  documentId?: string,          // create
  url?: string,                 // create
}
```

`platform` / `documentId` 由 core 合并；adapter 不用重复填（create 除外）。

### 5.2 revision 保护

- 调用方传入 `expectedRevision` 时，**必须原样使用**，不能替换成刚读到的新值。
- 没有传入时，若支持 revision，建议在写前读一次并把当前 revision 放进写请求的等价字段（Google 是 `writeControl.requiredRevisionId`）。
- revision 冲突时抛 `DocsError`，`code: 'REVISION_CONFLICT'`，`hint` 写清“重新读取后重试”。

### 5.3 幂等性

通用工具层不会自动重试写操作。请在 adapter 内遵守：

- 429/5xx 等**明确未生效**的响应可以有限重试；
- 网络超时/断连属于“结果未知”，不要重试，抛 `UPSTREAM` 并提示先读文档确认。

### 5.4 文本与 Tab

- `docs_append` 不传 tab 时，core 默认第一个 Tab；adapter 要按 `resolveTab(snapshot, request.tab)` 的语义处理。
- `docs_replace` 不传 tab 时，Google 的语义是**全部 Tab**；如果你的平台默认只替换第一个 Tab，请在 adapter 里明确实现并在 `hint`/描述里说明。

---

## 6. 错误约定

统一抛“带 code 的 Error”。两种写法等价：

```js
// A. 零依赖（推荐给独立包）
const error = new Error('document is not shared with this account')
error.code = 'FORBIDDEN'          // 必须在下方词表内
error.platform = 'notion'
error.hint = 'Share the page with the integration, then retry.'
error.retryable = false
error.details = { status: 403 }
throw error

// B. 能解析到本包时
import { DocsError, DOCS_ERROR } from '@local/docs-connector/core'
throw new DocsError('document is not shared with this account', {
  code: DOCS_ERROR.FORBIDDEN,
  platform: 'notion',
  hint: 'Share the page with the integration, then retry.',
  details: { status: 403 },
})
```

| code | 含义 | 常见处理 |
| --- | --- | --- |
| `AUTH_REQUIRED` | 没授权/授权失效 | 提示 `docs_connect` |
| `NOT_CONFIGURED` | 客户端或凭据未配置 | 提示配置步骤 |
| `FORBIDDEN` | 无权限/scope 不足 | 检查共享与 scope |
| `NOT_FOUND` | 找不到 | 检查 id/账号；404 可能只是不可见 |
| `REVISION_CONFLICT` | 写入基线过期 | 重新读取 |
| `RATE_LIMITED` | 限流 | 退避后重试 |
| `UPSTREAM` | 上游/网络失败 | 读可重试；写先确认 |
| `UNSUPPORTED` | 能力未实现 | 不要注册该能力 |
| `INVALID_INPUT` | 参数/索引非法 | 修正参数 |

工具会把 `code`、`message`、`hint` 渲染成 `[CODE] message\nNext: hint`。不要在 `message` 里放 token、secret、完整响应体。

---

## 7. 测试建议

Adapter 是纯对象，可以完全脱离 Harness 测试：

```js
const ctx = {
  get: (name) => name === 'credentials' ? memoryCredentials : undefined,
  logger: () => console,
  effect(generator) {
    const iterator = generator()
    const disposers = []
    for (let step = iterator.next(); !step.done; step = iterator.next()) {
      if (typeof step.value === 'function') disposers.push(step.value)
    }
    return () => disposers.reverse().forEach((fn) => fn())
  },
}
const dispose = ctx.docs.registerAdapter(adapter, ctx)
```

用本地 `http.createServer()` 模拟平台 API，避免真实网络；参考 `test/support/fake-google.js`（含 OAuth token 端点、batchUpdate、revision 冲突、可注入 429/401）。

Adapter 重点测试：

- `parseRef` 的 URL/id/非法输入；
- `read` 的多 Tab、表格、空文档、嵌套结构；
- 写入请求体（tab、index、revision、替换范围）；
- 错误映射和 `hint`；
- 授权 state/PKCE/回调失败；
- 资源释放（`close()`、loopback server）。

---

## 8. 常见坑

1. **不要 import `@deepseek-ai/dsh-tools` 等运行时包**。插件通过 `ctx.tools.register()` 直接接收原始定义；零依赖才能 `link:` 即用。
2. **`registerAdapter(adapter, ctx)` 的第二个参数要传自己的 ctx**，否则卸载 adapter 行时不会注销。
3. **`parseRef` 收到的已经是去掉 `<platform>:` 前缀的内容**；不要假设带前缀。
4. **不要给 tab 用会变的 id**。Google 的 `t.0` 在重排后可能变化，必须每次从 `read` 结果里取。
5. **index 不是字符数**。Google 用 UTF-16 code unit；emoji 占 2。
6. **不要吞掉取消信号**。所有网络调用都带 `signal`，被取消时抛 `CANCELLED`。
7. **多 Tab 写入必须显式 `tabId`**，否则 Google 默认写第一个 Tab。
8. **不要在日志里打印 token**；需要诊断时只打印状态码、请求 id、错误 code。
