import { describe, expect, it, vi } from 'vitest'
import { createWebSearchCache } from './webSearchCache'
import { createWebSearchService, normalizeScrapeUrl, normalizeSearchQuery } from './webSearchService'
import { WEB_SEARCH_PROVIDERS } from './providers'
import { formatScrapeResultText, formatSearchResultText } from './formatResults'
import {
  createDefaultWebSearchConfig,
  normalizeWebSearchConfig,
  resolveWebSearchProviderOrder
} from '../../utils/webSearchConfig'

function createMemoryBackend() {
  const map = new Map()
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => { map.set(key, value) },
    delete: async (key) => { map.delete(key) },
    deleteMany: async (keys) => { keys.forEach((key) => map.delete(key)) }
  }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  }
}

function makeConfig(patch = {}) {
  return normalizeWebSearchConfig({
    ...createDefaultWebSearchConfig(),
    enabled: true,
    apiKeys: { tavily: 'tvly-key', exa: '', firecrawl: '' },
    ...patch
  })
}

const LOCAL = { hostname: 'localhost' }
const REMOTE = { hostname: 'chat.example.com' }

function tavilySearchBody(count = 3) {
  return {
    answer: 'short answer',
    results: Array.from({ length: count }, (_, i) => ({
      title: `T${i}`,
      url: `https://site.com/${i}`,
      content: `snippet ${i}`
    }))
  }
}

function createService({ fetchImpl, now, locationLike = LOCAL } = {}) {
  const clock = now || (() => 1_000_000)
  const backend = createMemoryBackend()
  const cache = createWebSearchCache({ backend, now: clock })
  return {
    backend,
    service: createWebSearchService({ cache, fetchImpl, now: clock, locationLike })
  }
}

describe('normalizers', () => {
  it('normalizes search queries for cache keys', () => {
    expect(normalizeSearchQuery('  Vue３   最新版本？ ')).toBe('vue3 最新版本')
    expect(normalizeSearchQuery('Hello World!!')).toBe('hello world')
  })

  it('normalizes urls and strips tracking params', () => {
    expect(normalizeScrapeUrl('Example.com/a/?utm_source=x&b=2&a=1#top'))
      .toBe('https://example.com/a?a=1&b=2')
    expect(normalizeScrapeUrl('ftp://example.com')).toBe('')
    expect(normalizeScrapeUrl('http://localhost:3000/x')).toBe('')
    expect(normalizeScrapeUrl('http://192.168.1.2/x')).toBe('')
    expect(normalizeScrapeUrl('not a url')).toBe('')
  })
})

describe('webSearchConfig', () => {
  it('fills defaults and clamps values', () => {
    const config = normalizeWebSearchConfig({ provider: 'EXA', maxResults: 99, apiKeys: { exa: ' k ' } })
    expect(config.provider).toBe('exa')
    expect(config.maxResults).toBe(10)
    expect(config.apiKeys).toEqual({ tavily: '', exa: 'k', firecrawl: '' })
    expect(config.cacheEnabled).toBe(true)
  })

  it('orders providers preferred-first and only keeps ones with keys', () => {
    const config = makeConfig({ provider: 'exa', apiKeys: { tavily: 'a', exa: 'b', firecrawl: '' } })
    expect(resolveWebSearchProviderOrder(config, 'search')).toEqual(['exa', 'tavily'])
    expect(resolveWebSearchProviderOrder({ ...config, scrapeProvider: 'tavily' }, 'scrape')).toEqual(['tavily', 'exa'])
    expect(resolveWebSearchProviderOrder({ ...config, fallbackEnabled: false }, 'search')).toEqual(['exa'])
    expect(resolveWebSearchProviderOrder({ ...config, provider: 'firecrawl', fallbackEnabled: false }, 'search')).toEqual([])
  })
})

