import { beforeEach, describe, expect, it, vi } from 'vitest'

const openAIMocks = vi.hoisted(() => ({
  buildOpenAICompatHeaders: vi.fn((apiKey) => ({ Authorization: `Bearer ${apiKey}` })),
  fetchOpenAICompat: vi.fn(),
  readOpenAICompatError: vi.fn()
}))

vi.mock('./openaiCompat', () => ({
  buildOpenAICompatHeaders: openAIMocks.buildOpenAICompatHeaders,
  fetchOpenAICompat: openAIMocks.fetchOpenAICompat,
  readOpenAICompatError: openAIMocks.readOpenAICompatError
}))

import {
  API_FORMAT_ANTHROPIC_MESSAGES,
  API_FORMAT_GEMINI_GENERATE_CONTENT,
  API_FORMAT_OPENAI_COMPATIBLE,
  API_FORMAT_OPENAI_RESPONSES
} from './providerFormats'
import {
  buildProviderChatPayload,
  buildProviderNonStreamingPayload,
  consumeProviderChatStream,
  fetchProviderChat,
  fetchProviderModels,
  readProviderChatError
} from './providerRequest'
import { buildContextMessages } from './contextWindow'
import {
  buildDirectChatApiMessages,
  buildGroupSingleApiMessages,
  buildGroupMultiApiMessages
} from './messageHistoryBuilder'

function createOkResponse(text = '{}') {
  return new Response(text, { status: 200 })
}

