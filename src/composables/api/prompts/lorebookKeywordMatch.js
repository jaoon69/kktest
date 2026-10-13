/**
 * Lorebook 关键词匹配策略。
 *
 * 旧实现是纯子串匹配（recentMessages.includes(keyword)），两类误触发严重：
 * - 英文短词嵌入长词（"cat" 命中 "concatenate"）
 * - 中文单字关键词嵌入无关词语（"雨" 命中 "雨果"、"李雨桐"）
 *
 * 策略（按关键词形态分派）：
 * - 纯 ASCII 词 → 词边界正则匹配
 * - 中文单字 → 用 Intl.Segmenter 分词后按"独立词 / 短词首尾字"匹配
 * - 其余（含 2 字以上中文词）→ 保持子串匹配（多字词歧义低，维持旧行为）
 */

const ASCII_WORD_RE = /^[A-Za-z0-9][A-Za-z0-9 _'-]*$/
const CJK_CHAR_RE = /[㐀-鿿豈-﫿]/

let cachedSegmenter = null
function getWordSegmenter() {
  if (cachedSegmenter !== null) return cachedSegmenter
  try {
    cachedSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
      ? new Intl.Segmenter('zh', { granularity: 'word' })
      : false
  } catch {
    cachedSegmenter = false
  }
  return cachedSegmenter
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isCjkChar(value) {
  return !!value && CJK_CHAR_RE.test(value)
}

function hasStandaloneCjkChar(text, keyword) {
  let index = text.indexOf(keyword)
  while (index >= 0) {
    const previous = text[index - 1] || ''
    const next = text[index + keyword.length] || ''
    if (!isCjkChar(previous) && !isCjkChar(next)) return true
    index = text.indexOf(keyword, index + keyword.length)
  }
  return false
}

/**
 * 预处理一次待匹配文本，供多个关键词复用（分词是惰性的，只有出现中文单字关键词才会做）。
 * @param {string} text
 */
export function prepareKeywordMatchContext(text) {
  const raw = String(text || '')
  return {
    raw,
    lower: raw.toLowerCase(),
    _wordSegments: null,
    get wordSegments() {
      if (this._wordSegments) return this._wordSegments
      const segmenter = getWordSegmenter()
      const segments = new Set()
      if (segmenter) {
        for (const item of segmenter.segment(this.raw)) {
          if (item.isWordLike) segments.add(item.segment)
        }
      }
      this._wordSegments = segments
      return segments
    }
  }
}

function matchSingleCjkChar(context, keyword) {
  const segmenter = getWordSegmenter()
  // 不支持分词时采用保守边界匹配，避免退回旧的高误触发子串逻辑。
  if (!segmenter) return hasStandaloneCjkChar(context.raw, keyword)

  for (const segment of context.wordSegments) {
    // 两字词的首尾字（"下雨"、"雨天"、"暴雨"）——最常见的合法触发形态；
    // 三字及以上词多为专名/复合词（"雨果奖"、"李雨桐"），不触发
    if (segment.length === 2 && (segment.startsWith(keyword) || segment.endsWith(keyword))) {
      return true
    }
  }
  // Intl.Segmenter 可能把人名逐字拆开（"雨果" => "雨"、"果"），
  // 因此单字 segment 只有在原文两侧都不是汉字时才视为独立成词。
  return hasStandaloneCjkChar(context.raw, keyword)
}

/**
 * @param {ReturnType<typeof prepareKeywordMatchContext>} context
 * @param {string} rawKeyword
 * @param {{ caseSensitive?: boolean }} [options]
 * @returns {boolean}
 */
export function matchesLorebookKeyword(context, rawKeyword, { caseSensitive = false } = {}) {
  const keyword = String(rawKeyword || '').trim()
  if (!keyword || !context) return false

  if (ASCII_WORD_RE.test(keyword)) {
    const re = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, caseSensitive ? '' : 'i')
    return re.test(context.raw)
  }

  if (keyword.length === 1 && CJK_CHAR_RE.test(keyword)) {
    return matchSingleCjkChar(context, keyword)
  }

  return caseSensitive ? context.raw.includes(keyword) : context.lower.includes(keyword.toLowerCase())
}
