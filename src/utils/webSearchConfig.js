/**
 * 联网搜索（Tavily / Exa / Firecrawl）配置的默认值与归一化。
 * 配置挂在 settings.toolCallingConfig.webSearch 下，随 toolCallingConfig 一起持久化。
 */

export const WEB_SEARCH_PROVIDER_IDS = Object.freeze(['tavily', 'exa', 'firecrawl'])

export const WEB_SEARCH_PROVIDER_LABELS = Object.freeze({
  tavily: 'Tavily',
  exa: 'Exa',
  firecrawl: 'Firecrawl'
})

const LIMITS = Object.freeze({
  maxResults: [1, 10, 5],
  scrapeMaxChars: [1000, 40000, 8000],
  searchCacheHours: [0, 720, 12],
  scrapeCacheHours: [0, 720, 72]
})

/** @returns {Record<string, string>} */
function createProviderMap() {
  return Object.fromEntries(WEB_SEARCH_PROVIDER_IDS.map((id) => [id, '']))
}

export function createDefaultWebSearchConfig() {
  return {
    enabled: false,
    provider: 'tavily',
    // '' = 跟随搜索引擎
    scrapeProvider: '',
    apiKeys: createProviderMap(),
    baseUrls: createProviderMap(),
    maxResults: LIMITS.maxResults[2],
    scrapeMaxChars: LIMITS.scrapeMaxChars[2],
    cacheEnabled: true,
    searchCacheHours: LIMITS.searchCacheHours[2],
    scrapeCacheHours: LIMITS.scrapeCacheHours[2],
    // 当前引擎失败时自动改用其他已填写 Key 的引擎
    fallbackEnabled: true
  }
}

/**
 * @param {unknown} value
 * @returns {'tavily'|'exa'|'firecrawl'|''}
 */
export function normalizeWebSearchProvider(value) {
  const id = String(value || '').trim().toLowerCase()
  return WEB_SEARCH_PROVIDER_IDS.includes(id) ? /** @type {any} */ (id) : ''
}

function normalizeIntInRange(value, [min, max, fallback]) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.round(num)))
}

function normalizeProviderMap(raw, fallback) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const base = fallback && typeof fallback === 'object' ? fallback : {}
  return Object.fromEntries(WEB_SEARCH_PROVIDER_IDS.map((id) => [
    id,
    String(source[id] ?? base[id] ?? '').trim()
  ]))
}

/**
 * @param {unknown} rawConfig
 * @param {object} [fallbackConfig]
 */
export function normalizeWebSearchConfig(rawConfig, fallbackConfig = createDefaultWebSearchConfig()) {
  const raw = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {}
  const fallback = fallbackConfig && typeof fallbackConfig === 'object' ? fallbackConfig : createDefaultWebSearchConfig()
  const pick = (key) => (Object.prototype.hasOwnProperty.call(raw, key) ? raw[key] : fallback[key])

  return {
    enabled: !!pick('enabled'),
    provider: normalizeWebSearchProvider(pick('provider')) || 'tavily',
    scrapeProvider: normalizeWebSearchProvider(pick('scrapeProvider')),
    apiKeys: normalizeProviderMap(raw.apiKeys, fallback.apiKeys),
    baseUrls: normalizeProviderMap(raw.baseUrls, fallback.baseUrls),
    maxResults: normalizeIntInRange(pick('maxResults'), LIMITS.maxResults),
    scrapeMaxChars: normalizeIntInRange(pick('scrapeMaxChars'), LIMITS.scrapeMaxChars),
    cacheEnabled: pick('cacheEnabled') !== false,
    searchCacheHours: normalizeIntInRange(pick('searchCacheHours'), LIMITS.searchCacheHours),
    scrapeCacheHours: normalizeIntInRange(pick('scrapeCacheHours'), LIMITS.scrapeCacheHours),
    fallbackEnabled: pick('fallbackEnabled') !== false
  }
}

/**
 * 读取 settingsStore 中的联网搜索配置（总是返回归一化结果）。
 * @param {object} settingsStore
 */
export function getWebSearchConfig(settingsStore) {
  return normalizeWebSearchConfig(settingsStore?.toolCallingConfig?.webSearch)
}

/**
 * 按“首选 → 其他已配置”的顺序列出可用引擎。
 * @param {ReturnType<typeof normalizeWebSearchConfig>} config
 * @param {'search'|'scrape'} kind
 * @returns {string[]}
 */
export function resolveWebSearchProviderOrder(config, kind = 'search') {
  const preferred = kind === 'scrape'
    ? (config.scrapeProvider || config.provider)
    : config.provider
  const hasKey = (id) => !!String(config.apiKeys?.[id] || '').trim()
  const ordered = [preferred, ...WEB_SEARCH_PROVIDER_IDS.filter((id) => id !== preferred)]
  const available = ordered.filter(hasKey)
  if (!config.fallbackEnabled) return available.slice(0, available[0] === preferred ? 1 : 0)
  return available
}

/**
 * 是否至少有一个引擎可用于该用途。
 * @param {object} settingsStore
 * @param {'search'|'scrape'} kind
 */
export function isWebSearchAvailable(settingsStore, kind = 'search') {
  const config = getWebSearchConfig(settingsStore)
  return config.enabled && resolveWebSearchProviderOrder(config, kind).length > 0
}
