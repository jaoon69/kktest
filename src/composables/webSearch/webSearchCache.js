/**
 * 联网搜索结果缓存：内存 LRU + IndexedDB 持久化，跨刷新复用，减少 API 调用。
 *
 * 持久层每条结果单独一个 kv key（webSearchCache:<hash>），另有一个小索引
 * （webSearchCache:index）记录过期时间 / 体积 / 最近使用，用于淘汰。
 */
import { idbDelete, idbDeleteMany, idbGet, idbSet } from '../storage/idbKv'

const KEY_PREFIX = 'webSearchCache:'
const INDEX_KEY = `${KEY_PREFIX}index`
const MAX_ENTRIES = 300
const MAX_TOTAL_CHARS = 4_000_000
const MEMORY_MAX_ENTRIES = 40
const INDEX_FLUSH_DELAY_MS = 1500

/** @typedef {{ get(key: string): Promise<any>, set(key: string, value: any): Promise<void>, delete(key: string): Promise<void>, deleteMany(keys: string[]): Promise<void> }} CacheBackend */

/** @type {CacheBackend} */
const idbBackend = {
  get: idbGet,
  set: idbSet,
  delete: idbDelete,
  deleteMany: idbDeleteMany
}

/** cyrb53：稳定、足够分散的 53-bit 字符串哈希 */
function hashKey(value) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

function createEmptyIndex() {
  return { version: 1, hits: 0, entries: {} }
}

function estimateSize(value) {
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

/**
 * @param {{ backend?: CacheBackend, now?: () => number }} [options]
 */
export function createWebSearchCache({ backend = idbBackend, now = () => Date.now() } = {}) {
  /** @type {Map<string, { key: string, value: any, expiresAt: number, storedAt: number }>} */
  const memory = new Map()
  let index = null
  let indexPromise = null
  let flushTimer = null

  async function loadIndex() {
    if (index) return index
    if (!indexPromise) {
      indexPromise = backend.get(INDEX_KEY)
        .then((raw) => {
          index = raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object'
            ? { ...createEmptyIndex(), ...raw, entries: { ...raw.entries } }
            : createEmptyIndex()
          return index
        })
        .catch(() => {
          index = createEmptyIndex()
          return index
        })
    }
    return indexPromise
  }

  function rememberInMemory(storageKey, record) {
    memory.delete(storageKey)
    memory.set(storageKey, record)
    while (memory.size > MEMORY_MAX_ENTRIES) {
      memory.delete(memory.keys().next().value)
    }
  }

  async function flushIndex() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (!index) return
    try {
      await backend.set(INDEX_KEY, index)
    } catch (err) {
      console.warn('[WebSearchCache] Failed to persist index:', err?.message)
    }
  }

  function scheduleIndexFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flushIndex()
    }, INDEX_FLUSH_DELAY_MS)
  }

  async function dropKeys(storageKeys) {
    if (storageKeys.length === 0) return
    storageKeys.forEach((key) => {
      memory.delete(key)
      delete index.entries[key]
    })
    try {
      await backend.deleteMany(storageKeys)
    } catch (err) {
      console.warn('[WebSearchCache] Failed to delete entries:', err?.message)
    }
  }

  /** 先清过期项，再按最近使用时间淘汰，直到数量和体积都在上限内。 */
  async function prune() {
    const current = now()
    const entries = Object.entries(index.entries)
    const expired = entries.filter(([, meta]) => !(meta?.expiresAt > current)).map(([key]) => key)
    await dropKeys(expired)

    const alive = Object.entries(index.entries).sort((a, b) => (a[1].usedAt || 0) - (b[1].usedAt || 0))
    let totalChars = alive.reduce((sum, [, meta]) => sum + (meta.size || 0), 0)
    let count = alive.length
    const evicted = []
    for (const [key, meta] of alive) {
      if (count <= MAX_ENTRIES && totalChars <= MAX_TOTAL_CHARS) break
      evicted.push(key)
      count -= 1
      totalChars -= meta.size || 0
    }
    await dropKeys(evicted)
  }

  return {
    /**
     * @param {string} key 逻辑 key（会被哈希）
     * @returns {Promise<{ value: any, storedAt: number } | null>}
     */
    async get(key) {
      const storageKey = KEY_PREFIX + hashKey(key)
      const current = now()
      const fromMemory = memory.get(storageKey)
      if (fromMemory && fromMemory.key === key && fromMemory.expiresAt > current) {
        rememberInMemory(storageKey, fromMemory)
        await loadIndex()
        if (index.entries[storageKey]) index.entries[storageKey].usedAt = current
        index.hits += 1
        scheduleIndexFlush()
        return { value: fromMemory.value, storedAt: fromMemory.storedAt }
      }

      await loadIndex()
      const meta = index.entries[storageKey]
      if (!meta || !(meta.expiresAt > current)) return null

      let record = null
      try {
        record = await backend.get(storageKey)
      } catch {
        record = null
      }
      if (!record || record.key !== key || !(record.expiresAt > current)) {
        await dropKeys([storageKey])
        scheduleIndexFlush()
        return null
      }

      rememberInMemory(storageKey, record)
      meta.usedAt = current
      index.hits += 1
      scheduleIndexFlush()
      return { value: record.value, storedAt: record.storedAt }
    },

    /**
     * @param {string} key
     * @param {any} value
     * @param {number} ttlMs
     */
    async set(key, value, ttlMs) {
      if (!(ttlMs > 0)) return
      const storageKey = KEY_PREFIX + hashKey(key)
      const current = now()
      const record = { key, value, storedAt: current, expiresAt: current + ttlMs }
      rememberInMemory(storageKey, record)

      await loadIndex()
      index.entries[storageKey] = { expiresAt: record.expiresAt, size: estimateSize(value), usedAt: current }
      try {
        await backend.set(storageKey, record)
      } catch (err) {
        delete index.entries[storageKey]
        console.warn('[WebSearchCache] Failed to persist entry:', err?.message)
      }
      await prune()
      await flushIndex()
    },

    async clear() {
      await loadIndex()
      const keys = Object.keys(index.entries)
      memory.clear()
      index = createEmptyIndex()
      try {
        await backend.deleteMany(keys)
      } catch (err) {
        console.warn('[WebSearchCache] Failed to clear entries:', err?.message)
      }
      await flushIndex()
    },

    async stats() {
      await loadIndex()
      const current = now()
      const alive = Object.values(index.entries).filter((meta) => meta?.expiresAt > current)
      return {
        entries: alive.length,
        totalChars: alive.reduce((sum, meta) => sum + (meta.size || 0), 0),
        hits: index.hits || 0
      }
    },

    flush: flushIndex
  }
}
