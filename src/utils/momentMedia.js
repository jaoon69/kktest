/**
 * 动态/朋友圈内容中的内联媒体标记解析。
 *
 * 支持的标记（可出现在 (动态:...) / (动态评论:...) 的内容里）：
 *   [图:tag1, tag2]        —— 配图（生图提示标签）
 *   [语音:内容]             —— 语音
 *   [语音:开心:内容]        —— 带情绪的语音
 *
 * 剩余文本若以「:emoji」结尾则拆出 mood（仅限 1-3 个 emoji 字符）。
 */

import { estimateVoiceDuration } from './voiceWaveform'

export { estimateVoiceDuration as estimateMomentVoiceDuration }

const IMAGE_MARKER_REGEX = /[[【]\s*(?:图|图片|配图|image|img|photo)\s*[:：]\s*([^\]】]+?)\s*[\]】]/gi
const VOICE_MARKER_REGEX = /[[【]\s*(?:语音|voice)\s*[:：]\s*([^\]】]+?)\s*[\]】]/gi

const EMOTION_ALIASES = {
  normal: 'normal', 平静: 'normal', 正常: 'normal',
  happy: 'happy', 开心: 'happy', 高兴: 'happy', 快乐: 'happy',
  sad: 'sad', 难过: 'sad', 伤心: 'sad', 委屈: 'sad',
  surprised: 'surprised', 惊讶: 'surprised', 震惊: 'surprised',
  angry: 'angry', 生气: 'angry', 愤怒: 'angry',
  shy: 'shy', 害羞: 'shy',
  thinking: 'thinking', 思考: 'thinking', 纠结: 'thinking',
  laughing: 'laughing', 大笑: 'laughing', 爆笑: 'laughing',
  excited: 'excited', 兴奋: 'excited', 激动: 'excited',
  worried: 'worried', 担心: 'worried', 担忧: 'worried',
  confused: 'confused', 困惑: 'confused', 疑惑: 'confused',
  love: 'love', 撒娇: 'love', 甜蜜: 'love', 心动: 'love',
  sleepy: 'sleepy', 困: 'sleepy', 犯困: 'sleepy',
  proud: 'proud', 骄傲: 'proud', 得意: 'proud',
  nervous: 'nervous', 紧张: 'nervous'
}

export function normalizeMomentVoiceEmotion(value) {
  const key = String(value || '').trim().toLowerCase()
  if (!key) return ''
  return EMOTION_ALIASES[key] || EMOTION_ALIASES[String(value || '').trim()] || ''
}


function isEmojiOnly(text) {
  const raw = String(text || '').trim()
  if (!raw) return false
  if (Array.from(raw).length > 3) return false
  try {
    return /^(?:\p{Extended_Pictographic}|[☀-➿⬀-⯿]|\uFE0F|\u200D)+$/u.test(raw)
  } catch {
    return false
  }
}

function splitTrailingMood(text) {
  const raw = String(text || '').trim()
  const match = raw.match(/^([\s\S]*?)[:：]\s*([^:：\s]{1,8})\s*$/)
  if (!match) return { text: raw, mood: '' }
  const tail = match[2].trim()
  const head = match[1].trim()
  if (!head || !isEmojiOnly(tail)) return { text: raw, mood: '' }
  return { text: head, mood: tail }
}

function parseVoicePayload(payload) {
  const raw = String(payload || '').trim()
  if (!raw) return null
  const idx = raw.search(/[:：]/)
  if (idx > 0) {
    const first = raw.slice(0, idx).trim()
    const rest = raw.slice(idx + 1).trim()
    const emotion = normalizeMomentVoiceEmotion(first)
    if (emotion && rest) {
      return { text: rest, emotion }
    }
  }
  return { text: raw, emotion: '' }
}

/**
 * 提取动态/评论内容中的媒体标记。
 * @param {string} payload 原始内容（含标记）
 * @param {{ allowImages?: boolean, allowVoice?: boolean }} options 开关关闭时标记会被剥离且不返回媒体
 * @returns {{ text: string, mood: string, imageTags: string[], voiceText: string, voiceEmotion: string, voiceDuration: number|null }}
 */
export function extractMomentMedia(payload, options = {}) {
  const { allowImages = true, allowVoice = true } = options
  let text = String(payload || '')

  const imageTags = []
  text = text.replace(IMAGE_MARKER_REGEX, (_, tags) => {
    const cleaned = String(tags || '').trim()
    if (allowImages && cleaned) imageTags.push(cleaned)
    return ' '
  })

  let voiceText = ''
  let voiceEmotion = ''
  text = text.replace(VOICE_MARKER_REGEX, (_, payloadPart) => {
    if (allowVoice && !voiceText) {
      const parsed = parseVoicePayload(payloadPart)
      if (parsed?.text) {
        voiceText = parsed.text
        voiceEmotion = parsed.emotion || ''
      }
    }
    return ' '
  })

  text = text.replace(/[ \t]{2,}/g, ' ').trim()
  const { text: finalText, mood } = splitTrailingMood(text)

  return {
    text: finalText,
    mood,
    imageTags,
    voiceText,
    voiceEmotion,
    voiceDuration: voiceText ? estimateVoiceDuration(voiceText) : null
  }
}
