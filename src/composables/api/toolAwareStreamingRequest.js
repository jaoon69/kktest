/**
 * Tool-aware streaming request executor.
 *
 * Wraps the standard streaming request pattern and adds:
 *  1. Tool definitions injected into the payload
 *  2. Tool-call accumulation during streaming
 *  3. Multi-turn loop: execute tools → send results → stream final response
 */

import {
  buildProviderChatPayload,
  consumeProviderChatStream,
  fetchProviderChat,
  readProviderChatError,
  summarizeProviderRequestPayload
} from './providerRequest'
import { estimatePromptBreakdownFromMessages, estimateUsageFromMessages, recordUsage } from './usage'
import { appendAssistantReasoning, createAssistantMessage, setAssistantReasoning } from './assistantMessageLifecycle'
import { createStreamValueBatcher } from './responseHelpers'
import { executeToolCalls } from './tools/toolCallExecutor'
import { addDebugLog } from '../useDebugLog'

/**
 * Execute a streamed assistant request with tool-calling support.
 *
 * When the model responds with tool_calls instead of (or alongside) text,
 * this function:
 *   1. Streams text content normally to the chat bubble
 *   2. Accumulates tool_calls
 *   3. Executes tool calls silently
 *   4. Appends tool results to conversation and tool logs to the assistant message
 *   5. Re-calls the API for a follow-up response (up to maxRounds)
 *
 * @param {object} options
 * @param {object} options.cfg - API config (url, key, model, etc.)
 * @param {Array} options.messages - Conversation messages
 * @param {object} options.activeChat - Active chat contact
 * @param {Function} options.makeMsgId - ID generator
 * @param {string} options.traceId
 * @param {Function} options.onChunk - Chunk callback for UI
 * @param {Function} options.createStreamChunkBatcher - Batcher factory
 * @param {object} [options.assistantMessage] - Extra fields for assistant message
 * @param {Function} [options.setTyping]
 * @param {Function} [options.setThinking]
 * @param {Array} options.tools - OpenAI-format tools array
 * @param {object} options.toolContext - Context object passed to tool executors
 * @param {number} [options.maxToolRounds=3] - Max tool-call rounds
 * @param {Map} [options.externalExecutors] - MCP/external tool executors
 */
