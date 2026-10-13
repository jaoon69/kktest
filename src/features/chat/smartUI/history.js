import { parseMessageContent } from '../composables/messageParser/contentParts'
import { extractSmartUIText, hasSmartUIMarkup, replaceRootStateAttr, splitSmartUISegments } from './markup'
import { readSavedSmartUIState, stateToLiteral } from './state'

/** 历史里保留完整标记的最近界面数量；更早的界面压缩成摘要以节省 token。 */
export const SMART_UI_FULL_HISTORY_LIMIT = 2

function listUIPartIndexes(content) {
  const parts = parseMessageContent(content, true)
  const indexes = []
  parts.forEach((part, index) => {
    if (part?.type === 'ui') indexes.push(index)
  })
  return indexes
}

/**
 * 把一条消息里的 <ui> 改写成发给模型的形态。
 * keepFull=true：保留完整标记，并把根 state 替换成用户当前操作后的状态；
 * keepFull=false：压缩为 <ui-archived>摘要</ui-archived>。
 */
export function rewriteSmartUIContentForModel(message, content, keepFull) {
  if (typeof content !== 'string' || !hasSmartUIMarkup(content)) return content
  const text = content
  // uiStates 的 partIndex 以展示内容为准（与 buildBlocks 一致）
  const displayText = typeof message?.displayContent === 'string' ? message.displayContent : text
  const partIndexes = listUIPartIndexes(displayText)
  let uiOrdinal = 0
  return splitSmartUISegments(text).map((segment) => {
    if (segment.type !== 'ui') return segment.content
    const partIndex = partIndexes[uiOrdinal]
    uiOrdinal += 1
    if (!keepFull) {
      const summary = extractSmartUIText(segment.content, 140)
      return `<ui-archived>${summary || '互动界面'}</ui-archived>`
    }
    const saved = readSavedSmartUIState(message, partIndex)
    return saved ? replaceRootStateAttr(segment.content, stateToLiteral(saved)) : segment.content
  }).join('')
}

/**
 * 对整段上下文做智能界面压缩：从后往前数，最近 N 条含界面的消息保留完整标记。
 * @param {Array<{ content?: any }>} messages
 * @returns {Set<any>} 需要保留完整标记的消息集合
 */
export function pickFullSmartUIMessages(messages, limit = SMART_UI_FULL_HISTORY_LIMIT) {
  const keep = new Set()
  for (let i = messages.length - 1; i >= 0 && keep.size < limit; i -= 1) {
    const message = messages[i]
    if (typeof message?.content === 'string' && hasSmartUIMarkup(message.content)) keep.add(message)
  }
  return keep
}
