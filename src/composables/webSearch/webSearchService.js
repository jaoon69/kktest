/**
 * 联网搜索服务：引擎选择 + 自动回退 + 缓存 + 同请求去重。
 */
import { isLocalBrowserHostname } from '../api/openaiCompat'
import {
  WEB_SEARCH_PROVIDER_LABELS,
  resolveWebSearchProviderOrder
} from '../../utils/webSearchConfig'
import { WEB_SEARCH_PROVIDERS, extractProviderError } from './providers'
import { createWebSearchCache } from './webSearchCache'

const REQUEST_TIMEOUT_MS = 45000
// 抓取结果最多缓存这么多字符；返回给模型时再按 scrapeMaxChars 分段
export const SCRAPE_STORE_MAX_CHARS = 40000
const FAILED_SCRAPE_TTL_MS = 10 * 60 * 1000
const TRACKING_PARAM_PATTERN = /^(utm_\w+|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|_hsenc|_hsmi|spm|ref_src|igshid)$/i
const VALID_TOPICS = new Set(['general', 'news'])
const VALID_TIME_RANGES = new Set(['day', 'week', 'month', 'year'])

/**
 * 搜索词归一化：全角转半角、合并空白、小写、去掉结尾问号句号。
 * @param {unknown} query
 */
export function normalizeSearchQuery(query) {
  return String(query || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[?？!！。.,，、~～\s]+$/u, '')
    .toLowerCase()
}

/**
 * URL 归一化：补协议、去 hash、去追踪参数、参数排序、去结尾斜杠。
 * @param {unknown} rawUrl
 * @returns {string} 无法识别时返回 ''
 */
