/**
 * A tiny, dependency-free tool definition kit.
 *
 * The Docs Connector is a *host-only, zero-dependency* bundle: it imports no
 * `@deepseek-ai/*` runtime package so a linked checkout resolves without a
 * build step or a profile `pnpm install`. The objects this module produces are
 * exactly the raw shape `ctx.tools.register()` accepts (`name`, `description`,
 * JSON-Schema `parameters`, `output { schema, render }`, `execute`), plus a
 * pre-dispatch argument check because raw registrations are not wrapped by
 * `defineTool()`'s validator.
 * @module @local/docs-connector/tool-kit
 */

/**
 * Validate a value against the JSON-Schema subset the Harness accepts.
 *
 * Lenient by design: unknown object members are ignored, so a model adding a
 * harmless extra key does not fail the call. Declared `required` members,
 * types, `enum`, `const`, `items`, and `oneOf` are enforced.
 * @param {object} schema - schema subset node.
 * @param {unknown} value - candidate value.
 * @param {string} [path] - diagnostic path.
 * @returns {string[]} violations; empty means valid.
 */
export function validateSchemaValue(schema, value, path = 'arguments') {
  const violations = []
  if (schema === null || typeof schema !== 'object') return violations
  if (Array.isArray(schema.oneOf)) {
    const attempts = schema.oneOf.map((candidate) => validateSchemaValue(candidate, value, path))
    if (attempts.some((result) => result.length === 0)) return violations
    violations.push(`${path} does not match any allowed shape`)
    return violations
  }
  if (typeof schema.type !== 'string') return violations
  const type = schema.type
  if (Object.hasOwn(schema, 'const') && !sameScalar(schema.const, value)) {
    violations.push(`${path} must equal ${JSON.stringify(schema.const)}`)
    return violations
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => sameScalar(entry, value))) {
    violations.push(`${path} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}`)
    return violations
  }
  switch (type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        violations.push(`${path} must be an object`)
        return violations
      }
      const required = Array.isArray(schema.required) ? schema.required : []
      for (const key of required) {
        if (!Object.hasOwn(value, key) || value[key] === undefined) violations.push(`${path}.${key} is required`)
      }
      const properties = schema.properties !== null && typeof schema.properties === 'object' ? schema.properties : {}
      for (const [key, member] of Object.entries(properties)) {
        if (value[key] === undefined) continue
        violations.push(...validateSchemaValue(member, value[key], `${path}.${key}`))
      }
      return violations
    }
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`${path} must be an array`)
        return violations
      }
      if (schema.items !== undefined) {
        value.forEach((entry, index) => violations.push(...validateSchemaValue(schema.items, entry, `${path}[${index}]`)))
      }
      return violations
    }
    case 'string':
      if (typeof value !== 'string') violations.push(`${path} must be a string`)
      return violations
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${path} must be a number`)
      return violations
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) violations.push(`${path} must be an integer`)
      return violations
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${path} must be a boolean`)
      return violations
    case 'null':
      if (value !== null) violations.push(`${path} must be null`)
      return violations
    default:
      return violations
  }
}

/**
 * Convert the authoring dialect used by the schemas in this package into the
 * JSON-Schema subset the Harness accepts.
 *
 * Authoring shape: each property may carry `required: true`; the converter
 * hoists those flags into the parent object's `required: [names]` array and
 * removes them. `oneOf`, `items`, `properties`, `enum`, `const`, and
 * annotations pass through unchanged.
 * @param {object} node - authoring schema node.
 * @returns {object} JSON Schema node.
 */
export function toJsonSchema(node) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  const output = {}
  const required = []
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required') {
      if (Array.isArray(value)) required.push(...value)
      continue
    }
    if (key === 'properties' && value !== null && typeof value === 'object') {
      const properties = {}
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        if (propertySchema !== null && typeof propertySchema === 'object' && propertySchema.required === true) {
          required.push(propertyName)
        }
        properties[propertyName] = toJsonSchema(propertySchema)
      }
      output.properties = properties
      continue
    }
    if (key === 'items') {
      output.items = toJsonSchema(value)
      continue
    }
    if (key === 'oneOf' && Array.isArray(value)) {
      output.oneOf = value.map((candidate) => toJsonSchema(candidate))
      continue
    }
    output[key] = value
  }
  if (required.length > 0) output.required = [...new Set(required)]
  return output
}

/** Strict scalar equality including number identity for integers. */
function sameScalar(expected, actual) {
  if (typeof expected === 'number' && typeof actual === 'number') return Object.is(expected, actual)
  return expected === actual
}

/**
 * Build a raw tool definition.
 * @param {object} options
 * @param {string} options.name - model-facing tool name.
 * @param {string} options.description - model-facing description.
 * @param {object} options.parameters - JSON-Schema object node.
 * @param {{ schema: object, render: (args: object, value: any) => Array<object> }} options.output - canonical schema and renderer.
 * @param {number} [options.timeoutMs] - cooperative timeout budget.
 * @param {(args: object) => boolean} [options.isConcurrencySafe] - parallel-safety classifier.
 * @param {(args: object, exec: { signal: AbortSignal }) => Promise<any>} options.execute - body.
 * @returns {object} registry-ready definition.
 */
export function defineTool(options) {
  if (typeof options.name !== 'string' || options.name.length === 0) throw new Error('tool definition requires a name')
  if (typeof options.description !== 'string' || options.description.trim().length === 0) {
    throw new Error(`tool "${options.name}" requires a description`)
  }
  if (options.output === undefined || typeof options.output.render !== 'function') {
    throw new Error(`tool "${options.name}" requires output.render`)
  }
  const parameters = toJsonSchema(options.parameters ?? { type: 'object', properties: {} })
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: toJsonSchema(options.output.schema),
      render: options.output.render,
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: options.isConcurrencySafe }),
    async execute(args, exec) {
      const violations = validateSchemaValue(parameters, args ?? {})
      if (violations.length > 0) {
        throw new Error(`invalid arguments for ${options.name}: ${violations.join('; ')}`)
      }
      return options.execute(args ?? {}, exec)
    },
  }
}

/**
 * Render one text block for a tool result.
 * @param {string} text - content.
 * @returns {Array<{ type: 'text', text: string }>} content blocks.
 */
export function textContent(text) {
  return [{ type: 'text', text }]
}
