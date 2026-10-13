/**
 * 智能界面的媒体能力：调用已配置的生图服务、读取头像/立绘、播放 TTS。
 * 生成结果按消息缓存在 msg.uiAssets，重开聊天不会重复生成。
 */

import { reactive } from 'vue'
import { useImageGen } from '../../../composables/useImageGen'
import { useVoicePlayback } from '../../../composables/useVoicePlayback'
import { resolveImagePromptStyle, usesNaturalLanguageImagePrompt } from '../../../composables/imageGen/promptProfiles'
import { useCharacterResourcesStore } from '../../../stores/characterResources'
import { useSettingsStore } from '../../../stores/settings'
import { useVNStore } from '../../../stores/vn'
import { isSafeExternalUrl } from './style'

export const MAX_GENERATED_IMAGES_PER_CARD = 6
const MAX_CONCURRENT_GENERATIONS = 2

const SIZE_PRESETS = {
  square: { width: 1024, height: 1024, size: '1024x1024' },
  portrait: { width: 832, height: 1216, size: '1024x1536' },
  landscape: { width: 1216, height: 832, size: '1536x1024' },
  wide: { width: 1344, height: 768, size: '1536x1024' }
}

/** 全局的生成状态：key -> 'pending' | 'error' */
const generationStatus = reactive({})
const queue = []
let running = 0

function hashText(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

export function imageAssetKey(prompt, type, size) {
  return `img_${hashText(`${type}|${size}|${String(prompt).trim()}`)}`
}

function pump() {
  while (running < MAX_CONCURRENT_GENERATIONS && queue.length > 0) {
    const job = queue.shift()
    running += 1
    job().finally(() => {
      running -= 1
      pump()
    })
  }
}

function splitTags(text) {
  return String(text || '').split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean)
}

function extractBase64(dataUrl) {
  const text = String(dataUrl || '')
  if (!text.startsWith('data:')) return ''
  const idx = text.indexOf(',')
  return idx < 0 ? '' : text.slice(idx + 1).replace(/\s+/g, '')
}

/**
 * @param {{ store: any, scheduleSave?: () => void, findMessage: (msgId: string) => any }} options
 */
