/**
 * Package root of the Docs Connector bundle.
 *
 * The root row is the adapter registry service (`ctx.docs`). Platform adapters
 * and the model-facing tools are separate rows declared in `cordis.patch.yml`:
 *
 * - `@local/docs-connector`                      → registry service
 * - `@local/docs-connector/adapters/google`      → Google Docs adapter
 * - `@local/docs-connector/tools`                → model-facing docs_* tools
 *
 * A third-party adapter package only needs the `@local/docs-connector/core`
 * export (`DocsError`, `renderDocument`, JSDoc types) and a row that calls
 * `ctx.docs.registerAdapter(...)`.
 */
export { apply, name } from './lib/core/index.js'