describe('providers', () => {
  it('parses firecrawl v2 search and scrape payloads', () => {
    const search = WEB_SEARCH_PROVIDERS.firecrawl.parseSearch({
      success: true,
      data: { web: [{ title: 'A', url: 'https://a.com', description: 'desc' }] }
    })
    expect(search.results).toEqual([{ title: 'A', url: 'https://a.com', snippet: 'desc', publishedDate: '' }])

    const scrape = WEB_SEARCH_PROVIDERS.firecrawl.parseScrape({
      success: true,
      data: { markdown: '# Hi', metadata: { title: 'Hi', sourceURL: 'https://a.com' } }
    }, { url: 'https://a.com' })
    expect(scrape).toEqual({ url: 'https://a.com', title: 'Hi', content: '# Hi' })
  })

  it('parses exa highlights and reports failed contents', () => {
    const search = WEB_SEARCH_PROVIDERS.exa.parseSearch({
      results: [{ title: 'E', url: 'https://e.com', highlights: ['one', 'two'] }]
    })
    expect(search.results[0].snippet).toBe('one … two')
    expect(() => WEB_SEARCH_PROVIDERS.exa.parseScrape({
      results: [],
      statuses: [{ status: 'error', error: { tag: 'CRAWL_NOT_FOUND' } }]
    }, { url: 'https://e.com' })).toThrow('CRAWL_NOT_FOUND')
  })

  it('builds tavily extract requests in markdown', () => {
    expect(WEB_SEARCH_PROVIDERS.tavily.buildScrape({ url: 'https://a.com' })).toEqual({
      path: '/extract',
      body: { urls: ['https://a.com'], extract_depth: 'basic', format: 'markdown', include_images: false }
    })
  })
})

describe('webSearchService', () => {
  it('serves repeated searches from cache, including smaller result counts', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(tavilySearchBody(5)))
    const { service } = createService({ fetchImpl })
    const config = makeConfig()

    const first = await service.search(config, { query: 'Vue 3', maxResults: 5 })
    expect(first.cached).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.tavily.com/search')

    const second = await service.search(config, { query: ' vue 3？', maxResults: 3 })
    expect(second.cached).toBe(true)
    expect(second.results).toHaveLength(3)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // 请求更多条数时缓存不够用，重新请求
    await service.search(config, { query: 'vue 3', maxResults: 8 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('re-fetches after the cache ttl expires and skips cache when disabled', async () => {
    let current = 1_000_000
    const fetchImpl = vi.fn(async () => jsonResponse(tavilySearchBody(2)))
    const { service } = createService({ fetchImpl, now: () => current })
    const config = makeConfig({ searchCacheHours: 1 })

    await service.search(config, { query: 'q' })
    current += 30 * 60 * 1000
    await service.search(config, { query: 'q' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    current += 31 * 60 * 1000
    await service.search(config, { query: 'q' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)

    await service.search({ ...config, cacheEnabled: false }, { query: 'q' })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('dedupes identical in-flight requests', async () => {
    let resolveFetch
    const fetchImpl = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve }))
    const { service } = createService({ fetchImpl })
    const config = makeConfig({ cacheEnabled: false })

    const a = service.search(config, { query: 'same' })
    const b = service.search(config, { query: 'same' })
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    resolveFetch(jsonResponse(tavilySearchBody(1)))
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.results).toEqual(rb.results)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('falls back to the next configured provider on failure', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (String(url).includes('tavily')) return jsonResponse({ detail: { error: 'quota exceeded' } }, 432)
      return jsonResponse({ success: true, data: { web: [{ title: 'F', url: 'https://f.com', description: 'd' }] } })
    })
    const { service } = createService({ fetchImpl })
    const config = makeConfig({ apiKeys: { tavily: 't', exa: '', firecrawl: 'fc' } })

    const result = await service.search(config, { query: 'x' })
    expect(result.provider).toBe('firecrawl')
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://api.tavily.com/search',
      'https://api.firecrawl.dev/v2/search'
    ])
  })

  it('reports every provider error when all fail', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'bad key' }, 401))
    const { service } = createService({ fetchImpl })
    const config = makeConfig({ apiKeys: { tavily: 't', exa: 'e', firecrawl: '' } })
    await expect(service.search(config, { query: 'x' })).rejects.toThrow('Tavily: HTTP 401: bad key；Exa: HTTP 401: bad key')
  })

  it('routes exa through the same-origin proxy on deployed hosts', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [] }))
    const { service } = createService({ fetchImpl, locationLike: REMOTE })
    const config = makeConfig({ provider: 'exa', apiKeys: { tavily: '', exa: 'exa-key', firecrawl: '' } })

    await service.search(config, { query: 'x' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/proxy')
    expect(init.headers['x-target-url']).toBe('https://api.exa.ai/search')
    expect(init.headers['x-api-key']).toBe('exa-key')
  })

  it('retries through the proxy when a direct request is blocked', async () => {
    const fetchImpl = vi.fn(async (url) => {
      if (url !== '/api/proxy') throw new TypeError('Failed to fetch')
      return jsonResponse(tavilySearchBody(1))
    })
    const { service } = createService({ fetchImpl, locationLike: REMOTE })
    const result = await service.search(makeConfig(), { query: 'x' })
    expect(result.results).toHaveLength(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('uses a custom base url directly without the proxy', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ success: true, data: { markdown: 'body' } }))
    const { service } = createService({ fetchImpl, locationLike: REMOTE })
    const config = makeConfig({
      provider: 'firecrawl',
      apiKeys: { tavily: '', exa: '', firecrawl: 'fc' },
      baseUrls: { tavily: '', exa: '', firecrawl: 'https://fc.self-hosted.dev/v2/' }
    })
    await service.scrape(config, { url: 'https://a.com/page' })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://fc.self-hosted.dev/v2/scrape')
  })

  it('shares scrape cache across providers and normalized urls', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      results: [{ url: 'https://a.com/post', raw_content: 'page body' }]
    }))
    const { service } = createService({ fetchImpl })
    const config = makeConfig({ apiKeys: { tavily: 't', exa: 'e', firecrawl: '' } })

    const first = await service.scrape(config, { url: 'https://a.com/post?utm_source=feed' })
    expect(first.content).toBe('page body')
    const second = await service.scrape({ ...config, scrapeProvider: 'exa' }, { url: 'a.com/post/#comments' })
    expect(second.cached).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('briefly remembers failed scrapes to avoid repeated paid retries', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [], failed_results: [{ url: 'https://x.com', error: 'blocked' }] }))
    const { service } = createService({ fetchImpl })
    const config = makeConfig()

    await expect(service.scrape(config, { url: 'https://x.com' })).rejects.toThrow('blocked')
    await expect(service.scrape(config, { url: 'https://x.com' })).rejects.toThrow('近期已失败')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('clears cache and tracks hits', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(tavilySearchBody(1)))
    const { service, backend } = createService({ fetchImpl })
    const config = makeConfig()

    await service.search(config, { query: 'a' })
    await service.search(config, { query: 'a' })
    expect(await service.getCacheStats()).toMatchObject({ entries: 1, hits: 1 })

    await service.clearCache()
    expect(await service.getCacheStats()).toMatchObject({ entries: 0, hits: 0 })
    expect([...backend.map.keys()].filter((key) => key !== 'webSearchCache:index')).toEqual([])
  })
})

