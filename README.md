# 文档连接器（Docs Connector）

把外部文档平台接入 DeepSeek Harness 的插件。第一期实现 **Google Docs**：读取、创建、追加、按位置插入、查找替换、多 Tab 读写，并带 OAuth 2.0（PKCE + loopback）授权。

> 设计重点不是“只支持 Google Docs”，而是**平台无关的 Adapter 层**：核心只认 `parseRef / read / create / append / insert / replace / auth / invoke` 这些最小契约，新增平台（Notion、飞书、语雀、Confluence……）只需要新增一个 adapter 包 + 一行 composition，不需要改模型工具。

- 包名：`@local/docs-connector`（本地 bundle，可按需改名发布）
- 入口：`package.json` → `dsh.bundle.patch` → `cordis.patch.yml`
- 依赖：**零运行时依赖**，不需要构建、不需要 `pnpm install` 插件自身
- 当前验证：45 个自动化测试 + 真实 `@deepseek-ai/dsh-tools` schema 校验 + 真实 Harness profile 启动验证

---

## 0. 最短路径（5 步）

1. 安装 bundle：Plugins → **Add plugin** → 填本目录绝对路径 → **Enable now**（见 §2.1）。
2. 如果 Google 的 OAuth 客户端需要 client secret，在 `~/.dsh/.credentials.yaml` 的 `refs` 下加
   `GOOGLE_DOCS_CLIENT_SECRET: GOCSPX-...`（文件 0600；热加载，不用重启）。
3. 对 agent 说：**“用 clientId `xxxx.apps.googleusercontent.com` 连接 Google Docs”**。
4. 浏览器里同意授权；再说“列出文档平台”，确认 `authorized`。
5. 之后就可以：“读取 `<Google Docs URL>`”、“在标签页 Notes 末尾追加……”、“把“待完成”替换成“已完成””。

> 代理默认已配置为 `http://127.0.0.1:7897`；如你的代理地址不同，改 `cordis.patch.yml` 的 `proxy`，或设成 `direct` 走直连。

---

## 1. 架构

```text
┌─────────────────────────────────────────────────────────────┐
│ docs_* tools（lib/tools）                                    │
│   docs_platforms / docs_connect / docs_disconnect            │
│   docs_list / docs_read / docs_create / docs_append          │
│   docs_insert / docs_replace / docs_sheet_update             │
│   docs_sheet_append / docs_sheet_format                      │
│   docs_slide_insert_text / docs_invoke                        │
└───────────────────────────┬─────────────────────────────────┘
                            │  只依赖 ctx.docs（平台无关）
┌───────────────────────────▼─────────────────────────────────┐
│ DocsService + AdapterRegistry（lib/core）                     │
│   · 适配器注册 / 能力发现 / 默认平台选择                       │
│   · 文档引用解析（URL、原生 id、<platform>:<id>）              │
│   · 中性文档模型（tabs + blocks）与文本渲染                    │
│   · 错误码、能力检查、结果归一化                               │
└───────────────────────────┬─────────────────────────────────┘
                            │  DocumentAdapter 契约
┌───────────────────────────▼─────────────────────────────────┐
│ Google Docs adapter（lib/adapters/google）                    │
│   OAuth PKCE + loopback + token 存储/刷新                     │
│   Docs API client（重试、错误映射、revision 保护）             │
│   Google 结构 → blocks；写入请求构造                           │
└─────────────────────────────────────────────────────────────┘
```

### 为什么 Adapter 是“自由”的

1. **只有三个硬要求**：`id`、`title`、`parseRef()`；其余全部可选。
2. **能力自动推断**：实现了 `read()` 就有读能力；显式 `capabilities.read: false` 才关闭。
3. **渲染方式自由**：adapter 可以返回 `blocks`（推荐，跨平台统一渲染），也可以直接返回每个 tab 的 `text`。
4. **授权方式自由**：`auth` 完全可选；没有 `auth` 的平台（比如本地文件、匿名只读 API）不需要实现。
5. **逃生通道**：`invoke()` + `docs_invoke` 可以暴露平台私有操作（Google 的原始 `batchUpdate` 就是内置例子），不用为了一个特殊需求污染通用接口。
6. **独立 composition 行**：core / adapter / tools 是三行，可单独替换。第三方 adapter 是独立包，只依赖 `@local/docs-connector/types`（纯类型）。

