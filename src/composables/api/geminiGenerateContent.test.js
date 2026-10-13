import { describe, expect, it, vi } from 'vitest'

import {
  buildGeminiGenerateContentRequest,
  consumeGeminiGenerateContentStream,
  extractGeminiNonStreamText,
  normalizeGeminiToolResultMessage,
  readGeminiGenerateContentError,
  resolveGeminiGenerateContentUrl,
  sanitizeGeminiBody
} from './geminiGenerateContent'

function createTextResponse(text, init = {}) {
  return new Response(text, init)
}

describe('geminiGenerateContent adapter', () => {
  it('resolves base URLs using the configured model', () => {
    expect(resolveGeminiGenerateContentUrl('https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-flash')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent'
    )
    expect(resolveGeminiGenerateContentUrl('https://proxy.test/v1beta/models/gemini-pro:streamGenerateContent', 'ignored')).toBe(
      'https://proxy.test/v1beta/models/gemini-pro:streamGenerateContent'
    )
  })

  it('builds Gemini headers and converts normalized chat messages', () => {
    const request = buildGeminiGenerateContentRequest({
      url: 'https://generativelanguage.googleapis.com/v1beta',
      key: 'test-key',
      model: 'gemini-2.5-flash',
      temperature: 0.3,
      maxTokens: 4096
    }, [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'system', content: 'Reply in Chinese.' }
    ])

    expect(request.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent')
    expect(request.headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-goog-api-key': 'test-key'
    })
    expect(request.body).toEqual({
      systemInstruction: {
        parts: [
          { text: 'You are concise.' },
          { text: 'Reply in Chinese.' }
        ]
      },
      contents: [
        { role: 'user', parts: [{ text: 'Hi' }] },
        { role: 'model', parts: [{ text: 'Hello' }] }
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 4096
      }
    })
  })

  it('consumes Gemini SSE chunks and usage metadata', async () => {
    const response = createTextResponse([
      'data: {"candidates":[{"content":{"parts":[{"text":"你"}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"text":"好"}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":8}}',
      ''
    ].join('\n'))

    const chunks = []
    const result = await consumeGeminiGenerateContentStream(response, delta => chunks.push(delta))

    expect(chunks).toEqual(['你', '好'])
    expect(result).toMatchObject({
      emittedChars: 2,
      emittedEvents: 2,
      finishReason: 'STOP',
      usage: { totalTokenCount: 8 }
    })
  })

  it('maps OpenAI-style tools and parses Gemini function calls', async () => {
    const request = buildGeminiGenerateContentRequest({
      url: 'https://generativelanguage.googleapis.com/v1beta',
      key: 'gemini-key',
      model: 'gemini-flash'
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
        functionDeclarations: [
          {
            name: 'write_diary',
            description: '写日记',
            parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] }
          }
        ]
      }
    ])

    const response = createTextResponse([
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"write_diary","args":{"content":"今天很好"}}}]},"finishReason":"STOP"}]}',
      ''
    ].join('\n'))

    const result = await consumeGeminiGenerateContentStream(response, () => {})
    expect(result.toolCalls).toEqual([
      {
        id: 'gemini_call_0',
        type: 'function',
        function: {
          name: 'write_diary',
          arguments: '{"content":"今天很好"}'
        }
      }
    ])
  })

  it('keeps Gemini thought parts out of visible text and returns them separately', async () => {
    const response = createTextResponse([
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"先分析查询条件"},{"text":"查询完成"}]},"finishReason":"STOP"}]}',
      ''
    ].join('\n'))
    const chunks = []
    const onReasoningDelta = vi.fn()

    const result = await consumeGeminiGenerateContentStream(response, delta => chunks.push(delta), { onReasoningDelta })

    expect(chunks).toEqual(['查询完成'])
    expect(onReasoningDelta).toHaveBeenLastCalledWith('先分析查询条件')
    expect(result.reasoningContent).toBe('先分析查询条件')
  })

  it('maps existing tool result messages into Gemini functionResponse parts', () => {
    expect(normalizeGeminiToolResultMessage({
      role: 'tool',
      tool_call_id: 'gemini_call_0',
      name: 'write_diary',
      content: '{"success":true}'
    })).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'write_diary',
            response: { success: true }
          }
        }
      ]
    })
  })

  it('maps assistant tool_calls into Gemini functionCall parts for follow-up rounds', () => {
    const request = buildGeminiGenerateContentRequest({
      url: 'https://generativelanguage.googleapis.com/v1beta',
      key: 'gemini-key',
      model: 'gemini-flash'
    }, [
      { role: 'user', content: '记一下' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'gemini_call_0',
            type: 'function',
            function: {
              name: 'write_diary',
              arguments: '{"content":"今天很好"}'
            }
          }
        ]
      },
      { role: 'tool', tool_call_id: 'gemini_call_0', name: 'write_diary', content: '{"success":true}' }
    ])

    expect(request.body.contents).toEqual([
      { role: 'user', parts: [{ text: '记一下' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'write_diary',
              args: { content: '今天很好' }
            }
          }
        ]
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'write_diary',
              response: { success: true }
            }
          }
        ]
      }
    ])
  })

  it('extracts text from Gemini non-stream responses and JSON arrays', () => {
    expect(extractGeminiNonStreamText({
      candidates: [{ content: { parts: [{ text: 'hello' }, { text: ' world' }] } }]
    })).toBe('hello world')

    expect(extractGeminiNonStreamText([
      { candidates: [{ content: { parts: [{ text: 'a' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'b' }] } }] }
    ])).toBe('ab')
  })

  it('reads Gemini error messages from JSON or text responses', async () => {
    await expect(readGeminiGenerateContentError(createTextResponse('{"error":{"message":"bad key"}}'))).resolves.toBe('bad key')
    await expect(readGeminiGenerateContentError(createTextResponse('plain failure', { status: 500 }))).resolves.toBe('plain failure')
  })

  it('strips OpenAI-only parameters from body', () => {
    const body = sanitizeGeminiBody({
      contents: [],
      generationConfig: { temperature: 0.5 },
      stream_options: { include_usage: true },
      reasoning_effort: 'high',
      logprobs: true,
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
      seed: 42
    })
    expect(body.contents).toEqual([])
    expect(body.generationConfig.temperature).toBe(0.5)
    expect(body).not.toHaveProperty('stream_options')
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('logprobs')
    expect(body).not.toHaveProperty('frequency_penalty')
    expect(body).not.toHaveProperty('presence_penalty')
    expect(body).not.toHaveProperty('seed')
  })

  it('moves top-level temperature/maxOutputTokens into generationConfig', () => {
    const body = sanitizeGeminiBody({
      contents: [],
      temperature: 0.8,
      maxOutputTokens: 2048
    })
    expect(body.generationConfig.temperature).toBe(0.8)
    expect(body.generationConfig.maxOutputTokens).toBe(2048)
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('maxOutputTokens')
  })

  it('drops empty text parts and empty messages instead of sending blank parts', () => {
    const request = buildGeminiGenerateContentRequest({
      url: 'https://generativelanguage.googleapis.com/v1beta',
      key: 'k',
      model: 'gemini-flash'
    }, [
      { role: 'assistant', content: '' },
      { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: 'Hi' }] }
    ])

    expect(request.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hi' }] }
    ])
  })

  it('merges consecutive same-role messages into one content entry', () => {
    const request = buildGeminiGenerateContentRequest({
      url: 'https://generativelanguage.googleapis.com/v1beta',
      key: 'k',
      model: 'gemini-flash'
    }, [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: '回复1' },
      { role: 'assistant', content: '回复2' },
      { role: 'user', content: 'B' }
    ])

    expect(request.body.contents).toEqual([
      { role: 'user', parts: [{ text: 'A' }] },
      { role: 'model', parts: [{ text: '回复1' }, { text: '回复2' }] },
      { role: 'user', parts: [{ text: 'B' }] }
    ])
  })

  it('falls back to a placeholder user content when everything is filtered out', () => {
    const request = buildGeminiGenerateContentRequest({
      url: 'https://generativelanguage.googleapis.com/v1beta',
      key: 'k',
      model: 'gemini-flash'
    }, [
      { role: 'user', content: '' }
    ])

    expect(request.body.contents).toHaveLength(1)
    expect(request.body.contents[0].role).toBe('user')
    expect(request.body.contents[0].parts.length).toBeGreaterThan(0)
  })
})
