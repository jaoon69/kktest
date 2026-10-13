import { describe, expect, it, vi } from 'vitest'

import {
  ANTHROPIC_LEADING_USER_PLACEHOLDER,
  buildAnthropicMessagesRequest,
  consumeAnthropicMessagesStream,
  extractAnthropicNonStreamText,
  normalizeAnthropicToolResultMessage,
  readAnthropicMessagesError,
  resolveAnthropicMessagesUrl,
  sanitizeAnthropicBody
} from './anthropicMessages'

function createTextResponse(text, init = {}) {
  return new Response(text, init)
}

describe('anthropicMessages adapter', () => {
  it('resolves base URLs to /v1/messages without duplicating complete endpoints', () => {
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/messages')
    expect(resolveAnthropicMessagesUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/messages')
    expect(resolveAnthropicMessagesUrl('https://proxy.test/v1/messages')).toBe('https://proxy.test/v1/messages')
  })

  it('builds Anthropic headers and converts normalized chat messages', () => {
    const request = buildAnthropicMessagesRequest({
      url: 'https://api.anthropic.com/v1',
      key: 'test-key',
      model: 'claude-sonnet-4-5',
      temperature: 0.4,
      maxTokens: 2048
    }, [
      { role: 'system', content: 'You are kind.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'system', content: 'Reply in Chinese.' }
    ])

    expect(request.url).toBe('https://api.anthropic.com/v1/messages')
    expect(request.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01'
    })
    expect(request.body).toEqual({
      model: 'claude-sonnet-4-5',
      stream: true,
      max_tokens: 2048,
      temperature: 0.4,
      system: [
        { type: 'text', text: 'You are kind.' },
        { type: 'text', text: 'Reply in Chinese.' }
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] }
      ]
    })
  })

  it('adds a five-minute Anthropic cache breakpoint without a client-side character threshold', () => {
    const systemPrompt = 'Short prompts are left for Anthropic to evaluate.'
    const request = buildAnthropicMessagesRequest({
      url: 'https://api.anthropic.com',
      key: 'test-key',
      model: 'claude-sonnet',
      cacheConfig: { enabled: true, systemPrompt: true, ttl: '5m' }
    }, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Hi' }
    ])

    expect(request.body.system).toEqual([
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' }
      }
    ])
  })

  it('adds the selected one-hour TTL to Anthropic cache breakpoints', () => {
    const request = buildAnthropicMessagesRequest({
      url: 'https://api.anthropic.com',
      key: 'test-key',
      model: 'claude-sonnet',
      cacheConfig: { enabled: true, ttl: '1h' }
    }, [
      { role: 'system', content: 'Reusable system prompt' },
      { role: 'user', content: 'Hi' }
    ])

    expect(request.body.system[0].cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h'
    })
  })

  it.each(['5m', '1h'])('caches the main prompt without marking dynamic system blocks with a %s TTL', (ttl) => {
    const texts = Array.from({ length: 30 }, (_, index) => `System section ${index}`)
    const messages = [
      { role: 'system', content: texts[0] },
      { role: 'user', content: 'Hi' },
      { role: 'system', content: texts.slice(1).map(text => ({ type: 'text', text })) }
    ]
    const originalMessages = structuredClone(messages)
    const cfg = { key: 'test-key', model: 'claude-opus-4-5', cacheConfig: { enabled: true, ttl } }

    const request = buildAnthropicMessagesRequest(cfg, messages)
    const cached = request.body.system.filter(part => part.cache_control)

    expect(request.body.system.map(part => part.text)).toEqual(texts)
    expect(cached.map(part => part.text)).toEqual([texts[0]])
    expect(cached.every(part => (part.cache_control.ttl || '5m') === ttl)).toBe(true)
    expect(messages).toEqual(originalMessages)
    expect(buildAnthropicMessagesRequest(cfg, messages)).toEqual(request)
  })

  it('places one cache breakpoint at the end of a main prompt containing multiple text blocks', () => {
    const texts = Array.from({ length: 6 }, (_, index) => `Reusable section ${index}`)
    const request = buildAnthropicMessagesRequest({ key: 'test-key', cacheConfig: { enabled: true } }, [
      { role: 'system', content: texts.map(text => ({ type: 'text', text })) },
      { role: 'system', content: 'Changing history summary' },
      { role: 'user', content: 'Hi' },
      { role: 'system', content: 'Current time' }
    ])

    expect(request.body.system.filter(part => part.cache_control)).toEqual([
      { type: 'text', text: texts.at(-1), cache_control: { type: 'ephemeral' } }
    ])
    expect(request.body.system.map(part => part.text)).toEqual([...texts, 'Changing history summary', 'Current time'])
  })

  it('does not treat a system instruction after conversation as a reusable main prompt', () => {
    const request = buildAnthropicMessagesRequest({ key: 'test-key', cacheConfig: { enabled: true } }, [
      { role: 'user', content: 'Hi' },
      { role: 'system', content: 'Current time' }
    ])

    expect(request.body.system).toEqual([{ type: 'text', text: 'Current time' }])
  })

  it.each([{ enabled: false }, { enabled: true, systemPrompt: false }])('does not add cache breakpoints when disabled by %j', (cacheConfig) => {
    const request = buildAnthropicMessagesRequest({ key: 'test-key', cacheConfig }, [
      { role: 'system', content: 'Character instructions' },
      { role: 'system', content: 'Context summary' },
      { role: 'user', content: 'Hi' }
    ])

    expect(request.body.system.every(part => !part.cache_control)).toBe(true)
  })

  it('consumes Anthropic SSE text and usage deltas', async () => {
    const response = createTextResponse([
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"好"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      ''
    ].join('\n'))

    const chunks = []
    const result = await consumeAnthropicMessagesStream(response, delta => chunks.push(delta))

    expect(chunks).toEqual(['你', '好'])
    expect(result).toMatchObject({
      emittedChars: 2,
      emittedEvents: 2,
      finishReason: 'end_turn',
      usage: { output_tokens: 2 }
    })
  })

  it('captures Anthropic thinking blocks without emitting them as chat text', async () => {
    const response = createTextResponse([
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"先检查"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"天气工具"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"查好了"}}',
      ''
    ].join('\n'))

    const chunks = []
    const onReasoningDelta = vi.fn()
    const result = await consumeAnthropicMessagesStream(response, delta => chunks.push(delta), { onReasoningDelta })

    expect(chunks).toEqual(['查好了'])
    expect(onReasoningDelta.mock.calls).toEqual([
      ['先检查'],
      ['先检查天气工具']
    ])
    expect(result.reasoningContent).toBe('先检查天气工具')
  })

  it('maps OpenAI-style tools and parses Anthropic tool_use blocks', async () => {
    const request = buildAnthropicMessagesRequest({
      url: 'https://api.anthropic.com',
      key: 'test-key',
      model: 'claude-sonnet'
    }, [{ role: 'user', content: '记一下' }], {
      tools: [
        {
          type: 'function',
          function: {
            name: 'write_diary',
            description: '写日记',
            parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }
          }
        }
      ]
    })

    expect(request.body.tools).toEqual([
      {
        name: 'write_diary',
        description: '写日记',
        input_schema: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }
      }
    ])

    const response = createTextResponse([
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"write_diary","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"content\\":"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"今天很好\\"}"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
      ''
    ].join('\n'))

    const result = await consumeAnthropicMessagesStream(response, () => {})
    expect(result.finishReason).toBe('tool_use')
    expect(result.toolCalls).toEqual([
      {
        id: 'toolu_1',
        type: 'function',
        function: {
          name: 'write_diary',
          arguments: '{"content":"今天很好"}'
        }
      }
    ])
  })

  it('maps existing tool result messages into Anthropic user tool_result blocks', () => {
    expect(normalizeAnthropicToolResultMessage({
      role: 'tool',
      tool_call_id: 'toolu_1',
      content: '{"success":true}'
    })).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: '{"success":true}'
        }
      ]
    })
  })

  it('maps assistant tool_calls into Anthropic assistant tool_use blocks for follow-up rounds', () => {
    const request = buildAnthropicMessagesRequest({
      url: 'https://api.anthropic.com',
      key: 'test-key',
      model: 'claude-sonnet'
    }, [
      { role: 'user', content: '记一下' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'toolu_1',
            type: 'function',
            function: {
              name: 'write_diary',
              arguments: '{"content":"今天很好"}'
            }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: '{"success":true}' }
    ])

    expect(request.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '记一下' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'write_diary',
            input: { content: '今天很好' }
          }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: '{"success":true}'
          }
        ]
      }
    ])
  })

  it('extracts non-stream text from Anthropic message responses', () => {
    expect(extractAnthropicNonStreamText({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', name: 'ignored' },
        { type: 'text', text: ' world' }
      ]
    })).toBe('hello world')
  })

  it('reads Anthropic error messages from JSON or text responses', async () => {
    await expect(readAnthropicMessagesError(createTextResponse('{"error":{"message":"bad key"}}'))).resolves.toBe('bad key')
    await expect(readAnthropicMessagesError(createTextResponse('plain failure', { status: 500 }))).resolves.toBe('plain failure')
  })

  it('strips OpenAI-only parameters from body', () => {
    const body = sanitizeAnthropicBody({
      model: 'claude-sonnet-4-5',
      temperature: 0.7,
      max_tokens: 1024,
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
      logprobs: true,
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
      seed: 42,
      messages: []
    })
    expect(body.model).toBe('claude-sonnet-4-5')
    expect(body.temperature).toBe(0.7)
    expect(body.max_tokens).toBe(1024)
    expect(body).not.toHaveProperty('stream_options')
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('logprobs')
    expect(body).not.toHaveProperty('frequency_penalty')
    expect(body).not.toHaveProperty('presence_penalty')
    expect(body).not.toHaveProperty('seed')
  })

  it.each([false, true])('limits cache breakpoints across tools, system and messages (automatic cache: %s)', (automaticCache) => {
    const cacheControl = { type: 'ephemeral' }
    const original = {
      ...(automaticCache ? { cache_control: cacheControl } : {}),
      tools: [{ name: 'lookup', input_schema: { type: 'object' }, cache_control: cacheControl }],
      system: Array.from({ length: 3 }, (_, index) => ({
        type: 'text', text: `System ${index}`, cache_control: cacheControl
      })),
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'url', url: 'https://example.com/image.png' }, cache_control: cacheControl },
        { type: 'text', text: 'Describe this image', cache_control: cacheControl }
      ] }]
    }
    const snapshot = structuredClone(original)

    const body = sanitizeAnthropicBody(original)
    const cachedBlocks = [...body.tools, ...body.system, ...body.messages[0].content]
      .filter(part => part.cache_control)
    expect(cachedBlocks).toHaveLength(automaticCache ? 3 : 4)
    expect(cachedBlocks[0]).toEqual(original.tools[0])
    expect(cachedBlocks.at(-1)).toEqual(original.messages[0].content.at(-1))
    const withoutCache = value => JSON.parse(JSON.stringify(value, (key, child) => key === 'cache_control' ? undefined : child))
    expect(withoutCache(body)).toEqual(withoutCache(original))
    expect(body.cache_control).toEqual(original.cache_control)
    expect(original).toEqual(snapshot)
    expect(sanitizeAnthropicBody(body)).toEqual(body)
  })

  it('drops top_p when temperature is also present', () => {
    const body = sanitizeAnthropicBody({ temperature: 0.5, top_p: 0.9, max_tokens: 100 })
    expect(body.temperature).toBe(0.5)
    expect(body).not.toHaveProperty('top_p')
  })

  it('keeps top_p when temperature is absent', () => {
    const body = sanitizeAnthropicBody({ top_p: 0.9, max_tokens: 100 })
    expect(body.top_p).toBe(0.9)
  })

  it('drops empty text blocks and empty messages instead of sending blank content', () => {
    const request = buildAnthropicMessagesRequest({
      url: 'https://api.anthropic.com',
      key: 'k',
      model: 'claude-sonnet'
    }, [
      { role: 'system', content: '' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: '' },
      { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: 'Second' }] }
    ])

    expect(request.body).not.toHaveProperty('system')
    expect(request.body.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hi' },
          { type: 'text', text: 'Second' }
        ]
      }
    ])
  })

  it('prepends a placeholder user turn when conversation starts with assistant', () => {
    const request = buildAnthropicMessagesRequest({
      url: 'https://api.anthropic.com',
      key: 'k',
      model: 'claude-sonnet'
    }, [
      { role: 'assistant', content: '你好！我是开场白' },
      { role: 'user', content: '嗨' }
    ])

    expect(request.body.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: ANTHROPIC_LEADING_USER_PLACEHOLDER }]
    })
    expect(request.body.messages[1].role).toBe('assistant')
  })

  it('merges consecutive same-role messages into a single turn', () => {
    const request = buildAnthropicMessagesRequest({
      url: 'https://api.anthropic.com',
      key: 'k',
      model: 'claude-sonnet'
    }, [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: '回复1' },
      { role: 'assistant', content: '回复2' },
      { role: 'user', content: 'B' }
    ])

    expect(request.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'A' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '回复1' },
          { type: 'text', text: '回复2' }
        ]
      },
      { role: 'user', content: [{ type: 'text', text: 'B' }] }
    ])
  })

  it('places tool_result blocks before text when merging user turns', () => {
    const request = buildAnthropicMessagesRequest({
      url: 'https://api.anthropic.com',
      key: 'k',
      model: 'claude-sonnet'
    }, [
      { role: 'user', content: '记一下' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'write_diary', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: '{"ok":true}' },
      { role: 'user', content: '继续' }
    ])

    const lastMessage = request.body.messages[request.body.messages.length - 1]
    expect(lastMessage.role).toBe('user')
    expect(lastMessage.content[0].type).toBe('tool_result')
    expect(lastMessage.content[1]).toEqual({ type: 'text', text: '继续' })
  })

  it('trims trailing whitespace from a final assistant message', () => {
    const request = buildAnthropicMessagesRequest({
      url: 'https://api.anthropic.com',
      key: 'k',
      model: 'claude-sonnet'
    }, [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: '回答开头  \n' }
    ])

    expect(request.body.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '回答开头' }]
    })
  })

  it('omits tool_result content when the tool output is empty', () => {
    expect(normalizeAnthropicToolResultMessage({
      role: 'tool',
      tool_call_id: 'toolu_1',
      content: ''
    })).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }]
    })
  })
})