完整契约见 [`lib/types/index.d.ts`](lib/types/index.d.ts)，手把手示例见 [docs/adapter-authoring.md](docs/adapter-authoring.md)。

---

## 2. 安装

### 2.1 安装到当前 Desktop profile（推荐）

1. 打开 Harness Web UI → 左侧 **Plugins**。
2. **Add plugin** → 选择 **Install a third-party plugin**。
3. 包地址填写本目录绝对路径：

   ```text
   /Users/xuewen/ai-lab/project/connectionPlugin
   ```

4. 安装完成后 **Enable now**。如果页面提示需要重启，重启 DeepSeek Harness。
5. 开启一个会话，对模型说：“列出文档平台”，应看到 `docs_platforms` 工具返回 Google Docs。

本地目录安装使用 `link:`，之后改代码只需重启应用（不需要重新安装）。

### 2.2 开发/验证用独立 profile

不影响 Desktop profile：

```bash
dsh --profile docs-dev --from-default-profile web --dump-config
dsh plugin --profile docs-dev add link:/Users/xuewen/ai-lab/project/connectionPlugin
dsh --profile docs-dev --dump-config | grep -A20 docs-connector
dsh --profile docs-dev --port 0 --no-open     # 验证激活；Ctrl-C 退出
```

`dsh plugin add link:` 会自动把 bundle 加入 `dsh.profile.bundles`。本仓库的开发验证就是用这个 profile 完成的。

### 2.3 目录结构

```text
.
├── package.json                 # bundle 清单（dsh.bundle.patch / exports / icon）
├── cordis.patch.yml             # 三行 composition：core、google adapter、tools
├── index.js                     # 根 row → lib/core
├── lib/
│   ├── core/                    # errors / registry / 中性文档模型 / service
│   ├── adapters/google/         # config / auth / client / convert / proxy / index
│   ├── tools/                   # docs_* 工具与系统提示
│   ├── tool-kit.js              # 零依赖的工具定义与参数校验
│   └── types/index.d.ts         # Adapter 公开类型契约
├── locale/{en,zh}.json          # 插件标题/描述
├── icon.svg
├── test/                        # node:test，45 个用例
└── docs/
    ├── google-docs-api-integration-guide.md
    └── adapter-authoring.md
```

---

## 3. Google Cloud 准备

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)，创建/选择项目。
2. **APIs & Services → Library** 按需启用：
   - **Google Docs API**：读写 Docs（必需）
   - **Google Sheets API**：读写表格单元格
   - **Google Slides API**：读写幻灯片
   - **Google Drive API**：`docs_list` 列文件、按 id 判断文件类型（只读 metadata）
3. **Google Auth platform** 配置应用名称、支持邮箱、Audience（External + Testing 时添加测试用户）、Data Access scopes。
4. **Clients → Create client**：
   - 本机 Harness 用 **Desktop app**（最简单，loopback 端口不需要预先登记）。
   - 如果要接远程/固定回调，用 **Web application**，并把 `http://127.0.0.1:<port>/` 登记为 redirect URI。
5. 记下 `client_id`；桌面客户端通常也需要 `client_secret`（Google 的 token 端点会要求）。

Scopes（默认申请两个，都是最小集）：

| scope | 用途 |
| --- | --- |
| `https://www.googleapis.com/auth/documents` | 读写 Docs（默认） |
| `https://www.googleapis.com/auth/spreadsheets` | 读写 Google 表格单元格（默认） |
| `https://www.googleapis.com/auth/presentations` | 读写 Google 幻灯片（默认） |
| `https://www.googleapis.com/auth/drive.metadata.readonly` | `docs_list` 列文件 + 按 id 识别类型（默认） |
| `https://www.googleapis.com/auth/documents.readonly` | 只读部署 |
| `https://www.googleapis.com/auth/drive.file` | 只操作应用创建/经选择器授权的文件 |

> 普通 txt 文件的内容读写需要 **`drive` / `drive.readonly`（受限 scope）**，当前版本**不支持**；`docs_list` 仍会列出它们，但 `docs_read` 会明确报 `UNSUPPORTED`。