describe('providerRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    globalThis.fetch = vi.fn().mockResolvedValue(createOkResponse())
    openAIMocks.fetchOpenAICompat.mockResolvedValue({
      request: { targetUrl: 'https://openai.test/v1/chat/completions' },
      response: createOkResponse()
    })
    openAIMocks.readOpenAICompatError.mockResolvedValue('openai error')
  })

  it('keeps OpenAI-compatible payload and fetch behavior on old configs', async () => {
    const cfg = {
      url: 'https://openai.test/v1',
      key: 'openai-key',
      model: 'gpt-test',
      apiFormat: API_FORMAT_OPENAI_COMPATIBLE
    }
    const messages = [{ role: 'user', content: 'Hi' }]

    const payload = buildProviderChatPayload(cfg, messages)
    expect(payload).toMatchObject({
      model: 'gpt-test',
      messages,
      stream: true,
      stream_options: { include_usage: true }
    })

    await fetchProviderChat(cfg, payload)
    expect(openAIMocks.fetchOpenAICompat).toHaveBeenCalledWith('https://openai.test/v1', {
      apiKey: 'openai-key',
      body: payload
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('builds Gemini non-stream requests without an unsupported stream field', () => {
    const cfg = {
      url: 'https://generativelanguage.googleapis.com/v1beta',
      key: 'gemini-key',
      model: 'gemini-flash',
      apiFormat: API_FORMAT_GEMINI_GENERATE_CONTENT
    }

    const streamingRequest = buildProviderChatPayload(cfg, [{ role: 'user', content: 'Hi' }])
    const request = buildProviderNonStreamingPayload(cfg, streamingRequest)

    expect(request.url).toContain(':generateContent')
    expect(request.url).not.toContain(':streamGenerateContent')
    expect(request.body).not.toHaveProperty('stream')
  })

  it.each([
    ['direct', buildDirectChatApiMessages],
    ['group single', buildGroupSingleApiMessages],
    ['group multi', buildGroupMultiApiMessages]
  ])('sends Responses image content through the %s chat request path', async (_name, buildMessages) => {
    const cfg = {
      url: 'https://openai.test/v1',
      key: 'openai-key',
      model: 'gpt-test',
      apiFormat: API_FORMAT_OPENAI_RESPONSES
    }
    const messages = buildMessages([
      { role: 'user', content: 'Describe this', isImage: true, imageUrl: 'data:image/png;base64,abc' }
    ])
    const originalMessages = structuredClone(messages)
    const request = buildProviderChatPayload(cfg, messages)
    const nonStreamingRequest = buildProviderNonStreamingPayload(cfg, request)

    expect(request.body.input[0].content).toEqual([
      { type: 'input_text', text: expect.stringContaining('Describe this') },
      { type: 'input_image', image_url: 'data:image/png;base64,abc', detail: 'auto' }
    ])
    expect(nonStreamingRequest.body.input).toEqual(request.body.input)
    expect(nonStreamingRequest.body.stream).toBe(false)
    expect(messages).toEqual(originalMessages)

    await fetchProviderChat(cfg, request)
    expect(openAIMocks.fetchOpenAICompat).toHaveBeenLastCalledWith(cfg.url, {
      path: '/responses', targetUrl: request.url, apiKey: cfg.key, body: request.body
    })
    expect(buildProviderChatPayload({ ...cfg, apiFormat: API_FORMAT_OPENAI_COMPATIBLE }, messages).messages)
      .toEqual(originalMessages)
  })

  it('sends native Anthropic requests with custom headers and body applied last', async () => {
    const cfg = {
      url: 'https://api.anthropic.com',
      key: 'anthropic-key',
      model: 'claude-sonnet',
      apiFormat: API_FORMAT_ANTHROPIC_MESSAGES,
      customHeadersJson: '{"anthropic-version":"2024-01-01","x-extra":"1"}',
      customBodyJson: '{"metadata":{"source":"test"}}'
    }
    const request = buildProviderChatPayload(cfg, [{ role: 'user', content: 'Hi' }])
    const result = await fetchProviderChat(cfg, request)

    expect(result.request.targetUrl).toBe('https://api.anthropic.com/v1/messages')
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: expect.objectContaining({
        'x-api-key': 'anthropic-key',
        'anthropic-version': '2024-01-01',
        'x-extra': '1'
      }),
      body: JSON.stringify({
        ...request.body,
        metadata: { source: 'test' }
      })
    })
  })

  it('automatically removes unsupported sampling parameters from Claude Opus 4.7 requests', () => {
    const request = buildProviderChatPayload({
      url: 'https://api.anthropic.com',
      key: 'anthropic-key',
      model: 'claude-opus-4-7',
      temperature: 0.7,
      apiFormat: API_FORMAT_ANTHROPIC_MESSAGES,
      customBodyJson: '{"top_p":0.9,"top_k":40}'
    }, [{ role: 'user', content: 'Hi' }])

    expect(request.body).not.toHaveProperty('temperature')
    expect(request.body).not.toHaveProperty('top_p')
    expect(request.body).not.toHaveProperty('top_k')
  })

  it('keeps growing Claude chats within the cache limit after context summaries and custom tools are added', () => {
    const cacheControl = { type: 'ephemeral' }
    const cfg = {
      url: 'https://azure.test/anthropic',
      key: 'test-key',
      model: 'claude-opus-4-5',
      apiFormat: API_FORMAT_ANTHROPIC_MESSAGES,
      cacheConfig: { enabled: true },
      customBodyJson: JSON.stringify({
        tools: Array.from({ length: 4 }, (_, index) => ({
          name: `lookup_${index}`, input_schema: { type: 'object' }, cache_control: cacheControl
        }))
      })
    }
    const history = []
    for (let round = 0; round < 12; round += 1) {
      history.push({ role: 'user', content: `Question ${round}`, time: 1700000000000 + round * 3600000 })
      const messages = [
        { role: 'system', content: 'Character instructions' },
        ...buildContextMessages(history, { headRounds: 1, tailRounds: 2, middleSummary: 'Earlier conversation' }),
        { role: 'system', content: 'Reply format instructions' }
      ]

      const request = buildProviderChatPayload(cfg, messages)
      const blocks = [...request.body.tools, ...request.body.system, ...request.body.messages.flatMap(message => message.content)]
      expect(blocks.filter(part => part.cache_control).length).toBeLessThanOrEqual(4)
      expect(request.body.system.map(part => part.text)).toEqual(messages.filter(message => message.role === 'system').map(message => message.content))
      expect(request.body.system[0].cache_control).toEqual(cacheControl)
      expect(request.body.system.slice(1).every(part => !part.cache_control)).toBe(true)
      expect(request.body.messages.at(-1).content.at(-1).text).toBe(`Question ${round}`)

      history.push({ role: 'assistant', content: `Answer ${round}`, time: 1700000001000 + round * 3600000 })
    }
  })

  it('applies explicit nested removals after provider body normalization', () => {
    const request = buildProviderChatPayload({
      url: 'https://generativelanguage.googleapis.com/v1beta',
      key: 'gemini-key',
      model: 'gemini-flash',
      apiFormat: API_FORMAT_GEMINI_GENERATE_CONTENT,
      customBodyJson: '{"temperature":0.4,"generationConfig":{"topP":0.9}}',
      removeBodyParams: ['generationConfig.temperature', 'generationConfig.topP']
    }, [{ role: 'user', content: 'Hi' }])

    expect(request.body.generationConfig).toEqual({})
  })

  it('forwards validated custom headers for OpenAI-compatible and Responses requests', async () => {
    const compatibleCfg = {
      url: 'https://openai.test/v1',
      key: 'openai-key',
      model: 'gpt-test',
      apiFormat: API_FORMAT_OPENAI_COMPATIBLE,
      customHeadersJson: '{"HTTP-Referer":"https://app.example"}'
    }
    const compatiblePayload = buildProviderChatPayload(compatibleCfg, [{ role: 'user', content: 'Hi' }])
    await fetchProviderChat(compatibleCfg, compatiblePayload)

    expect(openAIMocks.fetchOpenAICompat).toHaveBeenLastCalledWith('https://openai.test/v1', {
      apiKey: 'openai-key',
      body: compatiblePayload,
      extraHeaders: { 'HTTP-Referer': 'https://app.example' }
    })

    const responsesCfg = {
      ...compatibleCfg,
      apiFormat: API_FORMAT_OPENAI_RESPONSES
    }
    const responsesRequest = buildProviderChatPayload(responsesCfg, [{ role: 'user', content: 'Hi' }])
    await fetchProviderChat(responsesCfg, responsesRequest)

    expect(openAIMocks.fetchOpenAICompat).toHaveBeenLastCalledWith('https://openai.test/v1', {
      path: '/responses',
      targetUrl: responsesRequest.url,
      apiKey: 'openai-key',
      body: responsesRequest.body,
      extraHeaders: { 'HTTP-Referer': 'https://app.example' }
    })
  })

  it.each([
    ['https://openai.test', 'https://openai.test/v1/responses'],
    ['https://proxy.test/api/v1/responses', 'https://proxy.test/api/v1/responses'],
    ['https://proxy.test/v1/chat/completions?route=1', 'https://proxy.test/v1/responses?route=1']
  ])('uses the resolved Responses endpoint for %s and its matching model endpoint', async (url, targetUrl) => {
    const cfg = { url, key: 'k', model: 'gpt-test', apiFormat: API_FORMAT_OPENAI_RESPONSES }
    const request = buildProviderChatPayload(cfg, [{ role: 'user', content: 'Hi' }])
    await fetchProviderChat(cfg, request)
    expect(openAIMocks.fetchOpenAICompat).toHaveBeenLastCalledWith(url, expect.objectContaining({ targetUrl }))
    openAIMocks.fetchOpenAICompat.mockResolvedValue({ request: {}, response: createOkResponse('{"data":[{"id":"gpt-test"}]}') })
    await fetchProviderModels(cfg)
    expect(openAIMocks.fetchOpenAICompat).toHaveBeenLastCalledWith(url, expect.objectContaining({ targetUrl: targetUrl.replace('/responses', '/models') }))
  })

  it('sends native Gemini requests', async () => {
    const cfg = {
      url: 'https://generativelanguage.googleapis.com/v1beta',
      key: 'gemini-key',
      model: 'gemini-flash',
      apiFormat: API_FORMAT_GEMINI_GENERATE_CONTENT
    }
    const request = buildProviderChatPayload(cfg, [{ role: 'user', content: 'Hi' }])
    await fetchProviderChat(cfg, request)

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash:streamGenerateContent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-goog-api-key': 'gemini-key' })
      })
    )
  })

  it('normalizes null message content after custom Responses body overrides', () => {
    const call = { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{}' }
    const request = buildProviderChatPayload({
      url: 'https://openai.test/v1', key: 'k', model: 'gpt-test', apiFormat: API_FORMAT_OPENAI_RESPONSES,
      customBodyJson: JSON.stringify({ input: [
        { role: 'assistant', content: null },
        { type: 'message', role: 'assistant', id: 'msg_1', content: null },
        call,
        { type: 'function_call_output', call_id: 'call_1', output: 'Result' }
      ] })
    }, [{ role: 'user', content: 'Hi' }])
    expect(request.body.input).toEqual([
      { role: 'assistant', content: '' },
      { type: 'message', role: 'assistant', id: 'msg_1', content: '' },
      call,
      { type: 'function_call_output', call_id: 'call_1', output: 'Result' }
    ])
  })

  it('routes stream consumers and error readers by provider format', async () => {
    const anthropicResponse = new Response('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"A"}}\n\n')
    const anthropicChunks = []
    await expect(consumeProviderChatStream({ apiFormat: API_FORMAT_ANTHROPIC_MESSAGES }, anthropicResponse, delta => anthropicChunks.push(delta)))
      .resolves.toMatchObject({ emittedChars: 1 })
    expect(anthropicChunks).toEqual(['A'])

    const geminiResponse = new Response('data: {"candidates":[{"content":{"parts":[{"text":"G"}]}}]}\n\n')
    const geminiChunks = []
    await expect(consumeProviderChatStream({ apiFormat: API_FORMAT_GEMINI_GENERATE_CONTENT }, geminiResponse, delta => geminiChunks.push(delta)))
      .resolves.toMatchObject({ emittedChars: 1 })
    expect(geminiChunks).toEqual(['G'])

    await expect(readProviderChatError({ apiFormat: API_FORMAT_OPENAI_COMPATIBLE }, createOkResponse())).resolves.toBe('openai error')
    expect(openAIMocks.readOpenAICompatError).toHaveBeenCalled()
  })

  it('uses the OpenAI tool-aware stream parser when requested', async () => {
    const response = new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_diary","arguments":"{\\"content\\":"}}]},"finish_reason":null}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"今天很好\\"}"}}]},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      ''
    ].join('\n'))

    const result = await consumeProviderChatStream({ apiFormat: API_FORMAT_OPENAI_COMPATIBLE }, response, () => {}, {
      toolAware: true
    })

    expect(result.toolCalls).toEqual([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'write_diary',
          arguments: '{"content":"今天很好"}'
        }
      }
    ])
  })

  it('fetches model lists using provider-native endpoints', async () => {
    openAIMocks.fetchOpenAICompat.mockResolvedValueOnce({
      request: { targetUrl: 'https://openai.test/v1/models' },
      response: new Response('{"data":[{"id":"gpt-4o"},{"id":"gpt-4.1"}]}')
    })
    await expect(fetchProviderModels({
      url: 'https://openai.test/v1',
      key: 'openai-key',
      apiFormat: API_FORMAT_OPENAI_COMPATIBLE
    })).resolves.toEqual({
      request: expect.objectContaining({ targetUrl: 'https://openai.test/v1/models' }),
      models: ['gpt-4.1', 'gpt-4o']
    })

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"data":[{"id":"claude-sonnet-4-5"},{"id":"claude-opus-4-1"}]}'))
      .mockResolvedValueOnce(new Response('{"models":[{"name":"models/gemini-2.5-flash"},{"name":"models/gemini-2.5-pro"}]}'))

    await expect(fetchProviderModels({
      url: 'https://api.anthropic.com',
      key: 'anthropic-key',
      apiFormat: API_FORMAT_ANTHROPIC_MESSAGES,
      customHeadersJson: '{"anthropic-version":"2024-01-01"}'
    })).resolves.toEqual({
      request: expect.objectContaining({ targetUrl: 'https://api.anthropic.com/v1/models' }),
      models: ['claude-opus-4-1', 'claude-sonnet-4-5']
    })
    expect(globalThis.fetch).toHaveBeenNthCalledWith(1, 'https://api.anthropic.com/v1/models', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({
        'x-api-key': 'anthropic-key',
        'anthropic-version': '2024-01-01'
      })
    }))

    await expect(fetchProviderModels({
      url: 'https://generativelanguage.googleapis.com/v1beta',
      key: 'gemini-key',
      apiFormat: API_FORMAT_GEMINI_GENERATE_CONTENT
    })).resolves.toEqual({
      request: expect.objectContaining({ targetUrl: 'https://generativelanguage.googleapis.com/v1beta/models' }),
      models: ['gemini-2.5-flash', 'gemini-2.5-pro']
    })
    expect(globalThis.fetch).toHaveBeenNthCalledWith(2, 'https://generativelanguage.googleapis.com/v1beta/models', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ 'x-goog-api-key': 'gemini-key' })
    }))
  })

  it('falls back to OpenAI-style model listing when native anthropic request fails (relay/CORS)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    openAIMocks.fetchOpenAICompat.mockResolvedValueOnce({
      request: { targetUrl: 'https://openrouter.ai/api/v1/models' },
      response: new Response('{"data":[{"id":"anthropic/claude-sonnet-4.6"}]}')
    })

    await expect(fetchProviderModels({
      url: 'https://openrouter.ai/api/v1',
      key: 'or-key',
      apiFormat: API_FORMAT_ANTHROPIC_MESSAGES
    })).resolves.toEqual({
      request: expect.objectContaining({ targetUrl: 'https://openrouter.ai/api/v1/models' }),
      models: ['anthropic/claude-sonnet-4.6']
    })
    expect(openAIMocks.fetchOpenAICompat).toHaveBeenCalledWith('https://openrouter.ai/api/v1', expect.objectContaining({
      path: '/models',
      method: 'GET',
      apiKey: 'or-key'
    }))
  })

  it('reports the native anthropic error when the OpenAI-style fallback also fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    openAIMocks.fetchOpenAICompat.mockRejectedValueOnce(new Error('fallback failed'))

    await expect(fetchProviderModels({
      url: 'https://api.anthropic.com',
      key: 'anthropic-key',
      apiFormat: API_FORMAT_ANTHROPIC_MESSAGES
    })).rejects.toThrow('Failed to fetch')
  })

  it('sends the dangerous-direct-browser-access header on native anthropic model requests', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"data":[{"id":"claude-opus-4-7"}]}'))

    await fetchProviderModels({
      url: 'https://api.anthropic.com',
      key: 'anthropic-key',
      apiFormat: API_FORMAT_ANTHROPIC_MESSAGES
    })
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      })
    }))
  })

  it('uses CORS-safe relay headers for anthropic requests to non-official hosts', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"data":[{"id":"anthropic/claude-sonnet-4.6"}]}'))

    await fetchProviderModels({
      url: 'https://openrouter.ai/api/v1',
      key: 'or-key',
      apiFormat: API_FORMAT_ANTHROPIC_MESSAGES
    })
    const [, init] = globalThis.fetch.mock.calls[0]
    expect(init.headers).toMatchObject({
      'x-api-key': 'or-key',
      Authorization: 'Bearer or-key'
    })
    expect(init.headers['anthropic-version']).toBeUndefined()
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined()
  })
})
