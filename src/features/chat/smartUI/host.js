import { computed, inject, provide, toRaw, unref } from 'vue'
import { cloneStateData, readSavedSmartUIState } from './state'
import { createSmartUIMedia } from './media'

const SMART_UI_HOST_KEY = Symbol('smartUIHost')

/**
 * 聊天页向智能界面提供的能力：以用户身份发送、读取/持久化界面状态、媒体（生图 / 头像立绘 / 语音）。
 * @param {{ store: any, scheduleSave: () => void, send: (text: string) => Promise<boolean> | boolean, canSend: import('vue').Ref<boolean> | boolean }} options
 */
export function provideSmartUIHost({ store, scheduleSave, send, canSend }) {
  const findMessage = (msgId) => {
    const msgs = store?.activeChat?.msgs
    if (!Array.isArray(msgs) || !msgId) return null
    return msgs.find(msg => msg?.id === msgId) || msgs.find(msg => msg?.sourceMsgId === msgId) || null
  }

  const host = {
    canSend: computed(() => !!unref(canSend)),
    send: text => send(text),
    media: createSmartUIMedia({ store, scheduleSave, findMessage }),
    getState(msgId, partIndex) {
      const saved = readSavedSmartUIState(findMessage(msgId), partIndex)
      return saved ? cloneStateData(toRaw(saved)) : null
    },
    saveState(msgId, partIndex, state) {
      const message = findMessage(msgId)
      const snapshot = cloneStateData(toRaw(state))
      if (!message || !snapshot) return
      message.uiStates = { ...(message.uiStates || {}), [String(partIndex)]: snapshot }
      scheduleSave?.()
    },
    clearState(msgId, partIndex) {
      const message = findMessage(msgId)
      if (!message?.uiStates || !(String(partIndex) in message.uiStates)) return
      const next = { ...message.uiStates }
      delete next[String(partIndex)]
      message.uiStates = next
      scheduleSave?.()
    }
  }

  provide(SMART_UI_HOST_KEY, host)
  return host
}

export function useSmartUIHost() {
  return inject(SMART_UI_HOST_KEY, null)
}
