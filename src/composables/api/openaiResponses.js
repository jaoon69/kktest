import { resolveOptionalMaxTokens, parseOptionalTemperature, normalizeReasoningEffort } from './chatCompletions'
import { buildOpenAICompatHeaders } from './openaiCompat'
import { stripInvisibleFormatChars } from '../../utils/httpHeaders'

export function resolveOpenAIResponsesUrl(baseUrl) {
  const raw = stripInvisibleFormatChars(baseUrl).trim()
  const suffixIndex = raw.search(/[?#]/)
  const suffix = suffixIndex < 0 ? '' : raw.slice(suffixIndex)
  const base = (suffixIndex < 0 ? raw : raw.slice(0, suffixIndex)).replace(/\/+$/, '')
  if (!base) return '/v1/responses' + suffix
  if (/\/responses$/i.test(base)) return base + suffix
  if (/\/chat\/completions$/i.test(base)) return base.replace(/\/chat\/completions$/i, '/responses') + suffix
  if (/\/v\d+$/i.test(base)) return base + '/responses' + suffix
  return base + '/v1/responses' + suffix
}

function extractTextFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content || '')
  return content.map(part => {
    if (typeof part === 'string') return part
    if (typeof part?.text === 'string') return part.text
    return ''
  }).join('')
}

function normalizeResponsesContent(content) {
  if (content == null) return ''
  if (!Array.isArray(content)) return content

  // Chat history uses Chat Completions parts; Responses requires its own types.
  return content.filter(part => part != null).map(part => {
    if (typeof part === 'string') return { type: 'input_text', text: part }
    if (part?.type === 'text') return { type: 'input_text', text: part.text }
    if (part?.type === 'image_url') {
      return {
        type: 'input_image',
        image_url: part.image_url?.url,
        detail: part.image_url?.detail || 'auto'
      }
    }
    return part
  })
}

function normalizeResponsesInputMessage(item) {
  if (!item || typeof item !== 'object') return item
  const role = String(item.role || '').trim()
  if (item.type === 'message' || (!item.type && ['system', 'user', 'assistant', 'developer'].includes(role))) {
    return { ...item, content: normalizeResponsesContent(item.content) }
  }
  return item
}

export function sanitizeOpenAIResponsesBody(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.input)) return body
  return { ...body, input: body.input.map(normalizeResponsesInputMessage) }
}

function splitMessagesForResponses(messages) {
  const instructionParts = []
  const input = []

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue
    if (['function_call', 'function_call_output', 'reasoning', 'message'].includes(message.type)) {
      input.push(normalizeResponsesInputMessage(message))
      continue
    }
    const role = String(message.role || '').trim()

    if (role === 'system') {
      instructionParts.push(extractTextFromContent(message.content))
      continue
    }

    if (role === 'user' || role === 'assistant' || role === 'developer') {
      const toolCalls = role === 'assistant' && Array.isArray(message.tool_calls) ? message.tool_calls : []
      const content = normalizeResponsesContent(message.content)
      if (toolCalls.length === 0 || (typeof content === 'string' && content.length > 0) || (Array.isArray(content) && content.length > 0)) {
        input.push({ role, content })
      }
      for (const call of toolCalls) {
        input.push({
          type: 'function_call',
          call_id: String(call.id || ''),
          name: String(call.function?.name || ''),
          arguments: String(call.function?.arguments || '{}')
        })
      }
      continue
    }

    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id || ''),
        output: extractTextFromContent(message.content)
      })
    }
  }

  return { instructions: instructionParts.join('\n\n').trim(), input }
}

export function buildOpenAIResponsesRequest(cfg = {}, messages = [], options = {}) {
  const split = splitMessagesForResponses(messages)
  const body = {
    model: cfg.model,
    stream: options.stream !== false
  }

  if (split.input.length > 0) body.input = split.input
  if (split.instructions) body.instructions = split.instructions

  const maxTokens = resolveOptionalMaxTokens(cfg.maxTokens, options.maxTokens, options.max_tokens)
  if (maxTokens !== null) body.max_output_tokens = maxTokens

  const temperature = parseOptionalTemperature(cfg.temperature)
  if (temperature !== null) body.temperature = temperature

  const reasoningEffort = normalizeReasoningEffort(options.reasoningEffort ?? cfg?.reasoningEffort)
  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort }
  }

  if (Array.isArray(options.tools) && options.tools.length > 0) {
    body.tools = options.tools.map(tool => {
      if (tool?.type && tool.type !== 'function') return tool
      const fn = tool?.function || tool
      return {
        type: 'function',
        name: String(fn?.name || ''),
        description: String(fn?.description || ''),
        parameters: fn?.parameters || { type: 'object', properties: {} },
        // Keep the optional fields in existing chat/MCP schemas optional.
        strict: typeof fn?.strict === 'boolean' ? fn.strict : false
      }
    })
  }

  if (options.tool_choice) {
    const choice = options.tool_choice
    body.tool_choice = choice?.type === 'function' && choice.function
      ? { type: 'function', name: choice.function.name }
      : choice
  }

  const url = resolveOpenAIResponsesUrl(cfg.url)
  const headers = buildOpenAICompatHeaders(cfg.key)

  return { url, headers, body }
}

