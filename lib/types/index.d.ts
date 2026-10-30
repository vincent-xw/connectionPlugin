/**
 * Public types for the Docs Connector adapter contract.
 *
 * A third-party platform packages one module that implements {@link DocumentAdapter}
 * and registers it with `ctx.docs.registerAdapter(adapter, ctx)`. Nothing here
 * imports Harness runtime code, so an adapter package only needs this type
 * surface (and, at runtime, no dependency at all).
 */

/** Opaque document identity resolved from a URL or native id. */
export interface DocRef {
  /** Adapter id that owns this reference. */
  platform: string
  /** Platform-native document id. */
  documentId: string
  /** Canonical browser URL when the platform has one. */
  url?: string
}

/** One portable document block. Adapters may omit blocks and set `text` instead. */
export type DocBlock =
  | { type: 'paragraph'; text: string; startIndex?: number; endIndex?: number }
  | { type: 'heading'; level: number; text: string; startIndex?: number; endIndex?: number }
  | { type: 'list'; text: string; level?: number; ordered?: boolean; startIndex?: number; endIndex?: number }
  | { type: 'table'; rows: string[][]; startIndex?: number; endIndex?: number }
  | { type: 'image'; alt?: string; startIndex?: number; endIndex?: number }
  | { type: 'break'; kind?: 'page' | 'section'; startIndex?: number; endIndex?: number }
  | { type: 'raw'; text: string; startIndex?: number; endIndex?: number }

/** One tab (Google Docs) or the platform's equivalent body. */
export interface DocumentTab {
  /** Native id used by write requests. Use `body` for an implicit single body. */
  id: string
  title: string
  index?: number
  depth?: number
  blocks?: DocBlock[]
  /** Pre-rendered text; the registry renders `blocks` when this is absent. */
  text?: string
  startIndex?: number
  endIndex?: number
}

/** Portable read result returned by {@link DocumentAdapter.read}. */
export interface DocumentSnapshot {
  platform?: string
  documentId: string
  title?: string
  url?: string
  /** Opaque revision used as the optimistic-write guard. */
  revision?: string
  tabs: DocumentTab[]
  /** Native payload; attach only when the caller asked for raw data. */
  raw?: unknown
}

/** One entry in a platform document listing. */
export interface DocumentSummary {
  /** Platform-native document id, usable as a `docs_read` reference. */
  documentId: string
  title: string
  url?: string
  mimeType?: string
  /** ISO 8601 timestamp reported by the platform. */
  modifiedTime?: string
}

/** Request passed to {@link DocumentAdapter.list}. */
export interface ListRequest {
  account?: string
  /** Page size, already bounded by the service. */
  limit?: number
  pageToken?: string
  /** Free-text title filter, when the platform supports one. */
  query?: string
  /** Platform-specific kind ("document", "spreadsheet", ...); default is the platform's primary kind. */
  type?: string
}

/** Result of {@link DocumentAdapter.list}. */
export interface ListResult {
  documents: DocumentSummary[]
  nextPageToken?: string
}

export interface ReadOptions {
  tab?: string
  account?: string
  format?: 'markdown' | 'text'
  includeBlocks?: boolean
  raw?: boolean
}

export interface AppendRequest {
  tab?: string
  account?: string
  text: string
  expectedRevision?: string
  leadingNewline?: boolean
}

export interface InsertRequest {
  tab?: string
  account?: string
  index: number
  text: string
  expectedRevision?: string
}

export interface ReplaceRequest {
  tab?: string
  account?: string
  find: string
  replace: string
  matchCase?: boolean
  expectedRevision?: string
}

/** Cell values as rows; a single row may be passed for convenience. */
export type CellValues = Array<Array<string | number | boolean>> | Array<string | number | boolean>

export interface CellUpdateRequest {
  account?: string
  /** A1 range including the sheet title, e.g. `Sheet1!A1:C3`. */
  range: string
  values: CellValues
}

export interface CellAppendRequest {
  account?: string
  /** Sheet title or A1 range; the first sheet when omitted. */
  range?: string
  values: CellValues
}

