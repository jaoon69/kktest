import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildProviderChatPayload, consumeProviderChatStream, extractProviderNonStreamText, fetchProviderChat } from './providerRequest'
import { runOpenAICompatTextStream } from './openaiCompatTextStream'
import { executeToolAwareStreamedRequest } from './toolAwareStreamingRequest'
import { recordUsage } from './usage'

vi.mock('../useDebugLog', () => ({ addDebugLog: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

const tools = [{ type: 'function', function: { name: 'lookup_test', parameters: { type: 'object', properties: {} } } }]
const user = { role: 'user', content: 'Look it up' }
const cfg = apiFormat => ({ apiFormat, url: 'https://provider.test/v1', key: 'test-key', model: 'test-model' })
const sse = frames => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''))

const anthropicFrames = [
  { type: 'message_start', message: { usage: { input_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'Think', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ' more' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-thinking' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup_test', input: {} } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
  { type: 'message_stop' }
]
const geminiFrames = [{ candidates: [{ content: { parts: [
  { thought: true, text: 'Think', thoughtSignature: 'signed-thought' },
  { functionCall: { id: 'call_1', name: 'lookup_test', args: {} }, thoughtSignature: 'signed-call' }
] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2000, cachedContentTokenCount: 1500, candidatesTokenCount: 20, totalTokenCount: 2020 } }]

describe('native provider continuation and caching', () => {
  it.each(['openai-responses', 'anthropic-messages', 'gemini-generate-content'])('routes old auxiliary request bodies through %s', async apiFormat => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await fetchProviderChat(cfg(apiFormat), { model: 'test-model', messages: [user], max_tokens: 120, temperature: 0.3 })
    const [url, options] = fetchMock.mock.calls[0]
    const body = JSON.parse(options.body)
    if (apiFormat === 'openai-responses') {
      expect(url).toBe('https://provider.test/v1/responses')
      expect(body).toMatchObject({ input: [user], max_output_tokens: 120, stream: false })
    } else if (apiFormat === 'anthropic-messages') {
      expect(body).toMatchObject({ messages: [{ role: 'user', content: [{ type: 'text', text: user.content }] }], max_tokens: 120, stream: false })
    } else {
      expect(url).toContain(':generateContent')
      expect(body).toMatchObject({ contents: [{ role: 'user', parts: [{ text: user.content }] }], generationConfig: { maxOutputTokens: 120 } })
    }
  })

  it('streams Responses in legacy reading/VN helpers without losing repeated deltas', async () => {
    const fetchMock = vi.fn().mockResolvedValue(sse([
      { type: 'response.output_text.delta', delta: '哈' },
      { type: 'response.output_text.delta', delta: '哈' },
      { type: 'response.completed', response: { status: 'completed' } }
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const result = await runOpenAICompatTextStream({ cfg: cfg('openai-responses'), body: { messages: [user], stream: true } })
    expect(result.text).toBe('哈哈')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).input).toEqual([user])
  })

  it('continues Responses tools when the upstream response contains an empty native assistant message', async () => {
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup_test', arguments: '{}' }
    const fetchMock = vi.fn().mockResolvedValueOnce(sse([
      { type: 'response.completed', response: { status: 'completed', output: [
        { type: 'message', id: 'msg_empty', role: 'assistant', status: 'completed', content: null }, call
      ] } }
    ])).mockResolvedValueOnce(sse([
      { type: 'response.output_text.delta', delta: 'Result' },
      { type: 'response.completed', response: { status: 'completed' } }
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const executor = vi.fn().mockResolvedValue({ success: true, result: { text: 'Found' } })
    const history = Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `History ${index}` }))
    const result = await executeToolAwareStreamedRequest({
      cfg: cfg('openai-responses'), messages: history, activeChat: { msgs: [] }, makeMsgId: () => 'msg_1', traceId: 'trace_null', tools,
      externalExecutors: new Map([['lookup_test', executor]]), toolContext: {},
      createStreamChunkBatcher: message => ({ push: delta => { message.content += delta }, flushNow() {} })
    })
    const request = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(request.input[6]).toMatchObject({ type: 'message', id: 'msg_empty', content: '' })
    expect(request.input[7]).toEqual(call)
    expect(request.input[8]).toMatchObject({ type: 'function_call_output', call_id: 'call_1' })
    expect(executor).toHaveBeenCalledTimes(1)
    expect(result.streamMsg.content).toBe('Result')
  })

  it('keeps Messages input/cache usage and signed thinking through tool continuation', async () => {
    const config = { ...cfg('anthropic-messages'), cacheConfig: { enabled: true, ttl: '1h' } }
    const result = await consumeProviderChatStream(config, sse(anthropicFrames), () => {})
    expect(result.usage).toEqual({ input_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500, output_tokens: 20 })
    expect(result.nativeAssistantMessage.content).toEqual([
      { type: 'thinking', thinking: 'Think more', signature: 'signed-thinking' },
      { type: 'tool_use', id: 'toolu_1', name: 'lookup_test', input: {} }
    ])
    const request = buildProviderChatPayload(config, [
      { role: 'system', content: 'Stable character prompt' }, user, result.nativeAssistantMessage,
      { role: 'tool', tool_call_id: 'toolu_1', name: 'lookup_test', content: '{"result":"ok"}' }
    ], { tools })
    expect(request.body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(request.body.messages[1].content).toEqual(result.nativeAssistantMessage.content)
    expect(request.body.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '{"result":"ok"}' }] })
  })

  it('keeps Gemini signatures and matching function response IDs', async () => {
    const config = cfg('gemini-generate-content')
    const result = await consumeProviderChatStream(config, sse(geminiFrames), () => {})
    const request = buildProviderChatPayload(config, [user, result.nativeAssistantMessage,
      { role: 'tool', tool_call_id: 'call_1', name: 'lookup_test', content: '{"result":"ok"}' }
    ], { tools })
    expect(request.body.contents[1]).toEqual({ role: 'model', parts: geminiFrames[0].candidates[0].content.parts })
    expect(request.body.contents[2]).toEqual({ role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'lookup_test', response: { result: 'ok' } } }] })
  })

  it('assigns distinct Gemini fallback call IDs across frames and avoids replaying JSON-only tools twice', async () => {
    const config = cfg('gemini-generate-content')
    const frame = { candidates: [{ content: { parts: [{ functionCall: { name: 'lookup_test', args: {} } }] } }] }
    const streamed = await consumeProviderChatStream(config, sse([frame, frame]), () => {})
    expect(streamed.toolCalls.map(call => call.id)).toEqual(['gemini_call_0', 'gemini_call_1'])
    const json = await consumeProviderChatStream(config, new Response(JSON.stringify(frame)), () => {})
    expect(json.toolCalls).toHaveLength(1)
  })

  it('keeps cache markers within the limit and corrects mixed TTL ordering without changing prompt text', () => {
    const cache = ttl => ({ type: 'ephemeral', ttl })
    const body = {
      tools: [{ name: 'lookup', input_schema: {}, cache_control: cache('5m') }],
      system: [{ type: 'text', text: 'Stable', cache_control: cache('1h') }],
      messages: [{ role: 'user', content: Array.from({ length: 6 }, (_, index) => ({ type: 'text', text: String(index), cache_control: cache('1h') })) }],
      cache_control: cache('1h')
    }
    const config = { ...cfg('anthropic-messages'), customBodyJson: JSON.stringify(body) }
    const request = buildProviderChatPayload(config, [user])
    const blocks = [...request.body.tools, ...request.body.system, ...request.body.messages[0].content]
    expect(blocks.filter(block => block.cache_control).length + 1).toBeLessThanOrEqual(4)
    expect(blocks.filter(block => block.cache_control).every(block => block.cache_control.ttl === '5m')).toBe(true)
    expect(request.body.cache_control.ttl).toBe('5m')
    expect(request.body.messages[0].content.map(block => block.text)).toEqual(body.messages[0].content.map(block => block.text))
    const thinking = buildProviderChatPayload({ ...cfg('anthropic-messages'), customBodyJson: JSON.stringify({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's', cache_control: cache('5m') }] }] }) }, [user])
    expect(thinking.body.messages[0].content[0]).not.toHaveProperty('cache_control')
  })

  it.each(['openai-compatible', 'openai-responses', 'gemini-generate-content'])('preserves %s cache options without injecting Claude markers', apiFormat => {
    const overrides = apiFormat === 'gemini-generate-content'
      ? { cachedContent: 'cachedContents/test' }
      : { prompt_cache_key: 'stable-key', prompt_cache_retention: '24h' }
    const config = { ...cfg(apiFormat), cacheConfig: { enabled: true }, customBodyJson: JSON.stringify(overrides), removeBodyParams: apiFormat === 'gemini-generate-content' ? ['systemInstruction', 'tools', 'toolConfig'] : [] }
    const request = buildProviderChatPayload(config, [user])
    expect(request.body || request).toMatchObject(overrides)
    expect(JSON.stringify(request)).not.toContain('cache_control')
  })

  it.each(['anthropic-messages', 'gemini-generate-content'])('preserves configured output limits for %s auxiliary calls', apiFormat => {
    const request = buildProviderChatPayload({ ...cfg(apiFormat), maxTokens: 4096 }, [user], { maxTokens: 120 })
    expect(request.body.max_tokens || request.body.generationConfig.maxOutputTokens).toBe(4096)
  })

  it.each(['anthropic-messages', 'gemini-generate-content'])('surfaces %s stream and JSON failures', async apiFormat => {
    const payload = { type: 'error', error: { message: 'upstream failed' } }
    await expect(consumeProviderChatStream(cfg(apiFormat), sse([payload]), () => {})).rejects.toThrow('upstream failed')
    expect(() => extractProviderNonStreamText(cfg(apiFormat), payload)).toThrow('upstream failed')
  })

  it.each([
    ['anthropic-messages', anthropicFrames, [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Result' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }]],
    ['gemini-generate-content', geminiFrames, [{ candidates: [{ content: { parts: [{ text: 'Result' }] }, finishReason: 'STOP' }] }]]
  ])('completes an actual %s tool loop using preserved native history', async (apiFormat, firstFrames, lastFrames) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sse(firstFrames)).mockResolvedValueOnce(sse(lastFrames))
    vi.stubGlobal('fetch', fetchMock)
    const executor = vi.fn().mockResolvedValue({ success: true, result: { text: 'Found' } })
    const activeChat = { msgs: [] }
    const result = await executeToolAwareStreamedRequest({
      cfg: cfg(apiFormat), messages: [user], activeChat, makeMsgId: () => 'msg_1', traceId: 'trace_test', tools,
      externalExecutors: new Map([['lookup_test', executor]]), toolContext: {},
      createStreamChunkBatcher: message => ({ push: delta => { message.content += delta }, flushNow() {} })
    })
    expect(executor).toHaveBeenCalledTimes(1)
    expect(result.streamMsg.content).toBe('Result')
    const request = JSON.parse(fetchMock.mock.calls[1][1].body)
    if (apiFormat === 'anthropic-messages') {
      expect(request.messages[1].content[0].signature).toBe('signed-thinking')
      expect(request.messages[2].content[0].tool_use_id).toBe('toolu_1')
    } else {
      expect(request.contents[1].parts[1].thoughtSignature).toBe('signed-call')
      expect(request.contents[2].parts[0].functionResponse.id).toBe('call_1')
    }
  })

  it('adds Claude cache input once and records every tool round while avoiding double counting OpenAI and Gemini cache hits', () => {
    const contact = {}
    recordUsage(contact, {}, null, 'claude-test', { roundUsages: [
      { input_tokens: 0, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500, output_tokens: 20 },
      { input_tokens: 10, cache_read_input_tokens: 2500, cache_creation_input_tokens: 0, output_tokens: 30 }
    ] })
    expect(contact.tokenStats.lastCalls[0]).toMatchObject({ promptTokens: 5010, completionTokens: 50, totalTokens: 5060, cacheReadTokens: 4500, cacheWriteTokens: 500, estimated: false })
    for (const usage of [
      { input_tokens: 2000, output_tokens: 20, input_tokens_details: { cached_tokens: 1500 } },
      { promptTokenCount: 2000, candidatesTokenCount: 20, cachedContentTokenCount: 1500 }
    ]) {
      const other = {}
      recordUsage(other, { usage })
      expect(other.tokenStats.lastCalls[0]).toMatchObject({ promptTokens: 2000, completionTokens: 20, cacheReadTokens: 1500 })
    }
  })
})