export function createSmartUIMedia({ store, scheduleSave, findMessage }) {
  const { generateImage } = useImageGen()
  const voicePlayback = useVoicePlayback()
  const settingsStore = useSettingsStore()
  const vnStore = useVNStore()
  const charResStore = useCharacterResourcesStore()
  const speaking = reactive({ key: '' })

  const contactId = () => String(store?.activeChat?.id || '')
  const canGenerateImages = () => !!settingsStore.allowAIImageGeneration
  const promptStyle = () => resolveImagePromptStyle(vnStore.imageGenConfig || {})

  function persona() {
    const chat = store?.activeChat
    const personas = Array.isArray(store?.personas) ? store.personas : []
    return personas.find(item => item.id === chat?.personaId) ||
      personas.find(item => item.id === store?.defaultPersonaId) ||
      null
  }

  function avatarOf(who) {
    if (who === 'user' || who === 'me') {
      const p = persona()
      return { avatar: p?.avatar || '', type: p?.avatarType || 'emoji', name: p?.name || '我' }
    }
    const chat = store?.activeChat
    return { avatar: chat?.avatar || '', type: chat?.avatarType || 'emoji', name: chat?.name || '' }
  }

  function avatarUrl(who) {
    const info = avatarOf(who)
    return info.type === 'image' && info.avatar ? info.avatar : ''
  }

  /** 内置资源协议：avatar:char / avatar:user / sprite:表情名 */
  function resolveAsset(spec) {
    const raw = String(spec || '').trim()
    if (!raw) return ''
    if (isSafeExternalUrl(raw)) return raw
    const match = /^(avatar|sprite):\s*(.*)$/i.exec(raw)
    if (!match) return ''
    const kind = match[1].toLowerCase()
    const arg = match[2].trim()
    if (kind === 'avatar') return avatarUrl(arg === 'user' || arg === 'me' ? 'user' : 'char')
    const id = contactId()
    return id ? (charResStore.getSprite(id, arg || 'normal') || '') : ''
  }

  function context() {
    const char = avatarOf('char')
    const user = avatarOf('user')
    const now = new Date()
    return {
      char: { name: char.name, avatar: char.type === 'image' ? char.avatar : '', emoji: char.type === 'image' ? '' : char.avatar },
      user: { name: user.name, avatar: user.type === 'image' ? user.avatar : '', emoji: user.type === 'image' ? '' : user.avatar },
      today: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`,
      clock: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      weekday: ['日', '一', '二', '三', '四', '五', '六'][now.getDay()],
      imageGen: canGenerateImages()
    }
  }

  function buildPrompt(prompt, type) {
    const entry = contactId() ? charResStore.getEntry(contactId()) : null
    const isCharacter = type === 'char' || type === 'character'
    const text = String(prompt || '').trim()
    if (usesNaturalLanguageImagePrompt(promptStyle())) {
      const base = isCharacter ? String(entry?.basePrompt || '').trim() : ''
      return [base, text].filter(Boolean).join(', ')
    }
    const tags = [
      ...(isCharacter ? splitTags(entry?.artistTags) : []),
      ...(isCharacter ? splitTags(entry?.basePrompt) : []),
      ...splitTags(text),
      'masterpiece', 'best_quality'
    ]
    return Array.from(new Set(tags)).join(', ')
  }

  function buildOptions(type, size) {
    const preset = SIZE_PRESETS[size] || SIZE_PRESETS.square
    const options = { width: preset.width, height: preset.height, size: preset.size, openaiSize: preset.size }
    const provider = String(vnStore.imageGenConfig?.provider || '')
    const entry = contactId() ? charResStore.getEntry(contactId()) : null
    if ((type === 'char' || type === 'character') && (provider === 'nanobanana' || provider === 'openai_images')) {
      const base64 = extractBase64(entry?.baseImage?.url)
      if (base64) {
        options.baseImage = base64
        options.strength = provider === 'openai_images' ? 0.45 : 0.55
      }
    }
    if (entry?.negativePrompt) options.negativePromptAppend = String(entry.negativePrompt)
    return options
  }

  function getImage(msgId, key) {
    const message = findMessage(msgId)
    const asset = message?.uiAssets?.[key]
    if (asset?.url) return { status: 'done', url: asset.url }
    const status = generationStatus[`${msgId}:${key}`]
    return { status: status || 'idle', url: '' }
  }

  function requestImage(msgId, key, { prompt, type = 'scene', size = 'square' }) {
    const statusKey = `${msgId}:${key}`
    if (!canGenerateImages() || !String(prompt || '').trim()) return
    if (generationStatus[statusKey] === 'pending') return
    const message = findMessage(msgId)
    if (!message || message.uiAssets?.[key]?.url) return
    generationStatus[statusKey] = 'pending'
    queue.push(async () => {
      try {
        const url = await generateImage(buildPrompt(prompt, type), buildOptions(type, size))
        const target = findMessage(msgId)
        if (!url || !target) throw new Error('empty image')
        target.uiAssets = { ...(target.uiAssets || {}), [key]: { url, prompt: String(prompt).slice(0, 300) } }
        delete generationStatus[statusKey]
        scheduleSave?.()
      } catch (error) {
        console.warn('[smart-ui] image generation failed:', error?.message || error)
        generationStatus[statusKey] = 'error'
      }
    })
    pump()
  }

  function retryImage(msgId, key, request) {
    delete generationStatus[`${msgId}:${key}`]
    requestImage(msgId, key, request)
  }

  function stopSpeaking() {
    voicePlayback.stop()
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel?.()
    speaking.key = ''
  }

  async function speak(text, { key = '', emotion = '', who = 'char' } = {}) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500)
    if (!clean) return
    const speakKey = key || clean
    if (speaking.key === speakKey) {
      stopSpeaking()
      return
    }
    stopSpeaking()
    speaking.key = speakKey
    const done = () => {
      if (speaking.key === speakKey) speaking.key = ''
    }
    try {
      // 模拟语音模式下没有声音，界面里的播放退回浏览器朗读
      if (String(settingsStore.voiceTtsMode || 'simulated') === 'simulated') {
        if (typeof window === 'undefined' || !window.speechSynthesis) throw new Error('当前环境不支持朗读')
        const utterance = new SpeechSynthesisUtterance(clean)
        utterance.lang = 'zh-CN'
        utterance.onend = done
        utterance.onerror = done
        window.speechSynthesis.speak(utterance)
        return
      }
      await voicePlayback.play({
        contactId: who === 'user' ? '' : contactId(),
        isUser: who === 'user',
        text: clean,
        emotion,
        onEnded: done
      })
    } catch (error) {
      console.warn('[smart-ui] speak failed:', error?.message || error)
      done()
    }
  }

  return {
    context,
    resolveAsset,
    avatarOf,
    canGenerateImages,
    getImage,
    requestImage,
    retryImage,
    speak,
    stopSpeaking,
    speaking
  }
}