/** Raw Google Sheets batchUpdate requests. */
export interface FormatRequest {
  account?: string
  requests: unknown[]
}

/** Result of a formatting call: the API replies, one per request. */
export interface FormatResult {
  url?: string
  replies?: unknown[]
}

/** Result of a spreadsheet write, before identity is merged. */
export interface CellWriteResult {
  range?: string
  updatedRows?: number
  updatedColumns?: number
  updatedCells?: number
}

/** Result of a read/create/append/insert/replace, before identity is merged. */
export interface WriteResult {
  documentId?: string
  url?: string
  revision?: string
  tab?: string
  index?: number
  occurrencesChanged?: number
  insertedChars?: number
}

export interface AuthStatus {
  connected: boolean
  /**
   * True while an authorization flow started by `start()` is still open. When
   * set, a still-valid older grant must not be reported as the result of that
   * flow; `docs_connect` keeps waiting until the flow settles.
   */
  flowPending?: boolean
  account?: string
  /** Epoch milliseconds; the service converts it to ISO for tool output. */
  expiresAt?: number
  scopes?: string
  detail?: string
}

export interface AuthStart {
  url: string
  expiresAt?: number
  account?: string
}

/** Optional authorization capability. Omit `auth` for keyless/local platforms. */
export interface AdapterAuth {
  /** Account label used when the caller does not name one. */
  defaultAccount?: string
  status(request: { account?: string; signal?: AbortSignal }): Promise<AuthStatus>
  start(request: { account?: string; clientId?: string; signal?: AbortSignal }): Promise<AuthStart>
  disconnect(request: { account?: string; signal?: AbortSignal }): Promise<void>
}

/** Declared capabilities; an omitted flag is inferred from the method. */
export interface AdapterCapabilities {
  read?: boolean
  /** Enables `docs_list`: the platform can enumerate the account's documents. */
  list?: boolean
  create?: boolean
  append?: boolean
  insert?: boolean
  replace?: boolean
  /** Enables `docs_sheet_update`: overwrite a cell range in a spreadsheet. */
  updateValues?: boolean
  /** Enables `docs_sheet_append`: append rows to a spreadsheet. */
  appendValues?: boolean
  /** Enables `docs_sheet_format`: raw Sheets batchUpdate (formatting, merges, dimensions). */
  formatSheet?: boolean
  /** Enables `docs_invoke` through {@link DocumentAdapter.invoke}. */
  custom?: boolean
  auth?: boolean
  tabs?: boolean
  revisions?: boolean
}

/**
 * The adapter contract.
 *
 * Only `id`, `parseRef`, and one or more capability methods are required.
 * Everything else is optional so a platform can start with read-only support
 * and grow.
 */
export interface DocumentAdapter {
  /** Lowercase hyphenated id, unique among mounted adapters. */
  id: string
  title: string
  description?: string
  /** Example reference shown by `docs_platforms`. */
  refExample?: string
  /** Extra metadata passed through to consumers untouched. */
  metadata?: Record<string, unknown>
  capabilities?: AdapterCapabilities
  auth?: AdapterAuth

  /** Parse a URL, native id, or scheme body into a reference; null/throw when unrecognized. */
  parseRef(input: string): DocRef | null
  /** Canonical browser URL or string form for a reference. */
  formatRef?(ref: DocRef): string

  read?(ref: DocRef, options: ReadOptions, signal?: AbortSignal): Promise<DocumentSnapshot>
  list?(request: ListRequest, signal?: AbortSignal): Promise<ListResult>
  create?(
    request: { title: string; text?: string; tabTitle?: string; account?: string },
    signal?: AbortSignal,
  ): Promise<WriteResult & { documentId: string }>
  append?(ref: DocRef, request: AppendRequest, signal?: AbortSignal): Promise<WriteResult>
  insert?(ref: DocRef, request: InsertRequest, signal?: AbortSignal): Promise<WriteResult>
  replace?(ref: DocRef, request: ReplaceRequest, signal?: AbortSignal): Promise<WriteResult>
  updateValues?(ref: DocRef, request: CellUpdateRequest, signal?: AbortSignal): Promise<CellWriteResult>
  appendValues?(ref: DocRef, request: CellAppendRequest, signal?: AbortSignal): Promise<CellWriteResult>
  formatSheet?(ref: DocRef, request: FormatRequest, signal?: AbortSignal): Promise<FormatResult>
  invoke?(
    ref: DocRef | null,
    request: { action: string; payload?: unknown; account?: string },
    signal?: AbortSignal,
  ): Promise<unknown>

