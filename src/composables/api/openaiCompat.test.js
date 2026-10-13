import { describe, expect, it } from 'vitest'
import {
  buildOpenAICompatHeaders,
  fetchOpenAICompat,
  readOpenAICompatError,
  resolveOpenAICompatRequest,
  resolveOpenAICompatUrl
} from './openaiCompat'

describe('resolveOpenAICompatUrl', () => {
  it('appends chat completion suffix once', () => {
    expect(resolveOpenAICompatUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions')
    expect(resolveOpenAICompatUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/chat/completions')
    expect(resolveOpenAICompatUrl('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('supports custom suffixes', () => {
    expect(resolveOpenAICompatUrl('https://api.openai.com/v1', '/models')).toBe('https://api.openai.com/v1/models')
  })
})

describe('buildOpenAICompatHeaders', () => {
  it('builds auth and json headers', () => {
    expect(buildOpenAICompatHeaders('sk-test')).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer sk-test'
    })
  })

  it('supports auth only mode', () => {
    expect(buildOpenAICompatHeaders('sk-test', { contentType: false })).toEqual({
      Authorization: 'Bearer sk-test'
    })
  })

  it('repairs harmless copied key wrappers and rejects non-ASCII key text', () => {
    expect(buildOpenAICompatHeaders(' “Bearer sk-test\u200B” ')).toMatchObject({
      Authorization: 'Bearer sk-test'
    })
    expect(() => buildOpenAICompatHeaders('密钥：sk-test')).toThrow(
      'API Key 含有中文、全角符号、空格或换行'
    )
  })

  it('lets an explicit custom Authorization override defaults without duplicate casing', () => {
    expect(buildOpenAICompatHeaders('sk-current', {
      extraHeaders: { authorization: 'Bearer custom' }
    })).toEqual({
      'Content-Type': 'application/json',
      authorization: 'Bearer custom'
    })
  })
})

describe('resolveOpenAICompatRequest', () => {
  it('uses same-origin proxy for the mortis endpoint on deployed cross-origin requests', () => {
    const request = resolveOpenAICompatRequest('https://api.mortis.edu.kg/v1', {
      apiKey: 'sk-test',
      locationLike: {
        origin: 'https://aichat.vercel.app',
        hostname: 'aichat.vercel.app'
      }
    })

    expect(request).toEqual({
      url: '/api/proxy',
      targetUrl: 'https://api.mortis.edu.kg/v1/chat/completions',
      proxied: true,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test',
        'x-target-url': 'https://api.mortis.edu.kg/v1/chat/completions'
      }
    })
  })

  it('keeps other deployed cross-origin endpoints direct', () => {
    const request = resolveOpenAICompatRequest('https://api.openai.com/v1', {
      apiKey: 'sk-test',
      locationLike: {
        origin: 'https://aichat.vercel.app',
        hostname: 'aichat.vercel.app'
      }
    })

    expect(request).toEqual({
      url: 'https://api.openai.com/v1/chat/completions',
      targetUrl: 'https://api.openai.com/v1/chat/completions',
      proxied: false,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-test'
      }
    })
  })

  it('keeps localhost requests direct during development', () => {
    const request = resolveOpenAICompatRequest('https://api.mortis.edu.kg/v1', {
      apiKey: 'sk-test',
      locationLike: {
        origin: 'http://localhost:5173',
        hostname: 'localhost'
      }
    })

    expect(request.url).toBe('https://api.mortis.edu.kg/v1/chat/completions')
    expect(request.proxied).toBe(false)
    expect(request.headers['x-target-url']).toBeUndefined()
  })

  it('ASCII-encodes a Unicode proxy target before putting it in x-target-url', () => {
    const request = resolveOpenAICompatRequest('https://api.mortis.edu.kg/v1/中文\u200B', {
      apiKey: 'sk-test',
      locationLike: {
        origin: 'https://aichat.vercel.app',
        hostname: 'aichat.vercel.app'
      }
    })

    expect(request.proxied).toBe(true)
    expect(request.targetUrl).toBe(
      'https://api.mortis.edu.kg/v1/%E4%B8%AD%E6%96%87/chat/completions'
    )
    expect(request.headers['x-target-url']).toBe(request.targetUrl)
  })

  it('does not let a custom header replace the internal proxy target', () => {
    const request = resolveOpenAICompatRequest('https://api.mortis.edu.kg/v1', {
      apiKey: 'sk-test',
      extraHeaders: { 'X-Target-Url': 'https://evil.example' },
      locationLike: {
        origin: 'https://aichat.vercel.app',
        hostname: 'aichat.vercel.app'
      }
    })

    expect(request.headers['X-Target-Url']).toBeUndefined()
    expect(request.headers['x-target-url']).toBe('https://api.mortis.edu.kg/v1/chat/completions')
  })
})

describe('fetchOpenAICompat', () => {
  it('uses explicit endpoints with query parameters and keeps proxy routing', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (...args) => ({ args })
    try {
      const targetUrl = 'https://api.mortis.edu.kg/v1/responses?route=1'
      const { request, response } = await fetchOpenAICompat('https://api.mortis.edu.kg', {
        targetUrl, path: '/responses', apiKey: 'k', body: { model: 'gpt-test' },
        locationLike: { origin: 'https://app.example', hostname: 'app.example' }
      })
      expect(request).toMatchObject({ url: '/api/proxy', targetUrl, headers: { 'x-target-url': targetUrl } })
      expect(response.args[0]).toBe('/api/proxy')
      expect(response.args[1]).not.toHaveProperty('targetUrl')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('forwards proxied requests with target header', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (...args) => ({ args })

    try {
      const { request } = await fetchOpenAICompat('https://api.mortis.edu.kg/v1', {
        apiKey: 'sk-test',
        body: { hello: 'world' },
        locationLike: {
          origin: 'https://aichat.vercel.app',
          hostname: 'aichat.vercel.app'
        }
      })

      expect(request.url).toBe('/api/proxy')
      expect(globalThis.fetch).toBeTypeOf('function')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('readOpenAICompatError', () => {
  it('prefers structured error message', async () => {
    const response = new Response(JSON.stringify({ error: { message: 'bad request' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
    await expect(readOpenAICompatError(response)).resolves.toBe('bad request')
  })

  it('falls back to raw text when needed', async () => {
    const response = new Response('plain error', { status: 500 })
    await expect(readOpenAICompatError(response)).resolves.toBe('plain error')
  })
})
