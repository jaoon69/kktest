import { describe, expect, it, vi } from 'vitest'

import {
  buildOpenAIResponsesRequest,
  consumeOpenAIResponsesStream,
  extractOpenAIResponsesNonStreamText,
  resolveOpenAIResponsesUrl
} from './openaiResponses'

function createSSEResponse(events) {
  const text = events.map(e => {
    let lines = ''
    if (e.event) lines += `event: ${e.event}\n`
    lines += `data: ${JSON.stringify(e.data)}\n\n`
    return lines
  }).join('')
  return new Response(text)
}

describe('openaiResponses adapter', () => {
  it('resolves base URLs to /v1/responses', () => {
    expect(resolveOpenAIResponsesUrl('https://api.openai.com')).toBe('https://api.openai.com/v1/responses')
    expect(resolveOpenAIResponsesUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/responses')
    expect(resolveOpenAIResponsesUrl('https://proxy.test/v1/responses')).toBe('https://proxy.test/v1/responses')
    expect(resolveOpenAIResponsesUrl('')).toBe('/v1/responses')
    expect(resolveOpenAIResponsesUrl('https://proxy.test/v1/chat/completions')).toBe('https://proxy.test/v1/responses')
    expect(resolveOpenAIResponsesUrl('https://proxy.test/v1/?route=chat')).toBe('https://proxy.test/v1/responses?route=chat')
    expect(resolveOpenAIResponsesUrl('https://proxy.test/v1/responses?route=chat')).toBe('https://proxy.test/v1/responses?route=chat')
  })

  it('keeps configured output limits ahead of auxiliary call defaults', () => {
    const cfg = { model: 'gpt-test', key: 'k', maxTokens: 4096 }
    expect(buildOpenAIResponsesRequest(cfg, [], { maxTokens: 120 }).body.max_output_tokens).toBe(4096)
    expect(buildOpenAIResponsesRequest({ ...cfg, maxTokens: '' }, [], { maxTokens: 120 }).body.max_output_tokens).toBe(120)
  })

  it('preserves optional tool fields, explicit strict mode and native tools', () => {
    const nativeTool = { type: 'web_search', search_context_size: 'low' }
    const request = buildOpenAIResponsesRequest({ model: 'gpt-test', key: 'k' }, [], {
      tools: [
        { type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: { query: { type: 'string' }, topic: { type: 'string' } }, required: ['query'] } } },
        { type: 'function', name: 'strict_lookup', strict: true, parameters: { type: 'object', properties: {}, additionalProperties: false } },
        nativeTool
      ],
      tool_choice: { type: 'function', function: { name: 'web_search' } }
    })
    expect(request.body.tools[0]).toMatchObject({ name: 'web_search', strict: false, parameters: { required: ['query'] } })
    expect(request.body.tools[1].strict).toBe(true)
    expect(request.body.tools[2]).toEqual(nativeTool)
    expect(request.body.tool_choice).toEqual({ type: 'function', name: 'web_search' })
  })

  it('builds request with system as instructions and messages as input', () => {
    const request = buildOpenAIResponsesRequest({
      url: 'https://api.openai.com/v1',
      key: 'test-key',
      model: 'gpt-4o',
      temperature: 0.7,
      maxTokens: 2048
    }, [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' }
    ])

    expect(request.url).toBe('https://api.openai.com/v1/responses')
    expect(request.headers).toMatchObject({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-key'
    })
    expect(request.body.model).toBe('gpt-4o')
    expect(request.body.instructions).toBe('You are helpful.')
    expect(request.body.input).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' }
    ])
    expect(request.body.temperature).toBe(0.7)
    expect(request.body.max_output_tokens).toBe(2048)
    expect(request.body.stream).toBe(true)
  })

  it('converts tool messages to function_call_output', () => {
    const request = buildOpenAIResponsesRequest({
      model: 'gpt-4o', key: 'k'
    }, [
      { role: 'tool', tool_call_id: 'call_1', content: '{"result": 42}' }
    ])

    expect(request.body.input).toEqual([{
      type: 'function_call_output',
      call_id: 'call_1',
      output: '{"result": 42}'
    }])
  })

  it('includes assistant function calls before their outputs without null message content', () => {
    const messages = [
      { role: 'user', content: 'Search for cats' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'call_search', type: 'function', function: { name: 'web_search', arguments: '{"query":"cats"}' } },
        { id: 'call_other', type: 'function', function: { name: 'lookup', arguments: '{}' } }
      ] },
      { role: 'tool', tool_call_id: 'call_search', content: 'Search results' },
      { role: 'tool', tool_call_id: 'call_other', content: 'Other results' }
    ]
    const original = structuredClone(messages)
    const request = buildOpenAIResponsesRequest({ model: 'gpt-test', key: 'k' }, messages)

    expect(request.body.input).toEqual([
      messages[0],
      { type: 'function_call', call_id: 'call_search', name: 'web_search', arguments: '{"query":"cats"}' },
      { type: 'function_call', call_id: 'call_other', name: 'lookup', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_search', output: 'Search results' },
      { type: 'function_call_output', call_id: 'call_other', output: 'Other results' }
    ])
    expect(messages).toEqual(original)
  })

  it.each([null, undefined])('normalizes missing historical message content (%s) without changing source data', content => {
    const messages = [
      { role: 'user', content },
      { role: 'assistant', content },
      { role: 'assistant', content, tool_calls: [] },
      { role: 'developer', content }
    ]
    const original = structuredClone(messages)
    const request = buildOpenAIResponsesRequest({ model: 'gpt-test', key: 'k' }, messages)
    expect(request.body.input).toEqual(messages.map(message => ({ role: message.role, content: '' })))
    expect(messages).toEqual(original)
  })

  it('normalizes native null content while keeping message IDs and matching tool call records', () => {
    const messages = [
      { type: 'message', id: 'msg_empty', role: 'assistant', status: 'completed', content: null },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'Results' }
    ]
    const original = structuredClone(messages)
    const request = buildOpenAIResponsesRequest({ model: 'gpt-test', key: 'k' }, messages)
    expect(request.body.input).toEqual([{ ...messages[0], content: '' }, ...messages.slice(1)])
    expect(messages).toEqual(original)
  })

  it('omits null entries inside content arrays while retaining text and images', () => {
    const request = buildOpenAIResponsesRequest({ model: 'gpt-test', key: 'k' }, [{ role: 'user', content: [
      null, 'Look', undefined, { type: 'image_url', image_url: { url: 'https://img.test/a.png' } }
    ] }])
    expect(request.body.input[0].content).toEqual([
      { type: 'input_text', text: 'Look' }, { type: 'input_image', image_url: 'https://img.test/a.png', detail: 'auto' }
    ])
  })

  it('preserves native output items and assistant text in tool follow-up context', () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted' },
      { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Searching', annotations: [] }] },
      { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'Results' }
    ]
    const request = buildOpenAIResponsesRequest({ model: 'gpt-test', key: 'k' }, output)
    expect(request.body.input).toEqual(output)

    const fallbackRequest = buildOpenAIResponsesRequest({ model: 'gpt-test', key: 'k' }, [
      { role: 'assistant', content: 'Searching', tool_calls: [
        { id: 'call_1', function: { name: 'web_search', arguments: '{}' } }
      ] }
    ])
    expect(fallbackRequest.body.input).toEqual([
      { role: 'assistant', content: 'Searching' },
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{}' }
    ])
  })

  it('converts image-only messages with remote and base64 URLs', () => {
    const imageUrls = ['https://img.test/photo.png', 'data:image/png;base64,abc']
    const messages = imageUrls.map(url => ({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url } }]
    }))
    const originalMessages = structuredClone(messages)

    const request = buildOpenAIResponsesRequest({ model: 'gpt-4o', key: 'k' }, messages)

    expect(request.body.input).toEqual(imageUrls.map(image_url => ({
      role: 'user',
      content: [{ type: 'input_image', image_url, detail: 'auto' }]
    })))
    expect(messages).toEqual(originalMessages)
  })

  it('converts captions and multiple images in user and assistant history', () => {
    const request = buildOpenAIResponsesRequest({ model: 'gpt-4o', key: 'k' }, [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '[Alice]: previous image' },
          { type: 'image_url', image_url: { url: 'https://img.test/previous.png', detail: 'low' } }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Compare these images' },
          { type: 'image_url', image_url: { url: 'https://img.test/first.png', detail: 'high' } },
          { type: 'image_url', image_url: { url: 'https://img.test/second.png' } }
        ]
      }
    ])

    expect(request.body.input).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'input_text', text: '[Alice]: previous image' },
          { type: 'input_image', image_url: 'https://img.test/previous.png', detail: 'low' }
        ]
      },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Compare these images' },
          { type: 'input_image', image_url: 'https://img.test/first.png', detail: 'high' },
          { type: 'input_image', image_url: 'https://img.test/second.png', detail: 'auto' }
        ]
      }
    ])
  })

  it('preserves native Responses content blocks', () => {
    const messages = [
      { role: 'developer', content: [{ type: 'input_text', text: 'Describe the image' }] },
      { role: 'user', content: [{ type: 'input_image', file_id: 'file_1', detail: 'auto' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'A photo', annotations: [] }] }
    ]

    const request = buildOpenAIResponsesRequest({ model: 'gpt-4o', key: 'k' }, messages)

    expect(request.body.input).toEqual(messages)
  })

  it('includes reasoning effort when configured', () => {
    const request = buildOpenAIResponsesRequest({
      model: 'o1', key: 'k', reasoningEffort: 'high'
    }, [{ role: 'user', content: 'Think' }])

    expect(request.body.reasoning).toEqual({ effort: 'high' })
  })

  it('streams text deltas from response.output_text.delta events', async () => {
    const chunks = []
    const response = createSSEResponse([
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: 'Hello' } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: ' world' } },
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } } }
    ])

    const result = await consumeOpenAIResponsesStream(response, delta => chunks.push(delta))

    expect(chunks).toEqual(['Hello', ' world'])
    expect(result.emittedChars).toBe(11)
    expect(result.emittedEvents).toBe(2)
    expect(result.finishReason).toBe('stop')
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 })
  })

  it('captures reasoning summary deltas separately from visible text', async () => {
    const chunks = []
    const onReasoningDelta = vi.fn()
    const response = createSSEResponse([
      { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', delta: '先选择天气工具' } },
      { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta: '查询完成' } },
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed' } } }
    ])

    const result = await consumeOpenAIResponsesStream(response, delta => chunks.push(delta), { onReasoningDelta })

    expect(chunks).toEqual(['查询完成'])
    expect(onReasoningDelta).toHaveBeenLastCalledWith('先选择天气工具')
    expect(result.reasoningContent).toBe('先选择天气工具')
  })

  it('accumulates tool calls from streaming events', async () => {
    const response = createSSEResponse([
      { event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'get_weather' } } },
      { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'call_1', delta: '{"loc' } },
      { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'call_1', delta: 'ation":"NYC"}' } },
      { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed' } } }
    ])

    const result = await consumeOpenAIResponsesStream(response, () => {})

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].function.name).toBe('get_weather')
    expect(result.toolCalls[0].function.arguments).toBe('{"location":"NYC"}')
  })

  it('keeps call_id distinct from item_id and replays native context on search follow-up', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'encrypted' }
    const call = { type: 'function_call', id: 'fc_search', call_id: 'call_search', name: 'web_search', arguments: '{"query":"cats"}', status: 'completed' }
    const response = createSSEResponse([
      { data: { type: 'response.output_item.added', output_index: 0, item: reasoning } },
      { data: { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '', status: 'in_progress' } } },
      { data: { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_search', delta: '{"query":' } },
      { data: { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_search', delta: '"cats"}' } },
      { data: { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_search', arguments: call.arguments } },
      { data: { type: 'response.output_item.done', output_index: 1, item: call } },
      { data: { type: 'response.completed', response: { status: 'completed', output: [reasoning, call] } } }
    ])
    const result = await consumeOpenAIResponsesStream(response, () => {})

    expect(result.toolCalls).toEqual([
      { id: 'call_search', type: 'function', function: { name: 'web_search', arguments: call.arguments } }
    ])
    expect(result.responsesOutput).toEqual([reasoning, call])
    const followUp = buildOpenAIResponsesRequest({ model: 'gpt-test', key: 'k' }, [
      { role: 'user', content: 'Search for cats' },
      ...result.responsesOutput,
      { role: 'tool', tool_call_id: result.toolCalls[0].id, content: 'Search results' }
    ])
    expect(followUp.body.input.slice(1)).toEqual([
      reasoning, call, { type: 'function_call_output', call_id: 'call_search', output: 'Search results' }
    ])
  })

  it('uses final arguments without duplication for interleaved parallel tool calls', async () => {
    const response = createSSEResponse([
      { data: { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_a', call_id: 'call_a', name: 'web_search', arguments: '' } } },
      { data: { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_b', call_id: 'call_b', name: 'lookup', arguments: '' } } },
      { data: { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_b', delta: '{"id":' } },
      { data: { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_a', delta: '{"query":' } },
      { data: { type: 'response.function_call_arguments.done', output_index: 0, item_id: 'fc_a', arguments: '{"query":"cats"}' } },
      { data: { type: 'response.function_call_arguments.done', output_index: 1, item_id: 'fc_b', arguments: '{"id":1}' } }
    ])
    const result = await consumeOpenAIResponsesStream(response, () => {})
    expect(result.toolCalls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'web_search', arguments: '{"query":"cats"}' } },
      { id: 'call_b', type: 'function', function: { name: 'lookup', arguments: '{"id":1}' } }
    ])
  })

  it('recovers tool calls when a relay sends only completed output items', async () => {
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{}' }
    for (const data of [
      { type: 'response.output_item.done', output_index: 0, item: call },
      { type: 'response.completed', response: { status: 'completed', output: [call] } }
    ]) {
      const result = await consumeOpenAIResponsesStream(createSSEResponse([{ data }]), () => {})
      expect(result.toolCalls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{}' } }])
      expect(result.responsesOutput).toEqual([call])
    }
  })

  it('extracts non-stream text from output_text field', () => {
    expect(extractOpenAIResponsesNonStreamText({
      output_text: 'Hello world'
    })).toBe('Hello world')

    expect(extractOpenAIResponsesNonStreamText({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'hello' }]
      }]
    })).toBe('hello')
  })

  it.each([
    { type: 'error', message: 'upstream rejected the request' },
    { type: 'response.failed', response: { status: 'failed', error: { message: 'upstream rejected the request' } } }
  ])('propagates $type instead of treating it as an empty reply', async data => {
    const response = createSSEResponse([{ data }])
    await expect(consumeOpenAIResponsesStream(response, () => {})).rejects.toThrow('upstream rejected the request')
    expect(response.body.locked).toBe(false)
  })

  it('ignores malformed frames but preserves callback errors', async () => {
    const response = new Response('data: invalid json\n\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n')
    const onDelta = vi.fn(() => { throw new Error('callback failed') })
    await expect(consumeOpenAIResponsesStream(response, onDelta)).rejects.toThrow('callback failed')
    expect(onDelta).toHaveBeenCalledWith('ok')
  })

  it('keeps truncated text and usage without executing incomplete tool calls', async () => {
    const output = [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Partial answer' }] },
      { type: 'function_call', call_id: 'call_1', name: 'web_search', arguments: '{', status: 'incomplete' }
    ]
    const chunks = []
    const result = await consumeOpenAIResponsesStream(createSSEResponse([
      { data: { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output, usage: { input_tokens: 10, output_tokens: 20 } } } }
    ]), delta => chunks.push(delta))
    expect(chunks.join('')).toBe('Partial answer')
    expect(result).toMatchObject({ finishReason: 'length', toolCalls: [], usage: { input_tokens: 10, output_tokens: 20 } })
  })

  it('reports an exhausted output limit when reasoning leaves no visible reply', async () => {
    const payload = { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] }
    await expect(consumeOpenAIResponsesStream(createSSEResponse([{ data: { type: 'response.incomplete', response: payload } }]), () => {})).rejects.toThrow('请提高输出上限')
    expect(() => extractOpenAIResponsesNonStreamText(payload)).toThrow('请提高输出上限')
  })

  it('preserves content-filter termination', async () => {
    const result = await consumeOpenAIResponsesStream(createSSEResponse([
      { data: { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [] } } }
    ]), () => {})
    expect(result).toMatchObject({ finishReason: 'content_filter', emittedChars: 0, toolCalls: [] })
  })

  it('emits final text snapshots once per content part', async () => {
    const chunks = []
    const output = [{ type: 'message', role: 'assistant', content: [
      { type: 'output_text', text: 'Hello world' }, { type: 'output_text', text: '!' }
    ] }]
    await consumeOpenAIResponsesStream(createSSEResponse([
      { data: { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Hello' } },
      { data: { type: 'response.output_text.done', output_index: 0, content_index: 0, text: 'Hello world' } },
      { data: { type: 'response.output_item.done', output_index: 0, item: output[0] } },
      { data: { type: 'response.completed', response: { status: 'completed', output } } }
    ]), delta => chunks.push(delta))
    expect(chunks.join('')).toBe('Hello world!')
  })

  it('displays refusal text from streams and non-stream responses', async () => {
    const payload = { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Cannot help' }] }] }
    const chunks = []
    await consumeOpenAIResponsesStream(createSSEResponse([
      { data: { type: 'response.refusal.delta', delta: 'Cannot ' } },
      { data: { type: 'response.refusal.done', refusal: 'Cannot help' } },
      { data: { type: 'response.completed', response: payload } }
    ]), delta => chunks.push(delta))
    expect(chunks.join('')).toBe('Cannot help')
    expect(extractOpenAIResponsesNonStreamText(payload)).toBe('Cannot help')
  })

  it('recovers native JSON text and tool calls when a relay ignores stream mode', async () => {
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'web_search', arguments: '{}' }
    const payload = { status: 'completed', output: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Searching' }] }, call
    ], usage: { input_tokens: 3, output_tokens: 4 } }
    const chunks = []
    const result = await consumeOpenAIResponsesStream(new Response(JSON.stringify(payload)), delta => chunks.push(delta))
    expect(chunks.join('')).toBe('Searching')
    expect(result).toMatchObject({ usedFallback: true, finishReason: 'stop', usage: payload.usage, toolCalls: [{ id: 'call_1' }], responsesOutput: payload.output })
  })

  it('propagates failures in HTTP 200 JSON bodies', async () => {
    const payload = { status: 'failed', error: { message: 'generation failed' } }
    await expect(consumeOpenAIResponsesStream(new Response(JSON.stringify(payload)), () => {})).rejects.toThrow('generation failed')
    expect(() => extractOpenAIResponsesNonStreamText(payload)).toThrow('generation failed')
  })

  it('decodes split UTF-8 chunks and a final event without a trailing newline', async () => {
    const encoded = new TextEncoder().encode('event: response.output_text.delta\r\ndata: {"delta":"中文🙂"}')
    const response = new Response(new ReadableStream({ start(controller) {
      for (let index = 0; index < encoded.length; index += 3) controller.enqueue(encoded.slice(index, index + 3))
      controller.close()
    } }))
    const chunks = []
    const result = await consumeOpenAIResponsesStream(response, delta => chunks.push(delta))
    expect(chunks.join('')).toBe('中文🙂')
    expect(result.emittedChars).toBe(4)
  })
})