export function extractOpenAIResponsesNonStreamText(payload) {
  if (!payload || typeof payload !== 'object') return ''
  assertResponseSucceeded(payload)
  if (typeof payload.output_text === 'string') {
    assertNonEmptyIncompleteReply(payload, payload.output_text)
    return payload.output_text
  }
  if (Array.isArray(payload.output)) {
    const text = payload.output
      .filter(item => item?.type === 'message')
      .flatMap(item => Array.isArray(item.content) ? item.content : [])
      .filter(part => part?.type === 'output_text' || part?.type === 'refusal')
      .map(part => String(part.text || part.refusal || ''))
      .join('')
    assertNonEmptyIncompleteReply(payload, text)
    return text
  }
  assertNonEmptyIncompleteReply(payload, '')
  return ''
}

function assertResponseSucceeded(payload) {
  if (payload?.error || payload?.status === 'failed' || payload?.type === 'error') {
    const detail = payload.error || payload
    throw new Error(detail.message || 'Responses 接口生成回复失败')
  }
}

function responseFinishReason(payload) {
  const reason = payload?.incomplete_details?.reason
  if (reason === 'max_output_tokens') return 'length'
  if (reason === 'content_filter') return 'content_filter'
  return payload?.status === 'completed' ? 'stop' : (payload?.status || null)
}

function assertNonEmptyIncompleteReply(payload, text) {
  if (!text && responseFinishReason(payload) === 'length') {
    throw new Error('回复达到输出上限，但尚未生成可见内容。请提高输出上限后重试。')
  }
}

function extractOpenAIResponsesReasoningText(payload) {
  const response = payload?.response || payload
  if (!response || !Array.isArray(response.output)) return ''

  return response.output
    .filter(item => item?.type === 'reasoning')
    .flatMap(item => [
      ...(Array.isArray(item.summary) ? item.summary : []),
      ...(Array.isArray(item.content) ? item.content : [])
    ])
    .map(part => String(part?.text || part?.content || ''))
    .join('')
}