> 只读部署：把 `scopes` 换成 `documents.readonly` + `drive.metadata.readonly`。
> 不想要“列文档”能力：从 `scopes` 里删掉 `drive.metadata.readonly`，`docs_list` 会以 `FORBIDDEN` + 重新授权提示失败（而不是偷偷放宽权限）。
> 授权过的旧 token 不含新 scope，改 `scopes` 后必须 `docs_connect({ force: true })` 重新授权。

---

## 4. 配置插件

### 4.1 配置放在哪

插件行配置来自 `cordis.patch.yml`。安装后如需覆盖，编辑当前 profile 的 patch 文件（Desktop 默认 `~/.dsh/profiles/desktop/cordis.patch.yml`）：

```yaml
- id: docs-connector-google
  config:
    clientId: 1234567890-xxxxxxxxxxxxxxxx.apps.googleusercontent.com
    # patch 会整体替换该行 config，所以要把想保留的字段一起写上
    proxy: http://127.0.0.1:7897
    proxyFromEnv: true
    scopes:
      - https://www.googleapis.com/auth/documents
      - https://www.googleapis.com/auth/drive.metadata.readonly
    redirectPort: 0
    autoOpenBrowser: true
    guardWrites: true
```

> **注意**：Cordis patch 对同一行的 `config` 是**整行替换**，不是深度合并。只写 `clientId` 会让 `proxy` 回到代码默认值（空）。
> 本项目在 `cordis.patch.yml` 里已经把 `proxy` 默认成 `http://127.0.0.1:7897`。

### 4.2 clientId（公开信息）

三种方式，优先级从高到低：

1. 行的 `clientId` 配置。
2. 凭据引用 `GOOGLE_DOCS_CLIENT_ID`（`~/.dsh/.credentials.yaml` 的 `refs`，或环境变量）。
3. 直接对模型说：

   > 用 clientId `xxxx.apps.googleusercontent.com` 连接 Google Docs

   模型调用 `docs_connect({clientId})`，该公开 id 会写入凭据记录
   `docs-connector/google-docs-config`，之后自动复用。

### 4.3 clientSecret（敏感信息）

**不要把 secret 贴在对话里。** 支持：

- `~/.dsh/.credentials.yaml`（推荐，热加载，不用重启）：

  ```yaml
  version: 1
  refs:
    GOOGLE_DOCS_CLIENT_SECRET: GOCSPX-xxxxxxxx
  ```

- 行的 `clientSecretRef` 指向其他引用名；或临时用环境变量
  `GOOGLE_DOCS_CLIENT_SECRET`（`$DSH_HOME/.env` 需重启才进入启动环境快照）。
- 不推荐但支持：行内 `clientSecret: ...`（会出现在配置里，仅用于无凭据存储的部署）。

### 4.4 代理（中国大陆网络必看）

**Node 自带的 `fetch()` 不读取 `HTTPS_PROXY`**，所以插件自己实现了代理传输，默认走：

```yaml
proxy: http://127.0.0.1:7897
```

支持：

