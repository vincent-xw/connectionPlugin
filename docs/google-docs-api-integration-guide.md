# Google Docs API 对接说明

> 版本：1.0  
> 校验日期：2026-10-30  
> 范围：仅说明如何通过 Google 官方接口完成 Google Docs 的授权、创建、读取与更新。  
> 不包含：项目架构、语言/框架选择、本地服务协议、MCP、Google Drive 文件搜索、部署方案。

## 1. 接入目标与官方接口

Google Docs API v1 通过 OAuth 2.0 授权访问用户拥有或已获权限的 Google 文档。核心入口如下：

| 操作 | 方法 | 官方端点 |
| --- | --- | --- |
| 创建空白文档 | `POST` | `https://docs.googleapis.com/v1/documents` |
| 获取文档 | `GET` | `https://docs.googleapis.com/v1/documents/{documentId}` |
| 修改文档 | `POST` | `https://docs.googleapis.com/v1/documents/{documentId}:batchUpdate` |

`batchUpdate` 同时用于追加文字、按位置插入、查找替换、删除内容、更新文本格式等操作。每个请求经过校验；批次中有无效更新时，整个批次失败。Google Docs 采用结构化文档模型，而非以 Markdown 作为原生数据格式。

文档 ID 可从 Google Docs 链接提取：

```text
https://docs.google.com/document/d/{documentId}/edit
```

