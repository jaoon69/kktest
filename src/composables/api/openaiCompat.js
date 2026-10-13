import {
  assertValidHeaders,
  mergeRequestHeaders,
  normalizeAbsoluteHttpUrl,
  prepareApiKey,
  stripInvisibleFormatChars
} from '../../utils/httpHeaders'

const DEFAULT_ERROR_TEXT_LIMIT = 200
const OPENAI_COMPAT_PROXY_BASES = Object.freeze([
  'https://api.mortis.edu.kg/v1'
])

function normalizeOpenAICompatProxyUrl(value) {
  const raw = stripInvisibleFormatChars(value).trim()
  if (!raw) return ''

  try {
    const url = new URL(raw)
    const protocol = String(url.protocol || '').toLowerCase()
    if (protocol !== 'http:' && protocol !== 'https:') return ''

    const hostname = String(url.hostname || '').trim().toLowerCase()
    if (!hostname) return ''

    const port = url.port ? `:${url.port}` : ''
    const pathname = String(url.pathname || '/').replace(/\/+$/, '') || '/'
    return `${protocol}//${hostname}${port}${pathname}`
  } catch {
    return ''
  }
}

function isOpenAICompatProxyTarget(targetUrl) {
  const normalizedTarget = normalizeOpenAICompatProxyUrl(targetUrl)
  if (!normalizedTarget) return false

  return OPENAI_COMPAT_PROXY_BASES.some(base =>
    normalizedTarget === base || normalizedTarget.startsWith(base + '/')
  )
}

function getBrowserLocation(locationLike = null) {
  if (locationLike && typeof locationLike === 'object') return locationLike
  if (typeof window !== 'undefined' && window?.location) return window.location
  return null
}

export function isLocalBrowserHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase()
  if (!host) return false
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true
  if (host === '0.0.0.0' || host.endsWith('.local')) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

export function resolveOpenAICompatUrl(baseUrl, path = '/chat/completions') {
  const suffix = String(path || '').trim() || '/chat/completions'
  const normalizedBase = stripInvisibleFormatChars(baseUrl).trim().replace(/\/+$/, '')
  if (!normalizedBase) return suffix
  if (normalizedBase.endsWith(suffix)) return normalizedBase
  return normalizedBase + suffix
}

export function buildOpenAICompatHeaders(apiKey, options = {}) {
  const { contentType = true, extraHeaders = {} } = options
  let headers = {}
  if (contentType) {
    headers = mergeRequestHeaders(headers, { 'Content-Type': 'application/json' })
  }

  const token = prepareApiKey(apiKey)
  if (token) {
    headers = mergeRequestHeaders(headers, { Authorization: `Bearer ${token}` })
  }
  headers = mergeRequestHeaders(headers, extraHeaders)
  return assertValidHeaders(headers)
}

export function shouldUseOpenAICompatProxy(targetUrl, locationLike = null) {
  if (!isOpenAICompatProxyTarget(targetUrl)) return false

  const currentLocation = getBrowserLocation(locationLike)
  if (!currentLocation) return false
  if (isLocalBrowserHostname(currentLocation.hostname)) return false

  try {
    const resolvedTarget = new URL(String(targetUrl || '').trim(), currentLocation.origin)
    const protocol = String(resolvedTarget.protocol || '').toLowerCase()
    if (protocol !== 'http:' && protocol !== 'https:') return false
    return resolvedTarget.origin !== currentLocation.origin
  } catch {
    return false
  }
}

export function resolveOpenAICompatRequest(baseUrl, options = {}) {
  const {
    path = '/chat/completions',
    apiKey,
    contentType = true,
    extraHeaders = {},
    targetUrl: endpointUrl,
    locationLike = null
  } = options

  const targetUrl = endpointUrl || resolveOpenAICompatUrl(baseUrl, path)
  const proxied = shouldUseOpenAICompatProxy(targetUrl, locationLike)
  const resolvedTargetUrl = proxied
    ? normalizeAbsoluteHttpUrl(targetUrl, 'API 地址')
    : targetUrl
  const headers = buildOpenAICompatHeaders(apiKey, {
    contentType,
    extraHeaders: proxied
      ? {
          ...extraHeaders,
          'x-target-url': resolvedTargetUrl
        }
      : extraHeaders
  })

  return {
    url: proxied ? '/api/proxy' : targetUrl,
    targetUrl: resolvedTargetUrl,
    proxied,
    headers
  }
}

export async function fetchOpenAICompat(baseUrl, options = {}) {
  const {
    method = 'POST',
    body,
    contentType = body !== undefined,
    extraHeaders = {},
    locationLike = null,
    path = '/chat/completions',
    targetUrl,
    apiKey,
    ...fetchOptions
  } = options

  const request = resolveOpenAICompatRequest(baseUrl, {
    path,
    targetUrl,
    apiKey,
    contentType,
    extraHeaders,
    locationLike
  })

  const init = {
    method,
    headers: request.headers,
    ...fetchOptions
  }

  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
  }

  const response = await fetch(request.url, init)
  return { request, response }
}

export async function readOpenAICompatError(response, options = {}) {
  const { textLimit = DEFAULT_ERROR_TEXT_LIMIT } = options
  const fallback = `HTTP ${response?.status ?? ''}`.trim()
  if (!response) return fallback

  try {
    const payload = await response.clone().json()
    const message = payload?.error?.message || payload?.message || payload?.detail
    if (typeof message === 'string' && message.trim()) {
      return message.trim()
    }
  } catch {
    // ignore JSON parse errors and fall through to raw text.
  }

  try {
    const text = await response.clone().text()
    const compact = String(text || '').trim()
    if (compact) {
      return compact.slice(0, Math.max(1, textLimit))
    }
  } catch {
    // ignore raw text read errors.
  }

  return fallback
}