- `http://` / `https://` 代理：`CONNECT` 隧道 + 目标 TLS（不是明文转发）。
- `socks5://` / `socks5h://`：内置 RFC 1928 握手（无认证或用户名/密码）。
- `proxy: direct`（或 `none`）强制直连。
- `proxyFromEnv: true` 时，`proxy` 为空则读取 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`。
- `NO_PROXY` 生效；`127.0.0.1` / `localhost` / `::1` **永远直连**（OAuth 回调用）。
- 代理 URL 里的账号密码不会出现在日志或报错中（`redactProxy`）。

验证代理是否通：

```bash
curl -x http://127.0.0.1:7897 -m 15 -o /dev/null -w '%{http_code}\n' https://docs.googleapis.com/v1/documents/x
# 期望 401（说明隧道和 TLS 都通，只是没带 token）
```

### 4.5 全部 Google 行配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `clientId` | `''` | OAuth client id（公开） |
| `clientSecretRef` | `GOOGLE_DOCS_CLIENT_SECRET` | secret 的凭据引用名 |
| `clientSecret` | `''` | 直接写 secret（不推荐） |
| `scopes` | `[documents, spreadsheets, presentations, drive.metadata.readonly]` | 首次授权申请的 scope；删掉 Drive scope 即关闭 `docs_list`，删掉 sheets/slides 就只支持 Docs |
| `account` | `default` | 默认账号标签 |
| `redirectPort` | `0` | loopback 回调端口；0 自动选空闲端口 |
| `redirectPath` | `/` | 当 `redirectUri` 为空时使用 |
| `redirectUri` | `''` | 完整回调地址（Web application 客户端用），必须是 loopback |
| `autoOpenBrowser` | `true` | 授权时自动打开系统浏览器 |
| `prompt` | `consent` | 授权页 prompt；确保首次拿 refresh token |
| `includeGrantedScopes` | `true` | 增量授权 |
| `timeoutMs` | `30000` | 单次 Google HTTP 超时（token 请求另有 15s 上限） |
| `maxRetries` | `2` | 读请求重试次数；写请求最多 1 次且只针对 429/5xx |
| `guardWrites` | `true` | 写前读取 revision 并带 `requiredRevisionId` |
| `refreshRevisionAfterWrite` | `true` | batchUpdate 没回 revision 时，写完再读一次拿到新 revision（避免把旧 revision 交给模型） |
| `allowRawActions` | `false` | 允许 `docs_invoke` 的 Google 原始操作 |
| `proxy` | `''`（patch 里为 `127.0.0.1:7897`） | 代理地址或 `direct` |
| `proxyFromEnv` | `true` | 无显式代理时读环境变量 |
| `proxyBypass` | `[]` | 额外 NO_PROXY 主机 |
| `apiBase` | `https://docs.googleapis.com` | 测试/网关可覆盖 |
| `driveApiBase` | `https://www.googleapis.com` | Drive metadata / `docs_list`，测试/网关可覆盖 |
| `sheetsApiBase` | `https://sheets.googleapis.com` | Sheets API，测试/网关可覆盖 |
| `slidesApiBase` | `https://slides.googleapis.com` | Slides API，测试/网关可覆盖 |
| `authEndpoint` / `tokenEndpoint` / `revokeEndpoint` | Google 官方 | 测试/私有网关可覆盖 |

---

## 5. 授权

对模型说：

> 连接 Google Docs

模型调用 `docs_connect`：

1. 插件在本机 `127.0.0.1` 起一个临时 loopback HTTP 服务，生成 `state` + PKCE。
2. 自动打开浏览器（可关掉 `autoOpenBrowser`，工具结果里始终有 URL）。
3. 用户同意后，回调校验 `state`，用 `code + code_verifier` 换 token。
4. token 写入凭据记录 `docs-connector/google-docs-<account>`，refresh token 不保证每次返回，**缺失时不会覆盖已保存的值**。
5. 页面提示完成后，再调用 `docs_platforms` 确认 `authorized`。

```text
docs_connect({ platform: "google-docs", waitSeconds: 0 })
  → { status: "pending", url: "https://accounts.google.com/o/oauth2/v2/auth?..." }
```

`waitSeconds`（0–120）可以让工具等用户点完再返回；不传则立即返回 URL。

### 多账号

```text
docs_connect({ platform: "google-docs", account: "work", clientId: "..." })
docs_read({ document: "...", account: "work" })
```

每个账号一条独立凭据记录；`docs_disconnect({account})` 只删该账号（并尽力调用 Google revoke）。

### 常见授权问题

- **External + Testing** 的 OAuth 应用，Docs scope 通常只发 **7 天 refresh token**；长期使用要发布/验证应用，或接受定期重连。
- 浏览器和 Harness 不在同一台机器时，loopback 回调无法到达。请把 Harness 跑在浏览器所在的机器，或改成同一网络内可访问的方案（当前版本只支持 loopback）。
- 刷新失败（`invalid_grant`）会返回 `AUTH_REQUIRED`，重新 `docs_connect` 即可。
- 只读 scope 下写文档会得到 `FORBIDDEN`，提示里会说明需要重新授权 `documents` scope。
- 没有 `drive.metadata.readonly` 时调用 `docs_list` 会得到 `FORBIDDEN`，提示里会点名缺的 scope；`docs_connect({ force: true })` 重新授权即可（增量授权不会丢已有 scope）。