参考：[Docs API REST 参考](https://developers.google.com/workspace/docs/api/reference/rest)、[Get](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get)、[Batch update](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)。

## 2. Google Cloud 侧准备

1. 进入 [Google Cloud Console](https://console.cloud.google.com/)，创建或选择一个 Google Cloud 项目。
2. 在 **APIs & Services → Library** 中启用 **Google Docs API**。
3. 在 **Google Auth platform** 配置应用名称、支持邮箱、Audience（用户范围）及 Data Access（所需 OAuth scopes）。
4. 在 **Clients** 创建 OAuth 2.0 Client。按实际运行形态选择客户端类型：本机脚本/桌面应用常用 **Desktop app**；具备服务端回调的 Web 应用使用 **Web application**。不同客户端类型有不同的重定向 URI 与凭证要求。
5. 下载/保存客户端配置。妥善保护 `client_id`、服务端 `client_secret`（如适用）、授权产生的 Token；不要提交真实 Token 到代码仓库。
6. 如果应用处于 External + Testing 状态，添加测试用户，确保用于授权的账号具备测试资格。

> 仅接入指定文档的读取和编辑时，不需要同时启用 Google Drive API。若还要读写 Google 表格 / 幻灯片，则需同时启用 **Google Sheets API** / **Google Slides API** 并申请 `spreadsheets` / `presentations` scope。
>
> **实现现状（与本文设计稿的差异）**：本连接器的 Google adapter 额外提供 `docs_list`，通过 Drive `files.list`（`drive.metadata.readonly`，只读 metadata）列出账号下的 Google Docs。要做到这一点需要在项目里启用 **Google Drive API**，并在授权 scope 中加上该项；不想要该能力时删除该 scope 即可（`docs_list` 会明确报 scope 不足）。

参考：[Google Docs 身份验证与权限](https://developers.google.com/workspace/docs/api/auth)、[Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)、[配置 OAuth consent](https://developers.google.com/workspace/docs/api/quickstart/js)。

## 3. OAuth 权限范围

选择最小必要权限，不建议为了方便直接申请整个 Google Drive 的读写权限。

| Scope | 含义 | 典型情况 |
| --- | --- | --- |
| `https://www.googleapis.com/auth/documents.readonly` | 读取用户可访问的 Google Docs | 仅查看 |
| `https://www.googleapis.com/auth/documents` | 读取、创建与编辑用户可访问的 Google Docs | 按任意已授权文档 ID 读写，最直观 |
| `https://www.googleapis.com/auth/drive.file` | 访问由应用创建或经适当授权机制交给应用使用的特定文件 | 希望采用更小的逐文件授权范围 |
| `https://www.googleapis.com/auth/drive.metadata.readonly` | 只读文件 metadata（id、名称、类型、修改时间） | `docs_list` 列文档；本项目默认申请 |

**重要区别**：`drive.file` 并不表示“用户只要知道某个文档 ID，应用就一定有访问权限”。既有文件需要通过 Google 支持的授权/选择流程让应用获得该文件的访问权。若需求是操作用户已有的任意文档 ID，可评估 `documents` scope，并接受其敏感权限的验证要求。

`documents` 与 `documents.readonly` 被 Google 标记为 **Sensitive**；`drive.file` 通常属于 **Non-sensitive**。对外公开应用可能需要 Google 的 OAuth 应用验证。用户对文档本身仍需拥有相应阅读/编辑权限。

参考：[Choose Docs API scopes](https://developers.google.com/workspace/docs/api/auth)。

## 4. OAuth 2.0 授权流程

建议使用 **Authorization Code + PKCE**；尤其是本机/桌面应用。以下是协议层面的示例，与实现语言无关。

### 4.1 发起授权

先生成并临时保存：

- `state`：不可预测的随机字符串，用于校验回调；
- `code_verifier`：43–128 字符的高熵随机字符串；
- `code_challenge`：`BASE64URL(SHA256(ASCII(code_verifier)))`，去掉 `=` 填充。

浏览器打开以下 URL（实际使用时应对参数正确 URL 编码）：

```text
https://accounts.google.com/o/oauth2/v2/auth
  ?client_id={CLIENT_ID}
  &redirect_uri={REDIRECT_URI}
  &response_type=code
  &scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdocuments
  &state={STATE}
  &code_challenge={CODE_CHALLENGE}
  &code_challenge_method=S256
  &access_type=offline
```

`REDIRECT_URI` 必须与 OAuth 客户端类型和 Google 控制台允许的回调配置相匹配。桌面应用一般通过系统浏览器和 `http://127.0.0.1:{port}` loopback 回调取得授权码；Web 应用使用预注册的回调地址。这里的 URL 是为阅读而换行的示意，实际请求必须是一行完整 URL。

如果需要重新获取用户同意，可按需使用 `prompt=consent`，但不应每次调用 API 都弹出授权页面。

### 4.2 回调校验与换取 Token

用户授权后，回调地址收到 `code` 和 `state`。先校验 `state` 一致，再向 Google Token Endpoint 发送：

```http
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

client_id={CLIENT_ID}&code={AUTH_CODE}&code_verifier={CODE_VERIFIER}&redirect_uri={REDIRECT_URI}&grant_type=authorization_code
```

上面是参数示意，实际发送需进行 `application/x-www-form-urlencoded` 编码；某些客户端配置也会使用 `client_secret`，以 Google 对该客户端类型的要求为准。成功响应通常包括：

```json
{
  "access_token": "ACCESS_TOKEN",
  "expires_in": 3599,
  "refresh_token": "REFRESH_TOKEN",
  "scope": "https://www.googleapis.com/auth/documents",
  "token_type": "Bearer"
}
```

`refresh_token` **不保证每次授权码交换都会返回**。如果已保存有效 Refresh Token，不能因后续响应缺少该字段就用空值覆盖。

### 4.3 刷新 Access Token

```http
POST https://oauth2.googleapis.com/token
Content-Type: application/x-www-form-urlencoded

client_id={CLIENT_ID}&refresh_token={REFRESH_TOKEN}&grant_type=refresh_token
```

`client_secret` 是否必需同样取决于客户端类型/配置。实际调用时通过 POST 表单发送参数；成功后使用新的 `access_token`。

**注意**：External + Testing 状态的 OAuth 应用，包含 Google Docs 类权限时，Google 通常签发 **7 天有效期**的 Refresh Token；正式长期使用要规划发布状态与验证流程。此外，Refresh Token 也可能因用户撤销授权、安全策略或数量限制而失效，需支持重新授权。

参考：[OAuth 2.0 for Desktop Apps](https://developers.google.com/identity/protocols/oauth2/native-app)、[Using OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)。

## 5. Google Docs REST 调用规范

所有示例里的 `{ACCESS_TOKEN}` 是 OAuth 取得的令牌；`{DOCUMENT_ID}` 是文档 ID。访问现有文档时，账号必须拥有相应文件权限。

### 5.1 创建文档

```http
POST https://docs.googleapis.com/v1/documents
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json

{
  "title": "Google Docs API 测试文档"
}
```

响应含 `documentId` 和 `title`。**`documents.create` 只创建空白文档**；即使在创建请求体附加正文，Google 也会忽略。要写正文，随后调用 `batchUpdate`。

参考：[documents.create](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/create)。

### 5.2 读取文档（推荐显式启用多 Tab）

```http
GET https://docs.googleapis.com/v1/documents/{DOCUMENT_ID}?includeTabsContent=true
Authorization: Bearer {ACCESS_TOKEN}
```

重要响应字段示意（为便于说明，已省略大量字段）：

```json
{
  "documentId": "DOCUMENT_ID",
  "title": "Google Docs API 测试文档",
  "revisionId": "OPAQUE_REVISION_ID",
  "tabs": [
    {
      "tabProperties": {
        "tabId": "TAB_ID",
        "title": "标签页 1"
      },
      "documentTab": {
        "body": {
          "content": [
            {
              "paragraph": {
                "elements": [
                  { "textRun": { "content": "这是正文。\n" } }
                ]
              }
            }
          ]
        }
      },
      "childTabs": []
    }
  ]
}
```

说明：

- `revisionId` 是不透明的修订标识，不是自增版本号；只有具备编辑访问权时才会返回。
- `includeTabsContent=true` 时，正文要从 `tabs[].documentTab.body.content` 读取，而不是旧的顶层 `body` 字段。
- `childTabs` 可能递归嵌套。读取完整文档时要递归遍历所有标签页。
- 段落文字位于 `paragraph.elements[].textRun.content`，但文档也可能包含表格、图片、列表、页眉、脚注等结构；不能假设整个 `body.content` 都是纯文本段落。
- 如果省略 `includeTabsContent=true`，默认主要返回第一个 Tab 的内容，容易漏读后续标签页。

参考：[documents.get](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get)、[Work with tabs](https://developers.google.com/workspace/docs/api/how-tos/tabs)。

### 5.3 在指定标签页末尾追加文本

```http
POST https://docs.googleapis.com/v1/documents/{DOCUMENT_ID}:batchUpdate
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json

{
  "requests": [
    {
      "insertText": {
        "endOfSegmentLocation": {
          "tabId": "TAB_ID"
        },
        "text": "\n新增一行内容"
      }
    }
  ]
}
```

`endOfSegmentLocation` 表示目标正文段的末尾插入点（最后一个换行符之前），不是“整篇文档结构最后一个 JSON 元素”。如果不传 `tabId`，`insertText` 默认作用于第一个标签页。追加之前应明确文本是否需要前置换行，以防与前一段文字连在一起。

### 5.4 查找并替换文本

```http
POST https://docs.googleapis.com/v1/documents/{DOCUMENT_ID}:batchUpdate
Authorization: Bearer {ACCESS_TOKEN}
Content-Type: application/json

{
  "requests": [
    {
      "replaceAllText": {
        "containsText": {
          "text": "待完成",
          "matchCase": true
        },
        "replaceText": "已完成",
        "tabsCriteria": {
          "tabIds": ["TAB_ID"]
        }
      }
    }
  ]
}
```

默认情况下，`replaceAllText` **会影响所有标签页**；限制在指定 Tab 时必须传 `tabsCriteria.tabIds`。返回的对应 `replies[].replaceAllText.occurrencesChanged` 可用于判断实际替换数量；如果没有命中，则可能是 0。

**不要在不确定上下文时对通用词执行全局替换**；这是 API 的合法行为，但可能产生意外的业务修改。

### 5.5 在指定位置插入文本

```json
{
  "requests": [
    {
      "insertText": {
        "location": {
          "index": 1,
          "tabId": "TAB_ID"
        },
        "text": "开头插入的文字\n"
      }
    }
  ]
}
```

此 JSON 为上述 `batchUpdate` 接口的请求体示例。`index` 是 **UTF-16 代码单元索引**，不是 UTF-8 字节偏移，也不是“第几个 Unicode 字符”。实际可插入位置受到段落、表格、分节等结构约束。复杂文档应以 `documents.get` 返回的 `startIndex`、`endIndex` 为依据，不要以纯文本长度直接推断索引。多个插入操作在同一批次中可能改变后续位置；通常从大索引往小索引处理更稳妥。

参考：[Insert, delete and move text](https://developers.google.com/workspace/docs/api/how-tos/move-text)、[Request 类型与 Tab 行为](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request)。

## 6. 并发写入保护：revisionId

多个用户或工具同时修改同一份文档时，建议：

1. `GET documents.get` 读取当前内容和 `revisionId`；
2. 依据这个版本生成修改请求；
3. 在 `batchUpdate` 的 `writeControl.requiredRevisionId` 里提交该值。

示例：

```json
{
  "requests": [
    {
      "insertText": {
        "endOfSegmentLocation": {
          "tabId": "TAB_ID"
        },
        "text": "\n本次更新内容"
      }
    }
  ],
  "writeControl": {
    "requiredRevisionId": "OPAQUE_REVISION_ID"
  }
}
```

如果文档在读取后被别人修改，Google 将拒绝此次更新，文档不会被该请求覆盖，通常返回 **HTTP 400**（不是 409）。客户端需要重新读取新版本，重新计算编辑内容，再决定是否提交。

另有 `targetRevisionId`：Google 可尝试将你的操作与其他协作者的更改合并，但它不等同于强一致冲突拒绝。对自动化写入、尤其是 AI 生成的编辑，优先考虑 `requiredRevisionId`。

参考：[WriteControl](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)、[Best practices](https://developers.google.com/workspace/docs/api/how-tos/best-practices)。

## 7. 错误处理和限制

| 场景 | 常见表现 | 应对方式 |
| --- | --- | --- |
| 未带令牌、令牌失效 | `401` | 尝试刷新 Access Token，失败则重新授权 |
| 账号无文档权限或 Scope 不足 | `403`，或出于资源可见性原因无法找到文档 | 核对用户身份、文档共享权限、OAuth scope |
| 文档 ID 错误/资源不可访问 | `404` | 核对 ID，不要仅凭 404 判断文档一定不存在 |
| 不合法的更新请求 | `400` | 检查 Request 字段、Tab ID、索引范围、结构约束 |
| 修订版本过期 | `400`（带 revision 相关错误信息） | 重新 GET，重新生成写入操作 |
| 限流 | `429` | 指数退避 + 抖动；限制高频重试 |
| 暂时性服务错误 | `5xx` | 有界重试；写入超时要先确认是否已提交，避免重复追加 |

截至本次查阅，Google Docs API 公布的主要默认限额为：**每项目每分钟 3,000 次读取、600 次写入；每用户每项目每分钟 300 次读取、60 次写入**。配额可能随项目和 Google 政策变化，应以控制台显示为准。Google 公告也提示 2026 年后续可能调整超额计费政策，不宜假定未来永远完全免费。

Google Docs API 的写入不是幂等的。例如 `insertText` 追加成功后，如果客户端因网络中断误以为失败并直接重试，会导致重复内容。建议在重试前重新读取文档确认效果，或者自行建立操作幂等控制。

参考：[Docs API usage limits](https://developers.google.com/workspace/docs/api/limits)。

## 8. 接入验收清单

- [ ] Google Cloud 项目中已启用 Google Docs API。
- [ ] OAuth 授权成功，能得到 Access Token。
- [ ] Token 过期后可以刷新，失效时可以重新授权。
- [ ] 能从实际文档 URL 解析出 `documentId`。
- [ ] 能读取已有 Google Docs，并正确识别多个/嵌套 Tab。
- [ ] 能创建空白文档并通过 `batchUpdate` 写入正文。
- [ ] 能向指定 Tab 追加文本，而不是错误地写入第一个 Tab。
- [ ] 能按指定 Tab 查找替换，并检查实际替换次数。
- [ ] 基于过期 `revisionId` 的修改会被拒绝，不造成意外覆盖。
- [ ] 对 401、403、404、400、429 和网络超时有明确处理。
- [ ] 不在日志、报错、代码仓库中泄露 Access Token / Refresh Token。

## 9. 官方资料汇总

- [Google Docs API 概览](https://developers.google.com/workspace/docs/api/reference/rest)
- [Google Docs API 权限范围](https://developers.google.com/workspace/docs/api/auth)
- [Google OAuth 2.0 桌面应用流程](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google OAuth 2.0 总体说明](https://developers.google.com/identity/protocols/oauth2)
- [documents.create](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/create)
- [documents.get](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get)
- [documents.batchUpdate](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)
- [Docs 更新 Request 类型](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request)
- [Docs 多 Tab 说明](https://developers.google.com/workspace/docs/api/how-tos/tabs)
- [Docs API 限额](https://developers.google.com/workspace/docs/api/limits)
