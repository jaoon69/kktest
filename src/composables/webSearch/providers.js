/**
 * 联网搜索引擎适配器：把 Tavily / Exa / Firecrawl 的搜索和网页抓取接口
 * 统一成 { buildSearch, parseSearch, buildScrape, parseScrape }。
 *
 * 统一输出：
 *   search → { answer, results: [{ title, url, snippet, publishedDate }] }
 *   scrape → { url, title, content }
 */

const TIME_RANGE_DAYS = Object.freeze({ day: 1, week: 7, month: 31, year: 366 })
const FIRECRAWL_TBS = Object.freeze({ day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' })

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function firstText(...values) {
  for (const value of values) {
    const next = text(value)
    if (next) return next
  }
  return ''
}

function joinHighlights(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean).join(' … ') : ''
}

function normalizeResultItem(item) {
  return {
    title: firstText(item?.title),
    url: firstText(item?.url),
    snippet: firstText(item?.snippet),
    publishedDate: firstText(item?.publishedDate)
  }
}

function filterResults(list) {
  return (Array.isArray(list) ? list : [])
    .map(normalizeResultItem)
    .filter((item) => item.url)
}

/**
 * @param {string} timeRange
 * @param {number} [now]
 */
function startDateForRange(timeRange, now = Date.now()) {
  const days = TIME_RANGE_DAYS[timeRange]
  if (!days) return ''
  return new Date(now - days * 86400000).toISOString()
}

export const WEB_SEARCH_PROVIDERS = Object.freeze({
  tavily: {
    id: 'tavily',
    defaultBaseUrl: 'https://api.tavily.com',
    corsRestricted: false,
    authHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    buildSearch({ query, maxResults, topic, timeRange }) {
      const body = {
        query,
        max_results: maxResults,
        search_depth: 'basic',
        topic: topic === 'news' ? 'news' : 'general',
        include_answer: 'basic',
        include_raw_content: false,
        include_images: false
      }
      if (TIME_RANGE_DAYS[timeRange]) body.time_range = timeRange
      return { path: '/search', body }
    },
    parseSearch(data) {
      return {
        answer: text(data?.answer),
        results: filterResults((data?.results || []).map((item) => ({
          title: item?.title,
          url: item?.url,
          snippet: item?.content,
          publishedDate: item?.published_date
        })))
      }
    },
    buildScrape({ url }) {
      return {
        path: '/extract',
        body: { urls: [url], extract_depth: 'basic', format: 'markdown', include_images: false }
      }
    },
    parseScrape(data, { url }) {
      const hit = Array.isArray(data?.results) ? data.results[0] : null
      if (!text(hit?.raw_content)) {
        const failed = Array.isArray(data?.failed_results) ? data.failed_results[0] : null
        throw new Error(firstText(failed?.error, '页面内容为空'))
      }
      return { url: firstText(hit?.url, url), title: firstText(hit?.title), content: text(hit.raw_content) }
    }
  },

  exa: {
    id: 'exa',
    defaultBaseUrl: 'https://api.exa.ai',
    // Exa 只对 localhost 放行 CORS，线上部署需走 /api/proxy
    corsRestricted: true,
    authHeaders: (apiKey) => ({ 'x-api-key': apiKey }),
    buildSearch({ query, maxResults, topic, timeRange, now }) {
      const body = {
        query,
        numResults: maxResults,
        type: 'auto',
        contents: { highlights: true }
      }
      if (topic === 'news') body.category = 'news'
      const startDate = startDateForRange(timeRange, now)
      if (startDate) body.startPublishedDate = startDate
      return { path: '/search', body }
    },
    parseSearch(data) {
      return {
        answer: '',
        results: filterResults((data?.results || []).map((item) => ({
          title: item?.title,
          url: item?.url,
          snippet: firstText(joinHighlights(item?.highlights), item?.summary, text(item?.text).slice(0, 500)),
          publishedDate: item?.publishedDate
        })))
      }
    },
    buildScrape({ url, maxChars }) {
      return {
        path: '/contents',
        body: { urls: [url], text: { maxCharacters: maxChars } }
      }
    },
    parseScrape(data, { url }) {
      const hit = Array.isArray(data?.results) ? data.results[0] : null
      if (!text(hit?.text)) {
        const status = Array.isArray(data?.statuses) ? data.statuses[0] : null
        throw new Error(firstText(status?.error?.tag, '页面内容为空'))
      }
      return { url: firstText(hit?.url, url), title: firstText(hit?.title), content: text(hit.text) }
    }
  },

  firecrawl: {
    id: 'firecrawl',
    defaultBaseUrl: 'https://api.firecrawl.dev',
    corsRestricted: false,
    authHeaders: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }),
    buildSearch({ query, maxResults, topic, timeRange }) {
      const body = {
        query,
        limit: maxResults,
        sources: [topic === 'news' ? 'news' : 'web']
      }
      if (FIRECRAWL_TBS[timeRange]) body.tbs = FIRECRAWL_TBS[timeRange]
      return { path: '/v2/search', body }
    },
    parseSearch(data) {
      const payload = data?.data
      // v2: data.{web,news}；v1: data 为数组
      const list = Array.isArray(payload)
        ? payload
        : [...(payload?.web || []), ...(payload?.news || [])]
      return {
        answer: '',
        results: filterResults(list.map((item) => ({
          title: item?.title,
          url: item?.url,
          snippet: firstText(item?.description, item?.snippet),
          publishedDate: item?.date
        })))
      }
    },
    buildScrape({ url, providerMaxAgeMs }) {
      const body = { url, formats: ['markdown'], onlyMainContent: true }
      if (providerMaxAgeMs > 0) body.maxAge = providerMaxAgeMs
      return { path: '/v2/scrape', body }
    },
    parseScrape(data, { url }) {
      const payload = data?.data || {}
      const content = text(payload.markdown)
      if (!content) throw new Error(firstText(data?.error, data?.warning, '页面内容为空'))
      return {
        url: firstText(payload.metadata?.sourceURL, payload.metadata?.url, url),
        title: firstText(payload.metadata?.title),
        content
      }
    }
  }
})

/**
 * 从错误响应体里抽出可读信息。
 * @param {unknown} data
 * @param {number} status
 */
export function extractProviderError(data, status) {
  const detail = data && typeof data === 'object' ? /** @type {any} */ (data) : {}
  const message = firstText(
    detail.error?.message,
    detail.error,
    detail.detail?.error,
    detail.detail,
    detail.message
  )
  return message ? `HTTP ${status}: ${message}` : `HTTP ${status}`
}