  /** Release pending authorization listeners, sockets, or timers. */
  close?(): void
}

/** Machine-routable error codes used by the built-in tools. */
export declare const DOCS_ERROR: {
  readonly UNKNOWN_PLATFORM: 'UNKNOWN_PLATFORM'
  readonly AMBIGUOUS_PLATFORM: 'AMBIGUOUS_PLATFORM'
  readonly PLATFORM_UNAVAILABLE: 'PLATFORM_UNAVAILABLE'
  readonly UNSUPPORTED: 'UNSUPPORTED'
  readonly INVALID_INPUT: 'INVALID_INPUT'
  readonly INVALID_REFERENCE: 'INVALID_REFERENCE'
  readonly NOT_FOUND: 'NOT_FOUND'
  readonly FORBIDDEN: 'FORBIDDEN'
  readonly AUTH_REQUIRED: 'AUTH_REQUIRED'
  readonly AUTH_FAILED: 'AUTH_FAILED'
  readonly NOT_CONFIGURED: 'NOT_CONFIGURED'
  readonly REVISION_CONFLICT: 'REVISION_CONFLICT'
  readonly RATE_LIMITED: 'RATE_LIMITED'
  readonly UPSTREAM: 'UPSTREAM'
  readonly CANCELLED: 'CANCELLED'
}

export declare class DocsError extends Error {
  constructor(
    message: string,
    options?: {
      code?: string
      platform?: string
      hint?: string
      retryable?: boolean
      details?: unknown
      cause?: unknown
    },
  )
  readonly code: string
  readonly platform?: string
  readonly hint?: string
  readonly retryable: boolean
  readonly details?: unknown
  toModelMessage(): string
  toJSON(): Record<string, unknown>
}

export declare function asDocsError(error: unknown, fallback?: { code?: string; platform?: string; hint?: string }): DocsError

/** Registry surface exposed as `ctx.docs` to adapters and specialized tools. */
export interface DocsService {
  readonly config: {
    defaultPlatform: string
    maxReadChars: number
    allowCustomActions: boolean
  }
  registerAdapter(adapter: DocumentAdapter, ownerCtx?: unknown): () => void
  adapters(): Array<{
    id: string
    title: string
    capabilities: Record<string, boolean>
    default: boolean
    defaultAccount?: string
    description?: string
    refExample?: string
    metadata?: Record<string, unknown>
  }>
  choose(platform?: string): DocumentAdapter
  catalog(platform?: string, signal?: AbortSignal): Promise<unknown[]>
  authStatus(adapter: DocumentAdapter, account?: string, signal?: AbortSignal): Promise<AuthStatus & { supported: boolean }>
  read(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  list(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  create(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  append(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  insert(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  replace(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  updateValues(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  appendValues(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  formatSheet(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  connect(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  disconnect(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  invoke(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

/** Render normalized blocks into the model-facing text dialect. */
export declare function renderDocument(
  snapshot: DocumentSnapshot,
  options?: { format?: 'markdown' | 'text'; includeTabHeaders?: boolean; maxChars?: number },
): { text: string; truncated: boolean; charCount: number }

/** Render one tab's blocks. */
export declare function renderTabText(tab: DocumentTab, format?: 'markdown' | 'text'): string

/** Normalize an adapter snapshot; throws `DocsError` on contract violations. */
export declare function normalizeSnapshot(snapshot: DocumentSnapshot, options?: { platform?: string }): DocumentSnapshot

/** Resolve a tab by id, exact title, or order. */
export declare function resolveTab(snapshot: DocumentSnapshot, selector?: string | number): DocumentTab

/** Project one tab to small metadata (no body). */
export declare function tabSummary(tab: DocumentTab, format?: 'markdown' | 'text'): Record<string, unknown>