describe('webSearchCache', () => {
  it('evicts least recently used entries over the entry cap', async () => {
    let current = 0
    const backend = createMemoryBackend()
    const cache = createWebSearchCache({ backend, now: () => ++current })
    for (let i = 0; i < 305; i++) {
      await cache.set(`k${i}`, { i }, 60_000_000)
    }
    const stats = await cache.stats()
    expect(stats.entries).toBe(300)
    expect(await cache.get('k0')).toBeNull()
    expect((await cache.get('k304')).value).toEqual({ i: 304 })
  })

  it('restores entries from the persistent backend in a new instance', async () => {
    const backend = createMemoryBackend()
    const first = createWebSearchCache({ backend, now: () => 10 })
    await first.set('key', { v: 1 }, 1000)
    const second = createWebSearchCache({ backend, now: () => 20 })
    expect((await second.get('key')).value).toEqual({ v: 1 })
  })
})

describe('formatResults', () => {
  it('formats search results compactly', () => {
    const text = formatSearchResultText({
      provider: 'tavily',
      query: 'vue',
      answer: 'Vue is a framework',
      cached: true,
      results: [{ title: 'Vue', url: 'https://vuejs.org', snippet: 'The Progressive Framework', publishedDate: '2026-01-02T00:00:00Z' }]
    })
    expect(text.split('\n')[0]).toBe('搜索「vue」· 1 条结果 · Tavily·缓存')
    expect(text).toContain('1. Vue [2026-01-02]')
    expect(text).toContain('摘要：Vue is a framework')
  })

  it('strips markdown noise from snippets', () => {
    const text = formatSearchResultText({
      provider: 'firecrawl',
      query: 'q',
      results: [{ title: 'T', url: 'https://a.com', snippet: '# Intro [​](https://a.com#intro)\nSee [docs](https://a.com/docs) ![img](https://a.com/x.png)' }]
    })
    expect(text).toContain('   Intro See docs')
    expect(text).not.toContain('](')
  })

  it('paginates long scrape content with offsets', () => {
    const result = { provider: 'exa', url: 'https://a.com', title: 'A', content: 'abcdefghij', totalChars: 10 }
    const page = formatScrapeResultText(result, { offset: 0, maxChars: 4 })
    expect(page).toContain('abcd')
    expect(page).toContain('offset=4')
    const last = formatScrapeResultText(result, { offset: 8, maxChars: 4 })
    expect(last).toContain('ij')
    expect(last).not.toContain('offset=')
  })
})
