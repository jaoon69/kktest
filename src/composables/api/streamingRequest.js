import {
  buildProviderChatPayload,
  buildProviderNonStreamingPayload,
  consumeProviderChatStream,
  extractProviderNonStreamText,
  extractProviderNonStreamFinishReason,
  fetchProviderChat,
  readProviderChatError,
  summarizeProviderRequestPayload
} from './providerRequest'
import { estimatePromptBreakdownFromMessages, estimateUsageFromMessages, recordUsage } from './usage'
import { appendAssistantReasoning, createAssistantMessage, setAssistantReasoning } from './assistantMessageLifecycle'
import { createStreamValueBatcher } from './responseHelpers'
import { addDebugLog } from '../useDebugLog'

function summarizeChatPayload(payload, cfg, messages, traceId) {
  const body = summarizeProviderRequestPayload(payload)
  return {
    traceId,
    model: cfg?.model || '',
    apiFormat: cfg?.apiFormat || 'openai-compatible',
    baseUrl: cfg?.url || '',
    messageCount: Array.isArray(messages) ? messages.length : 0,
    stream: body?.stream === true,
    maxTokens: body?.max_tokens ?? body?.maxOutputTokens ?? body?.generationConfig?.maxOutputTokens ?? null,
    temperature: body?.temperature ?? body?.generationConfig?.temperature ?? null,
    reasoningEffort: body?.reasoning_effort || '',
    toolsCount: Array.isArray(body?.tools) ? body.tools.length : 0
  }
}

async function recoverAssistantReplyWithoutStreaming({ cfg, payload }) {
  const { request, response } = await fetchProviderChat(cfg, buildProviderNonStreamingPayload(cfg, payload))

  if (!response.ok) {
    throw new Error(await readProviderChatError(cfg, response))
  }

  let data = null
  try {
    data = await response.json()
  } catch {
    let rawText = ''
    try {
      rawText = await response.clone().text()
    } catch {
      rawText = ''
    }
    return {
      content: String(rawText || '').trim(),
      finishReason: null,
      usage: null,
      url: request.targetUrl
    }
  }

  return {
    content: extractProviderNonStreamText(cfg, data).trim(),
    finishReason: extractProviderNonStreamFinishReason(cfg, data),
    usage: data?.usage || data?.usageMetadata || null,
    url: request.targetUrl
  }
}

export function appendInstructionMessage(messages, parts = []) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return messages
  }

  messages.push({
    role: 'system',
    content: '<instructions>\n' + parts.join('\n\n') + '\n</instructions>'
  })
  return messages
}

export async function executeStreamedAssistantRequest({
  cfg,
  messages,
  activeChat,
  makeMsgId,
  traceId,
  onChunk,
  createStreamChunkBatcher,
  assistantMessage = {},
  setTyping,
  setThinking
}) {
  const payload = buildProviderChatPayload(cfg, messages)
  addDebugLog({
    level: 'info',
    scope: 'api.chat',
    message: '发送聊天请求',
    details: summarizeChatPayload(payload, cfg, messages, traceId)
  })
  const { request, response: res } = await fetchProviderChat(cfg, payload)
  const url = request.targetUrl

  if (typeof setTyping === 'function') {
    setTyping(false)
  }
  if (typeof setThinking === 'function') {
    setThinking(true)
  }

  if (!res.ok) {
    throw new Error(await readProviderChatError(cfg, res))
  }

  const newMsg = createAssistantMessage(makeMsgId, traceId, assistantMessage)
  activeChat.msgs.push(newMsg)
  const streamMsg = activeChat.msgs[activeChat.msgs.length - 1]
  const streamBatcher = createStreamChunkBatcher(streamMsg, onChunk, activeChat)
  const reasoningBatcher = createStreamValueBatcher(content => {
    if (!setAssistantReasoning(streamMsg, content, 1)) return
    streamMsg.reasoningStreaming = true
    streamMsg.reasoningStreamingRound = 1
    onChunk?.(streamMsg.displayContent != null ? streamMsg.displayContent : streamMsg.content)
  })

  let firstDeltaReceived = false
  let streamInfo = await consumeProviderChatStream(cfg, res, delta => {
    if (!firstDeltaReceived) {
      firstDeltaReceived = true
      if (typeof setThinking === 'function') setThinking(false)
    }
    streamBatcher.push(delta)
  }, {
    onReasoningDelta(content) {
      reasoningBatcher.push(content)
    }
  })

  if (streamInfo?.emittedChars === 0 && streamInfo?.finishReason !== 'content_filter' && !String(streamMsg.content || '').trim()) {
    if (typeof setThinking === 'function') setThinking(false)
    addDebugLog({
      level: 'warn',
      scope: 'api.chat',
      message: '流式响应没有可见文本，尝试非流式恢复',
      details: { traceId, model: cfg?.model || '', url }
    })
    const fallback = await recoverAssistantReplyWithoutStreaming({
      cfg,
      payload
    })
    if (fallback.content) {
      streamBatcher.push(fallback.content)
    }
    streamInfo = {
      ...streamInfo,
      finishReason: fallback.finishReason || streamInfo?.finishReason || null,
      usage: fallback.usage || streamInfo?.usage || null,
      usedNonStreamFallback: !!fallback.content,
      fallbackUrl: fallback.url
    }
  }

  streamBatcher.flushNow()
  reasoningBatcher.flushNow()
  appendAssistantReasoning(streamMsg, streamInfo?.reasoningContent)
  streamMsg.reasoningStreaming = false
  delete streamMsg.reasoningStreamingRound

  if (Number(streamInfo?.filteredReasoningChars || 0) > 0) {
    addDebugLog({
      level: 'info',
      scope: 'api.reasoning',
      message: '已清洗模型推理内容',
      details: {
        traceId,
        model: cfg?.model || '',
        filteredChars: streamInfo.filteredReasoningChars
      }
    })
  }

  const estimatedUsage = estimateUsageFromMessages(messages, streamMsg.content, cfg.model)
  const promptBreakdown = estimatePromptBreakdownFromMessages(messages, cfg.model)
  recordUsage(activeChat, streamInfo, estimatedUsage, cfg.model, { promptBreakdown })

  addDebugLog({
    level: 'info',
    scope: 'api.chat',
    message: '聊天响应完成',
    details: {
      traceId,
      model: cfg?.model || '',
      url,
      finishReason: streamInfo?.finishReason || '',
      emittedChars: streamInfo?.emittedChars ?? null,
      usedFallback: !!streamInfo?.usedFallback || !!streamInfo?.usedNonStreamFallback
    }
  })

  return {
    url,
    streamInfo,
    streamMsg,
    createdMsgId: newMsg.id
  }
}