---

## 6. 模型工具

| 工具 | 作用 | 关键点 |
| --- | --- | --- |
| `docs_platforms` | 列出平台、能力、授权状态 | 工作流第一步；连接后复查 |
| `docs_connect` | 启动授权 | 可带公开 `clientId`；`waitSeconds` 可等待 |
| `docs_disconnect` | 删除本地授权 | 不影响文档本身 |
| `docs_list` | 列出账号下的文档 | Google 走 Drive `files.list`（`drive.metadata.readonly`），按修改时间倒序；`type` 可选 `document`（默认）/ `spreadsheet`（Google 表格）/ `presentation` / `all`；支持 `query` 标题过滤与 `pageToken` 翻页 |
| `docs_read` | 读取文档/单 Tab | 自动识别类型：Docs 渲染正文，表格每个 sheet 一张 Markdown 表，幻灯片每页一个 tab |
| `docs_sheet_update` | 覆盖表格某个 A1 区域 | 例 `range: "Sheet1!A1:C3"`；返回实际更新的行列/单元格数 |
| `docs_sheet_append` | 在表格末尾追加行 | 不传 `range` 时追加到第一个 sheet；必要时自动扩展行数 |
| `docs_sheet_format` | 表格格式/结构（透传 Sheets batchUpdate） | `repeatCell`（格式写在 `cell.userEnteredFormat` 下，加粗/底色/边框/对齐/换行/数字格式）、`mergeCells`、`updateDimensionProperties`（列宽/行高）、`updateSheetProperties`（冻结行）、`addSheet`/`deleteSheet`；大批量用 `requestsFile` 读 JSON 清单（上限 5 MB） |
| `docs_slide_insert_text` | 往幻灯片文本框末尾追加文字 | 目标页必须已有文本框（Slides API 不建形状）；`slide` 传 tab id 或 0-based 序号 |
| `docs_create` | 新建文档 / 表格 | Docs：先 create 再 batchUpdate 写正文；Sheets：`kind: "spreadsheet"` + `sheets: [{ title, values }]`，按 RAW 写入、保留空表与表名 |
| `docs_append` | 追加到 Tab 末尾 | 默认加前导换行；非幂等 |
| `docs_insert` | 在原生 index 插入 | Google index 是 UTF-16 code unit |
| `docs_replace` | 查找替换 | 不传 tab 时 Google 默认全 Tab；返回实际替换次数 |
| `docs_invoke` | 平台私有操作 | Google：`getRaw` / `batchUpdate` / `createDocument` / `listDocuments`（需 `allowRawActions`） |

> 幻灯片写入有两条路径：`docs_replace` 全篇替换文本，`docs_slide_insert_text` 往指定页追加文本。

### 示例对话

```text
用户：把这份文档里所有“待完成”改成“已完成”
模型：docs_list({ type: "spreadsheet" })            // 找 Google 表格
模型：docs_sheet_append({ document: "1lNQ…", values: [["买牛奶", "待办"]] })
模型：docs_read({ document: "https://docs.google.com/document/d/..." })
      → revision r-123，2 个 Tab
模型：docs_replace({ document: "...", find: "待完成", replace: "已完成", tab: "t.1", expectedRevision: "r-123" })
      → occurrencesChanged: 3
模型：把结果和 revision 汇报给用户
```

> 写入默认带 `requiredRevisionId`。如果读取后有人改了文档，Google 返回 400，插件映射为 `REVISION_CONFLICT`，提示重新读取——**不会静默覆盖**。

### 非幂等写入

Google Docs 的 `insertText` 不是幂等的。网络超时/断连时，插件**不会自动重试写请求**，而是返回 `UPSTREAM` 并提示“先读文档确认是否已写入，再决定是否重试”。这是刻意设计，避免重复追加。

---

## 7. Adapter 开发

一句话版本：

```js
export const inject = ['docs']

export function apply(ctx, config) {
  const adapter = {
    id: 'my-platform',
    title: 'My Platform',
    parseRef(input) {
      return input.startsWith('https://my.example/doc/')
        ? { documentId: input.split('/').pop(), url: input }
        : null
    },
    async read(ref) {
      const doc = await myApi.get(ref.documentId)
      return {
        platform: 'my-platform',
        documentId: ref.documentId,
        title: doc.title,
        revision: doc.version,
        tabs: [{ id: 'body', title: doc.title, blocks: doc.blocks }],
      }
    },
  }
  return ctx.docs.registerAdapter(adapter, ctx)
}
```