export async function consumeOpenAIResponsesStream(res, onDelta, options = {}) {
  const reader = res?.body?.getReader?.()
  if (!reader) throw new Error('当前环境不支持流式读取')

  const decoder = new TextDecoder()
  let lineBuffer = ''
  let eventType = ''
  let eventLines = []
  let emittedChars = 0
  let emittedEvents = 0
  let usage = null
  let finishReason = null
  let usedFallback = false
  let rawText = ''
  let hasSSEData = false
  let terminalResponse = null
  const outputItems = new Map()
  const textParts = new Map()
  let reasoningContent = ''

  const getOutputIndex = payload => Number.isFinite(Number(payload.output_index)) ? Number(payload.output_index) : 0
  const getTextKey = (index, contentIndex = 0) => `${index}:${contentIndex}`
  const rememberOutputItem = (index, item, finalized = false) => {
    if (!item || typeof item !== 'object') return
    outputItems.set(index, { ...outputItems.get(index), ...item })
    if (finalized && item.type === 'message' && Array.isArray(item.content)) {
      item.content.forEach((part, contentIndex) => {
        if (part?.type === 'output_text' || part?.type === 'refusal') {
          emitFinalText(getTextKey(index, contentIndex), part.text || part.refusal || '')
        }
      })
    }
  }

  const emit = (text) => {
    const delta = String(text || '')
    if (!delta) return
    emittedChars += delta.length
    emittedEvents += 1
    if (typeof onDelta === 'function') onDelta(delta)
  }

  const emitFinalText = (key, text) => {
    const value = String(text || '')
    const previous = textParts.get(key) || ''
    if (value.startsWith(previous)) emit(value.slice(previous.length))
    textParts.set(key, value)
  }

  const noteResponse = (response) => {
    assertResponseSucceeded(response)
    terminalResponse = response
    if (Array.isArray(response.output)) response.output.forEach((item, index) => rememberOutputItem(index, item, true))
    if (emittedChars === 0 && typeof response.output_text === 'string') emit(response.output_text)
    const finalReasoning = extractOpenAIResponsesReasoningText(response)
    if (finalReasoning && (!reasoningContent || finalReasoning.startsWith(reasoningContent))) {
      reasoningContent = finalReasoning
      options.onReasoningDelta?.(reasoningContent)
    }
    if (response.usage && typeof response.usage === 'object') usage = response.usage
    finishReason = responseFinishReason(response)
  }

  const processEvent = () => {
    if (eventLines.length === 0) { eventType = ''; return }
    const payloadText = eventLines.join('\n').trim()
    eventLines = []
    const currentEventType = eventType
    eventType = ''
    if (!payloadText || payloadText === '[DONE]') return

    let payload
    try {
      payload = JSON.parse(payloadText)
    } catch {
      return // Ignore malformed JSON only; API and callback errors must propagate.
    }
    if (!payload || typeof payload !== 'object') return
    const type = payload.type || currentEventType

    if (type === 'error') {
      assertResponseSucceeded({ ...payload, type: 'error' })
    } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
      const delta = typeof payload.delta === 'string' ? payload.delta : ''
      const key = getTextKey(getOutputIndex(payload), payload.content_index)
      textParts.set(key, (textParts.get(key) || '') + delta)
      emit(delta)
    } else if (type === 'response.output_text.done' || type === 'response.refusal.done') {
      emitFinalText(getTextKey(getOutputIndex(payload), payload.content_index), payload.text || payload.refusal || '')
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      reasoningContent += typeof payload.delta === 'string' ? payload.delta : ''
      if (reasoningContent) options.onReasoningDelta?.(reasoningContent)
    } else if (type === 'response.function_call_arguments.delta') {
      const index = getOutputIndex(payload)
      const item = outputItems.get(index) || { type: 'function_call', id: payload.item_id }
      const argDelta = typeof payload.delta === 'string' ? payload.delta : ''
      // item_id identifies the output item (fc_*), not its tool result call_id.
      rememberOutputItem(index, {
        ...item,
        ...(payload.call_id ? { call_id: payload.call_id } : {}),
        ...(payload.name ? { name: payload.name } : {}),
        arguments: (item.arguments || '') + argDelta
      })
    } else if (type === 'response.function_call_arguments.done') {
      const index = getOutputIndex(payload)
      rememberOutputItem(index, {
        type: 'function_call',
        ...(payload.call_id ? { call_id: payload.call_id } : {}),
        ...(payload.name ? { name: payload.name } : {}),
        ...(typeof payload.arguments === 'string' ? { arguments: payload.arguments } : {})
      })
    } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      rememberOutputItem(getOutputIndex(payload), payload.item, type === 'response.output_item.done')
    } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      noteResponse(payload.response || payload)
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      if (!hasSSEData) rawText += chunk
      lineBuffer += chunk
      const lines = lineBuffer.split(/\r?\n/)
      lineBuffer = lines.pop() || ''
      for (const rawLine of lines) {
        const line = rawLine.trimEnd()
        if (line === '') {
          processEvent()
          continue
        }
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trimStart()
          continue
        }
        if (line.startsWith('data:')) {
          hasSSEData = true
          rawText = ''
          eventLines.push(line.slice(5).trimStart())
        }
      }
    }

    if (lineBuffer.trim()) {
      const line = lineBuffer.trimEnd()
      if (line.startsWith('data:')) {
        hasSSEData = true
        eventLines.push(line.slice(5).trimStart())
      }
    }
    processEvent()

    if (!hasSSEData && rawText.trim()) {
      let payload = null
      try {
        payload = JSON.parse(rawText)
      } catch {
        // Non-JSON bodies can still use the caller's non-stream recovery path.
      }
      if (payload && typeof payload === 'object') {
        noteResponse(payload)
        usedFallback = true
      }
    }
    assertNonEmptyIncompleteReply(terminalResponse, emittedChars)
  } catch (error) {
    try { await reader.cancel() } catch { /* Preserve the original error. */ }
    throw error
  } finally {
    reader.releaseLock?.()
  }

  const responsesOutput = [...outputItems.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item)
  const toolCalls = responsesOutput.filter(item => item.type === 'function_call' && item.status !== 'incomplete' && !['length', 'content_filter', 'incomplete'].includes(finishReason)).map(item => ({
    id: String(item.call_id || ''),
    type: 'function',
    function: { name: String(item.name || ''), arguments: String(item.arguments || '') }
  }))

  return {
    emittedChars,
    emittedEvents,
    usedFallback,
    usage,
    finishReason,
    filteredReasoningChars: reasoningContent.length,
    reasoningContent: reasoningContent.trim(),
    toolCalls,
    responsesOutput
  }
}

export { readOpenAICompatError as readOpenAIResponsesError } from './openaiCompat'