export async function executeToolAwareStreamedRequest({
  cfg,
  messages,
  activeChat,
  makeMsgId,
  traceId,
  onChunk,
  createStreamChunkBatcher,
  assistantMessage = {},
  setTyping,
  setThinking,
  tools,
  toolContext,
  maxToolRounds = 3,
  externalExecutors = null
}) {
  let currentMessages = [...messages]
  let toolRoundCount = 0
  let assistantStreamMsg = null
  let finalStreamMsg = null
  let finalStreamInfo = null
  let finalUrl = ''
  let createdMsgId = null
  const roundUsages = []

  while (true) {
    const enableTools = toolRoundCount < maxToolRounds
    const payloadOptions = {
      tools,
      tool_choice: enableTools ? undefined : 'none'
    }

    const payload = buildProviderChatPayload(cfg, currentMessages, payloadOptions)
    const payloadBody = summarizeProviderRequestPayload(payload)
    addDebugLog({
      level: 'info',
      scope: 'api.chat',
      message: toolRoundCount === 0 ? '发送聊天请求' : '发送工具续轮请求',
      details: {
        traceId,
        round: toolRoundCount + 1,
        model: cfg?.model || '',
        baseUrl: cfg?.url || '',
        messageCount: currentMessages.length,
        apiFormat: cfg?.apiFormat || 'openai-compatible',
        toolsCount: Array.isArray(payloadBody?.tools) ? payloadBody.tools.length : 0,
        maxTokens: payloadBody?.max_tokens ?? payloadBody?.generationConfig?.maxOutputTokens ?? null,
        temperature: payloadBody?.temperature ?? payloadBody?.generationConfig?.temperature ?? null,
        reasoningEffort: payloadBody?.reasoning_effort || ''
      }
    })
    const { request, response: res } = await fetchProviderChat(cfg, payload)
    const url = request.targetUrl
    if (!finalUrl) finalUrl = url

    if (typeof setTyping === 'function') setTyping(false)
    if (typeof setThinking === 'function') setThinking(true)

    if (!res.ok) {
      throw new Error(await readProviderChatError(cfg, res))
    }

    // Create assistant message in chat (only on first round)
    if (createdMsgId == null) {
      const newMsg = createAssistantMessage(makeMsgId, traceId, assistantMessage)
      activeChat.msgs.push(newMsg)
      createdMsgId = newMsg.id
      assistantStreamMsg = newMsg
    }

    finalStreamMsg = assistantStreamMsg || activeChat.msgs[activeChat.msgs.length - 1]
    const streamBatcher = createStreamChunkBatcher(finalStreamMsg, onChunk, activeChat)
    const currentRound = toolRoundCount + 1
    const reasoningBatcher = createStreamValueBatcher(content => {
      if (!setAssistantReasoning(finalStreamMsg, content, currentRound)) return
      finalStreamMsg.reasoningStreaming = true
      finalStreamMsg.reasoningStreamingRound = currentRound
      onChunk?.(finalStreamMsg.displayContent != null ? finalStreamMsg.displayContent : finalStreamMsg.content)
    })

    let firstDeltaReceived = false
    const streamInfo = await consumeProviderChatStream(cfg, res, (delta) => {
        if (!firstDeltaReceived) {
          firstDeltaReceived = true
          if (typeof setThinking === 'function') setThinking(false)
        }
        streamBatcher.push(delta)
    }, {
      toolAware: true,
      onReasoningDelta(content) {
        reasoningBatcher.push(content)
      }
    })

    streamBatcher.flushNow()
    reasoningBatcher.flushNow()
    finalStreamInfo = streamInfo
    if (streamInfo?.usage) roundUsages.push(streamInfo.usage)
    appendAssistantReasoning(finalStreamMsg, streamInfo?.reasoningContent, currentRound)
    finalStreamMsg.reasoningStreaming = false
    delete finalStreamMsg.reasoningStreamingRound

    if (Number(streamInfo?.filteredReasoningChars || 0) > 0) {
      addDebugLog({
        level: 'info',
        scope: 'api.reasoning',
        message: '已清洗模型推理内容',
        details: {
          traceId,
          round: toolRoundCount + 1,
          model: cfg?.model || '',
          filteredChars: streamInfo.filteredReasoningChars
        }
      })
    }

    // If model returned tool_calls, execute them and loop
    if (enableTools && streamInfo.toolCalls && streamInfo.toolCalls.length > 0) {
      addDebugLog({
        level: 'info',
        scope: 'api.tools',
        message: '模型请求调用工具',
        details: {
          traceId,
          round: toolRoundCount + 1,
          toolCalls: streamInfo.toolCalls.map(call => ({
            id: call?.id,
            type: call?.type,
            name: call?.function?.name
          }))
        }
      })
      // Append assistant message with tool_calls to conversation
      const assistantToolMessage = {
        role: 'assistant',
        content: finalStreamMsg.content || null,
        tool_calls: streamInfo.toolCalls
      }
      const reasoningContent = String(streamInfo?.reasoningContent || '').trim()
      if (reasoningContent) {
        assistantToolMessage.reasoning_content = reasoningContent
      }
      // Responses needs the original output items, including reasoning and call IDs.
      if (Array.isArray(streamInfo.responsesOutput) && streamInfo.responsesOutput.length > 0) {
        currentMessages.push(...streamInfo.responsesOutput)
      } else {
        currentMessages.push(streamInfo.nativeAssistantMessage || assistantToolMessage)
      }

      // Execute tools
      const { messages: toolResults, logs: toolLogs } = await executeToolCalls(
        streamInfo.toolCalls,
        toolContext,
        externalExecutors
      )

      appendToolLogs(finalStreamMsg, toolLogs, toolRoundCount + 1)

      // Inject tool result tokens back into assistant message content for display pipeline
      injectToolResultTokens(finalStreamMsg, streamInfo.toolCalls, toolResults)

      // Append tool results to conversation
      for (const result of toolResults) {
        currentMessages.push(result)
      }

      toolRoundCount++
      continue
    }

    // No tool calls or max rounds reached — we're done
    break
  }

  // Record usage
  const estimatedUsage = estimateUsageFromMessages(currentMessages, finalStreamMsg?.content, cfg.model)
  const promptBreakdown = estimatePromptBreakdownFromMessages(currentMessages, cfg.model)
  recordUsage(activeChat, finalStreamInfo, estimatedUsage, cfg.model, { promptBreakdown, roundUsages })

  addDebugLog({
    level: 'info',
    scope: 'api.chat',
    message: '聊天响应完成',
    details: {
      traceId,
      model: cfg?.model || '',
      url: finalUrl,
      finishReason: finalStreamInfo?.finishReason || '',
      emittedChars: finalStreamInfo?.emittedChars ?? null,
      toolRounds: toolRoundCount
    }
  })

  return {
    url: finalUrl,
    streamInfo: finalStreamInfo,
    streamMsg: finalStreamMsg,
    createdMsgId
  }
}

function appendToolLogs(streamMsg, logs, round) {
  if (!streamMsg || !Array.isArray(logs) || logs.length === 0) return

  if (!Array.isArray(streamMsg.toolLogs)) {
    streamMsg.toolLogs = []
  }

  logs.forEach((log, index) => {
    streamMsg.toolLogs.push({
      ...log,
      round,
      indexInRound: index
    })
  })
}

/**
 * Inject special tokens from tool results into the assistant message content
 * so the existing post-processing pipeline can handle them (e.g. image generation,
 * sticker display).
 */
function injectToolResultTokens(streamMsg, toolCalls, toolResults) {
  const tokensToInject = []

  for (const result of toolResults) {
    let parsed
    try {
      parsed = JSON.parse(result.content)
    } catch {
      continue
    }
    if (!parsed?.success) continue

    // Image generation returns a token for the existing pipeline
    if (parsed.result?.imageToken) {
      tokensToInject.push(parsed.result.imageToken)
    }
    // Sticker returns a token for the existing pipeline
    if (parsed.result?.stickerToken) {
      tokensToInject.push(parsed.result.stickerToken)
    }
  }

  if (tokensToInject.length > 0) {
    const suffix = '\n' + tokensToInject.join('\n')
    streamMsg.content = (streamMsg.content || '') + suffix
  }
}