要点：

- `registerAdapter(adapter, ctx)` 的第二个参数是**所有者 context**；adapter 会随该 plugin 卸载而自动注销。
- `capabilities` 可省略；实现了方法就自动具备（`list()` → `docs_list`，`updateValues()`/`appendValues()` → `docs_sheet_update`/`docs_sheet_append`）。
- 一个 adapter 可以处理多种文件类型：Google adapter 就是 `read()` 里按 Drive metadata 返回的 MIME 类型分发到 Docs / Sheets / Slides。
- `read()` 返回 `tabs`，每个 tab 提供 `blocks` 或 `text`，两者都有则 `text` 优先。
- 写入方法只返回 `{ revision?, tab?, index?, occurrencesChanged?, insertedChars?, documentId? }`，身份字段由 core 合并。
- 需要平台私有操作时实现 `invoke()`；它由 `docs_invoke` 暴露。
- 有授权流程时实现 `auth.status/start/disconnect`，token 建议存 `ctx.credentials` 的 grant record。

完整教程（含 Notion 风格示例、错误约定、能力矩阵）：[docs/adapter-authoring.md](docs/adapter-authoring.md)。

---

## 8. 安全模型

- **token 只进凭据库**：`~/.dsh/.credentials.yaml`（文件 0600），不写配置、不写日志、不进会话。
- **secret 不进对话**：只支持凭据引用/环境变量/行配置；工具 schema 里没有 secret 参数。
- **clientId 是公开值**：允许经 `docs_connect` 传入并持久化。
- **回调**：只绑定 `127.0.0.1`，校验 `state`（常量时间比较），页面带 CSP、`no-store`；不打印 code/token。
- **文档内容是不可信数据**：系统提示明确要求模型不要把文档里的指令当成指令（防 prompt injection）。
- **代理凭据**：日志/错误里打码；CONNECT 隧道不是明文转发。
- **并发**：写操作默认 `requiredRevisionId`；token 刷新在凭据记录的跨进程锁内进行，避免两个进程同时轮换 refresh token。

---

## 9. 排错

| 现象 | 原因/处理 |
| --- | --- |
| `[NOT_CONFIGURED] Google OAuth client id is not configured` | 调 `docs_connect({clientId})`，或配置行 `clientId` |
| `[NOT_CONFIGURED] the credential store is unavailable` | 当前 composition 没加载 `@deepseek-ai/dsh-credentials-local` |
| 授权页打开后回调失败 | 浏览器与 Harness 不在同一台机器；只能 loopback |
| `[AUTH_REQUIRED]` | token 过期/撤销；`docs_connect` 重连 |
| `[FORBIDDEN]` | 账号没有文档权限，或 scope 不足（提示会区分；`docs_list` 缺 Drive metadata scope 也在这里） |
| `[NOT_CONFIGURED] ... has not been used in project ... or it is disabled` | 项目没启用对应 API：Docs 读写要 **Google Docs API**，表格要 **Google Sheets API**，幻灯片要 **Google Slides API**，`docs_list` 要 **Google Drive API**；启用后等 1–2 分钟重试 |
| `[UNSUPPORTED] ... Only Google Docs, Google Sheets, and Google Slides` | 该 id 是上传的 Office/PDF 等非原生文件，当前不支持其内容读写 |
| `[NOT_FOUND]` | id 错误，或账号看不到该文档（404 不等于不存在） |
| `[REVISION_CONFLICT]` | 读取后文档被他人修改；重新 `docs_read` 后重算写入 |
| `[RATE_LIMITED]` | 429；已按 Retry-After/指数退避重试，仍失败则等待后重试 |
| 无法访问 Google | 检查代理：`proxy` 配置、代理进程、`curl -x` 验证 |
| 写入超时/断连 | 不要直接重试；先 `docs_read` 确认是否已生效 |
| `[UPSTREAM] cannot reach the proxy` | 代理没启动或地址错误；临时设 `proxy: direct` 验证直连 |

