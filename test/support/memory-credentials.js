/**
 * In-memory credential store implementing the `ctx.credentials` surface the
 * adapter uses (references + grant records).
 */
export class MemoryCredentials {
  constructor() {
    this.records = new Map()
    this.references = new Map()
  }

  async readRecord(key) {
    return this.records.get(key)
  }

  async describeRecord(key) {
    const record = this.records.get(key)
    return record === undefined ? { configured: false, writable: true } : { configured: true, kind: record.kind, writable: true }
  }

  async listRecords() {
    return [...this.records].map(([key, record]) => ({ key, kind: record.kind }))
  }

  async modifyRecord(key, mutate) {
    const next = await mutate(this.records.get(key))
    if (next === undefined) return this.records.get(key)
    this.records.set(key, next)
    return next
  }

  async deleteRecord(key) {
    this.records.delete(key)
  }

  async resolve(reference) {
    const values = this.references.get(reference)
    return values === undefined ? undefined : { value: values, source: 'test' }
  }

  async set(reference, value) {
    this.references.set(reference, value)
  }

  async unset(reference) {
    this.references.delete(reference)
  }

  async describe(reference) {
    return { configured: this.references.has(reference), writable: true }
  }
}

/** A logger that keeps messages for assertions but stays silent. */
export function testLogger() {
  const messages = []
  const push = (level) => (...args) => messages.push({ level, args })
  const logger = { messages, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') }
  return logger
}

/** A minimal cordis-like context for adapter/service tests. */
export function fakeContext({ credentials } = {}) {
  const effects = []
  return {
    effects,
    get(name, strict = true) {
      if (name === 'credentials') return credentials
      return undefined
    },
    logger() {
      return testLogger()
    },
    effect(generator, label) {
      const disposers = []
      const iterator = generator()
      let next = iterator.next()
      while (next.done !== true) {
        if (typeof next.value === 'function') disposers.push(next.value)
        next = iterator.next()
      }
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        effects.push(label)
        for (const fn of disposers.reverse()) fn()
      }
      return dispose
    },
    provide(name, value) {
      this[name] = value
      return () => {
        delete this[name]
      }
    },
  }
}