export function normalizeScrapeUrl(rawUrl) {
  let raw = String(rawUrl || '').trim()
  if (!raw) return ''
  if (!/^[a-z][a-z\d+.-]*:/i.test(raw)) raw = `https://${raw.replace(/^\/+/, '')}`
  let url
  try {
    url = new URL(raw)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  // 抓取由云端引擎执行，访问不到本机 / 内网地址
  if (!url.hostname.includes('.') || isLocalBrowserHostname(url.hostname)) return ''

  url.hash = ''
  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAM_PATTERN.test(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  url.search = ''
  params.forEach(([key, value]) => url.searchParams.append(key, value))
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString()
}

function getBrowserLocation(locationLike) {
  if (locationLike) return locationLike
  if (typeof window !== 'undefined' && window?.location) return window.location
  return null
}

function resolveTargetUrl(baseUrl, path) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
  // 用户可能把 /v2 之类的版本前缀写进了自定义地址
  const firstSegment = path.match(/^\/[^/]+(?=\/)/)?.[0]
  if (firstSegment && base.endsWith(firstSegment)) return base + path.slice(firstSegment.length)
  return base + path
}

function isSameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/**
 * @param {{
 *   cache?: ReturnType<typeof createWebSearchCache>,
 *   fetchImpl?: typeof fetch,
 *   now?: () => number,
 *   locationLike?: { hostname: string } | null
 * }} [options]
 */
export function createWebSearchService({
  cache = createWebSearchCache(),
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  locationLike = null
} = {}) {
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map()
  /** @type {Map<string, { error: string, expiresAt: number }>} */
  const failedScrapes = new Map()

  async function postJson(url, headers, body, proxied) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS) : null
    try {
      return await fetchImpl(proxied ? '/api/proxy' : url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(proxied ? { 'x-target-url': url } : {})
        },
        body: JSON.stringify(body),
        signal: controller?.signal
      })
    } catch (err) {
      if (err?.name === 'AbortError') throw new Error(`请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`)
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function requestProvider(providerId, config, request) {
    const provider = WEB_SEARCH_PROVIDERS[providerId]
    const apiKey = String(config.apiKeys?.[providerId] || '').trim()
    const customBase = String(config.baseUrls?.[providerId] || '').trim()
    const targetUrl = resolveTargetUrl(customBase || provider.defaultBaseUrl, request.path)
    const usesDefaultHost = !customBase || isSameOrigin(customBase, provider.defaultBaseUrl)

    const location = getBrowserLocation(locationLike)
    const canProxy = usesDefaultHost && !!location && !isLocalBrowserHostname(location.hostname)
    const proxyFirst = canProxy && provider.corsRestricted
    const headers = provider.authHeaders(apiKey)

    let res
    try {
      res = await postJson(targetUrl, headers, request.body, proxyFirst)
    } catch (err) {
      // 直连被 CORS / 网络拦截时，改走同源代理再试一次
      if (proxyFirst || !canProxy || !(err instanceof TypeError)) throw err
      res = await postJson(targetUrl, headers, request.body, true)
    }

    const data = await res.json().catch(() => null)
    if (!res.ok || data?.success === false) {
      throw new Error(extractProviderError(data, res.status))
    }
    return data
  }

  /** 按引擎顺序依次尝试，全部失败时汇总报错。 */
  async function runWithFallback(order, task) {
    if (order.length === 0) throw new Error('没有可用的搜索引擎，请先在设置中填写 API Key')
    const errors = []
    for (const providerId of order) {
      try {
        return { providerId, data: await task(providerId) }
      } catch (err) {
        errors.push(`${WEB_SEARCH_PROVIDER_LABELS[providerId]}: ${err?.message || err}`)
      }
    }
    throw new Error(errors.join('；'))
  }

  function dedupe(key, factory) {
    const existing = inflight.get(key)
    if (existing) return existing
    const promise = factory().finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }

  /**
   * @param {ReturnType<import('../../utils/webSearchConfig').normalizeWebSearchConfig>} config
   * @param {{ query: string, maxResults?: number, topic?: string, timeRange?: string, forceRefresh?: boolean }} params
   */
  async function search(config, params) {
    const query = String(params?.query || '').trim()
    const normalizedQuery = normalizeSearchQuery(query)
    if (!normalizedQuery) throw new Error('搜索关键词不能为空')

    const maxResults = Math.max(1, Math.min(10, Math.round(Number(params?.maxResults) || config.maxResults)))
    const topic = VALID_TOPICS.has(params?.topic) ? params.topic : 'general'
    const timeRange = VALID_TIME_RANGES.has(params?.timeRange) ? params.timeRange : ''
    const order = resolveWebSearchProviderOrder(config, 'search')
    const ttlMs = config.cacheEnabled ? config.searchCacheHours * 3600000 : 0
    // maxResults 不进 key：缓存里条数够用就直接切片返回
    const cacheKeyFor = (providerId) => `search|${providerId}|${topic}|${timeRange}|${normalizedQuery}`

    if (ttlMs > 0 && !params?.forceRefresh && order[0]) {
      const hit = await cache.get(cacheKeyFor(order[0]))
      const entry = hit?.value
      if (entry && (entry.limit >= maxResults || entry.results.length < entry.limit)) {
        return {
          ...entry,
          results: entry.results.slice(0, maxResults),
          query,
          cached: true,
          cachedAt: hit.storedAt
        }
      }
    }

    return dedupe(`search|${order.join(',')}|${topic}|${timeRange}|${maxResults}|${normalizedQuery}`, async () => {
      const { providerId, data } = await runWithFallback(order, async (id) => {
        const provider = WEB_SEARCH_PROVIDERS[id]
        const raw = await requestProvider(id, config, provider.buildSearch({ query, maxResults, topic, timeRange, now: now() }))
        return provider.parseSearch(raw)
      })
      const entry = { provider: providerId, answer: data.answer, results: data.results, limit: maxResults }
      if (ttlMs > 0 && data.results.length > 0) {
        await cache.set(cacheKeyFor(providerId), entry, ttlMs)
      }
      return { ...entry, query, cached: false, cachedAt: 0 }
    })
  }

  /**
   * @param {ReturnType<import('../../utils/webSearchConfig').normalizeWebSearchConfig>} config
   * @param {{ url: string, forceRefresh?: boolean }} params
   */
  async function scrape(config, params) {
    const url = normalizeScrapeUrl(params?.url)
    if (!url) throw new Error('无效的网址，仅支持 http/https 链接')

    const order = resolveWebSearchProviderOrder(config, 'scrape')
    const ttlMs = config.cacheEnabled ? config.scrapeCacheHours * 3600000 : 0
    // 同一网页的内容与引擎无关，缓存跨引擎共享
    const cacheKey = `scrape|${url}`

    if (ttlMs > 0 && !params?.forceRefresh) {
      const hit = await cache.get(cacheKey)
      if (hit?.value) return { ...hit.value, cached: true, cachedAt: hit.storedAt }
    }

    const failed = failedScrapes.get(url)
    if (failed && failed.expiresAt > now() && !params?.forceRefresh) {
      throw new Error(`${failed.error}（近期已失败，暂不重试）`)
    }

    return dedupe(`scrape|${url}`, async () => {
      try {
        const { providerId, data } = await runWithFallback(order, async (id) => {
          const provider = WEB_SEARCH_PROVIDERS[id]
          const raw = await requestProvider(id, config, provider.buildScrape({
            url,
            maxChars: SCRAPE_STORE_MAX_CHARS,
            providerMaxAgeMs: ttlMs
          }))
          return provider.parseScrape(raw, { url })
        })
        const entry = {
          provider: providerId,
          url: data.url || url,
          title: data.title,
          content: data.content.slice(0, SCRAPE_STORE_MAX_CHARS),
          totalChars: Math.min(data.content.length, SCRAPE_STORE_MAX_CHARS),
          clipped: data.content.length > SCRAPE_STORE_MAX_CHARS
        }
        failedScrapes.delete(url)
        if (ttlMs > 0) await cache.set(cacheKey, entry, ttlMs)
        return { ...entry, cached: false, cachedAt: 0 }
      } catch (err) {
        failedScrapes.set(url, { error: err?.message || String(err), expiresAt: now() + FAILED_SCRAPE_TTL_MS })
        throw err
      }
    })
  }

  return {
    search,
    scrape,
    clearCache: async () => {
      failedScrapes.clear()
      await cache.clear()
    },
    getCacheStats: () => cache.stats()
  }
}

let sharedService = null

/** 应用内共享的服务实例（共用一份缓存与去重表）。 */
export function getWebSearchService() {
  if (!sharedService) sharedService = createWebSearchService()
  return sharedService
}