---

## 10. 测试与验证

```bash
npm test
```

覆盖 89 个用例：

- Google 文档结构 → blocks/多 Tab/表格/标题/列表/链接。
- 表格：结构 + 值读取、按 sheet 分 tab、200×30 截断说明、A1 区域覆盖、追加行。
- 幻灯片：按页分 tab、标题占位符 → heading、全篇替换、按页追加文本。
- 类型识别：Drive metadata 分发、旧授权降级、非原生文件报 `UNSUPPORTED`。
- 端到端（`test/e2e-google.test.js`）：Service → adapter → 假 Google 的完整读写回读。
- 装配冒烟（`test/plugin-boot.test.js`）：按 `cordis.patch.yml` 挂载三行，断言 13 个工具与全部能力，再用工具完成「列 → 读 → 写表格 / 读 → 写幻灯片」。
- 建表：`spreadsheets.create` + `values:batchUpdate`（RAW），保留表名与空表，拒绝重复/空表名。
- 格式：`docs_sheet_format` 透传 batchUpdate（含 `requestsFile` 读清单），非表格 id 与空 `requests` 会被拒。
- 完整 OAuth：PKCE、授权码交换、state 不匹配、用户拒绝、断开。
- Docs API：读取、追加、插入、Tab 级替换、创建（含新建 Tab）。
- 401 刷新、429 重试、过期 revision 冲突。
- HTTP CONNECT 与 SOCKS5 代理（真实隧道计数断言）。
- Adapter 注册/能力推断/歧义解析/错误包装。
- 14 个工具的 schema、参数校验、渲染、错误提示。

另外完成：

- 用真实 `@deepseek-ai/dsh-tools@0.2.1-rc.5` 的 `assertSupportedJsonSchema` / `validateJsonSchemaValue` 校验全部工具 schema 与样例输出。
- 在独立 `docs-dev` profile 中真实启动 Harness，确认 14 个工具和 `google-docs` adapter 均注册成功；在真实 runtime 中执行 `docs_platforms`、`docs_list`、`docs_read`、`docs_create`、`docs_sheet_append`，验证返回结构与 `AUTH_REQUIRED` 提示。
- 通过本机代理 `127.0.0.1:7897` 对 `https://docs.googleapis.com` 发起真实请求，返回 `401`（隧道 + TLS 正常）。

### 对照 Google 对接文档的验收清单

- [x] 启用 Docs API、OAuth 授权拿到 access token
- [x] token 过期可刷新、失效可重新授权
- [x] 从文档 URL 解析 `documentId`
- [x] 读取多/嵌套 Tab（递归 `childTabs`）
- [x] 创建空白文档 + `batchUpdate` 写入正文
- [x] 指定 Tab 追加（不是默认 Tab）
- [x] 指定 Tab 查找替换并检查 `occurrencesChanged`
- [x] 过期 `revisionId` 被拒绝（`REVISION_CONFLICT`）
- [x] 401/403/404/400/429/超时 有明确处理
- [x] token/secret 不出现在日志、报错、配置（secret 走引用）

---

## 11. 已知限制 / 下一步

- 第一期只做 Google Docs，不包含 Drive 搜索/列表；文档必须已知 URL/id。
- 写入是纯文本/Markdown 字面量，不做富文本/样式/图片插入。
- `docs_create` 的 `tabTitle` 使用 `addDocumentTab`，旧 API 版本不支持时会退回默认 Tab（日志警告）。
- `docs_invoke` 默认关闭，需要 `allowRawActions: true`；开启后模型可以提交任意 Docs `batchUpdate` 请求，风险自负。
- 回调只支持 loopback；远程部署需要额外设计（网关回调 + 手动 code 输入）。
- 多账号目前按 account 标签隔离，但没有账号选择 UI。
- 后续可加：客户端设置页、Drive 搜索（需 Drive scope）、评论、图片/表格写入、`@` 文档引用。

---

## 12. 参考

- [Google Docs API 对接说明](docs/google-docs-api-integration-guide.md)
- [Adapter 开发指南](docs/adapter-authoring.md)
- [adapter 类型契约](lib/types/index.d.ts)
