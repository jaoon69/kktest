/**
 * 把模型写的 <style> 编译成只作用于当前卡片的 CSS。
 *
 * - 所有选择器加上卡片作用域前缀；:root / html / body / ui / :scope / & 指向卡片本身
 * - class 统一加 u- 前缀、id 加卡片前缀，避免命中应用自身的类名
 * - 组件标签名（card、row、stat……）映射到渲染后的类名
 * - @keyframes 改名为卡片私有，防止覆盖应用的全局动画
 * - 允许 @media / @supports / @container / @font-face；@import 只放行字体服务
 */

import { loadFontStylesheet } from './fonts'
import { sanitizeDeclaration, splitDeclarations } from './style'

const MAX_CSS_CHARS = 30000
const MAX_RULES = 400

export const COMPONENT_SELECTOR_MAP = Object.freeze({
  card: '.sui-card', box: '.sui-card', panel: '.sui-card',
  row: '.sui-row', hstack: '.sui-row', col: '.sui-col', column: '.sui-col', stack: '.sui-col', vstack: '.sui-col',
  grid: '.sui-grid', stat: '.sui-stat', metric: '.sui-stat', kv: '.sui-kv', badge: '.sui-badge', tag: '.sui-badge', pill: '.sui-badge',
  chips: '.sui-chips', chip: '.sui-chip', segmented: '.sui-segmented', segment: '.sui-segment', tabs: '.sui-tabs', tab: '.sui-tab-panel',
  steps: '.sui-steps', step: '.sui-step', progress: '.sui-progress', slider: '.sui-slider', text: '.sui-text', heading: '.sui-heading', title: '.sui-heading',
  divider: '.sui-divider', icon: '.sui-icon', avatar: '.sui-avatar', voice: '.sui-voice', image: '.sui-img', chart: '.sui-chart-wrap',
  btn: '.sui-btn', toggle: '.sui-toggle-row', checkbox: '.sui-check', check: '.sui-check', stepper: '.sui-stepper-field', rating: '.sui-rating'
})

const FONT_FACE_PROPERTIES = new Set(['font-family', 'src', 'font-weight', 'font-style', 'font-display', 'unicode-range', 'font-stretch', 'size-adjust', 'ascent-override', 'descent-override'])
const SCOPE_ALIASES = /^(?::root|html|body|ui|:scope|:host|&)(?![\w-])/i

function stripComments(text) {
  return String(text ?? '').replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
}

/** 把 CSS 文本切成 { prelude, body } 块（body 为 null 表示以分号结束的语句）。 */
function splitBlocks(text) {
  const blocks = []
  let i = 0
  let prelude = ''
  let quote = ''
  while (i < text.length) {
    const ch = text[i]
    if (quote) {
      prelude += ch
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; prelude += ch; i += 1; continue }
    if (ch === ';') {
      if (prelude.trim()) blocks.push({ prelude: prelude.trim(), body: null })
      prelude = ''
      i += 1
      continue
    }
    if (ch === '{') {
      let depth = 1
      let j = i + 1
      let innerQuote = ''
      for (; j < text.length; j += 1) {
        const c = text[j]
        if (innerQuote) {
          if (c === innerQuote) innerQuote = ''
          continue
        }
        if (c === '"' || c === "'") { innerQuote = c; continue }
        if (c === '{') depth += 1
        else if (c === '}') {
          depth -= 1
          if (depth === 0) break
        }
      }
      blocks.push({ prelude: prelude.trim(), body: text.slice(i + 1, j) })
      prelude = ''
      i = j + 1
      continue
    }
    if (ch === '}') { prelude = ''; i += 1; continue }
    prelude += ch
    i += 1
  }
  return blocks
}

function rewriteCompoundSelector(selector, ctx) {
  let out = ''
  let i = 0
  let bracket = 0
  let atTypePosition = true
  while (i < selector.length) {
    const ch = selector[i]
    if (ch === '[') { bracket += 1; out += ch; i += 1; atTypePosition = false; continue }
    if (ch === ']') { bracket = Math.max(0, bracket - 1); out += ch; i += 1; continue }
    if (bracket > 0) { out += ch; i += 1; continue }

    if (ch === '.' || ch === '#') {
      const match = /^[\w-]+/.exec(selector.slice(i + 1))
      if (!match) { out += ch; i += 1; continue }
      // sui- 开头的是渲染器内置类名，允许模型直接覆写
      const className = match[0].startsWith('sui-') ? match[0] : `u-${match[0]}`
      out += ch === '.' ? `.${className}` : `#${ctx.scopedId(match[0])}`
      i += 1 + match[0].length
      atTypePosition = false
      continue
    }
    if (/[\s>+~,(]/.test(ch)) {
      out += ch
      i += 1
      atTypePosition = true
      continue
    }
    if (ch === ':') {
      const match = /^::?[\w-]+/.exec(selector.slice(i))
      out += match ? match[0] : ch
      i += match ? match[0].length : 1
      atTypePosition = false
      continue
    }
    if (atTypePosition && /[a-z]/i.test(ch)) {
      const match = /^[a-z][\w-]*/i.exec(selector.slice(i))
      const name = match[0].toLowerCase()
      out += COMPONENT_SELECTOR_MAP[name] || name
      i += match[0].length
      atTypePosition = false
      continue
    }
    out += ch
    i += 1
    atTypePosition = ch === '*' ? false : atTypePosition
  }
  return out
}

function scopeSelectorList(prelude, ctx) {
  if (/[{}@;]|\\/.test(prelude)) return ''
  return prelude
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map((selector) => {
      const aliasMatch = SCOPE_ALIASES.exec(selector)
      if (aliasMatch) {
        const rest = rewriteCompoundSelector(selector.slice(aliasMatch[0].length), ctx)
        return `${ctx.scope}${rest}`
      }
      return `${ctx.scope} ${rewriteCompoundSelector(selector, ctx)}`
    })
    .join(', ')
}

function compileDeclarations(body, ctx, allowedProperties) {
  const out = []
  for (const raw of splitDeclarations(body)) {
    const colon = raw.indexOf(':')
    if (colon <= 0) continue
    const cleaned = sanitizeDeclaration(raw.slice(0, colon), raw.slice(colon + 1), {
      resolveUrl: ctx.resolveUrl,
      renameKeyframes: ctx.renameKeyframes,
      allowedProperties
    })
    if (cleaned) out.push(cleaned)
  }
  return out.join(';')
}

function compileKeyframes(name, body, ctx) {
  const frames = splitBlocks(body)
    .filter(block => block.body !== null && /^(?:from|to|\d{1,3}(?:\.\d+)?%)(?:\s*,\s*(?:from|to|\d{1,3}(?:\.\d+)?%))*$/i.test(block.prelude))
    .map(block => `${block.prelude}{${compileDeclarations(block.body, ctx)}}`)
  return frames.length ? `@keyframes ${ctx.keyframeName(name)}{${frames.join('')}}` : ''
}

function compileBlocks(blocks, ctx, depth = 0) {
  const out = []
  for (const block of blocks) {
    if (ctx.ruleCount >= MAX_RULES) break
    const prelude = block.prelude
    if (prelude.startsWith('@')) {
      const at = /^@([\w-]+)\s*([\s\S]*)$/.exec(prelude)
      if (!at) continue
      const name = at[1].toLowerCase()
      const params = at[2].trim()
      if (name === 'import' && block.body === null) {
        const url = /^(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?/.exec(params)?.[1]
        if (url) loadFontStylesheet(url)
        continue
      }
      if (block.body === null) continue
      if (name === 'keyframes' || name === '-webkit-keyframes') {
        if (/^[\w-]{1,40}$/.test(params)) out.push(compileKeyframes(params, block.body, ctx))
        continue
      }
      if (name === 'font-face') {
        const decls = compileDeclarations(block.body, { ...ctx, resolveUrl: ctx.resolveFontUrl }, FONT_FACE_PROPERTIES)
        if (/font-family:/.test(decls) && /src:/.test(decls)) out.push(`@font-face{${decls}}`)
        continue
      }
      if ((name === 'media' || name === 'supports' || name === 'container') && depth < 3 && !/[{};\\]|url\s*\(/i.test(params)) {
        const inner = compileBlocks(splitBlocks(block.body), ctx, depth + 1)
        if (inner) out.push(`@${name} ${params}{${inner}}`)
      }
      continue
    }
    if (block.body === null) continue
    const selector = scopeSelectorList(prelude, ctx)
    if (!selector) continue
    const decls = compileDeclarations(block.body, ctx)
    if (!decls) continue
    ctx.ruleCount += 1
    out.push(`${selector}{${decls}}`)
  }
  return out.join('\n')
}

/** 收集样式表里定义的 @keyframes 名字。 */
function collectKeyframeNames(text) {
  const names = new Set()
  const regex = /@(?:-webkit-)?keyframes\s+([\w-]{1,40})/gi
  let match
  while ((match = regex.exec(text)) !== null) names.add(match[1])
  return names
}

/**
 * @param {string} cssText
 * @param {{ scope: string, uid: string, scopedId: (id: string) => string, resolveUrl: (raw: string) => string }} options
 */
export function compileScopedStylesheet(cssText, options) {
  const text = stripComments(cssText).slice(0, MAX_CSS_CHARS)
  if (!text.trim()) return ''
  const keyframeNames = collectKeyframeNames(text)
  const keyframeName = name => `${options.uid}-${name}`
  const ctx = {
    scope: options.scope,
    scopedId: options.scopedId,
    resolveUrl: options.resolveUrl,
    resolveFontUrl: raw => (/^https:\/\/[^\s"'<>\\()]+$/i.test(raw) ? raw : ''),
    keyframeName,
    renameKeyframes: value => value.replace(/[\w-]+/g, word => (keyframeNames.has(word) ? keyframeName(word) : word)),
    ruleCount: 0
  }
  return compileBlocks(splitBlocks(text), ctx)
}

/** 行内 style 里引用卡片私有 @keyframes 时同样改名。 */
export function createKeyframeRenamer(cssTexts, uid) {
  const names = new Set()
  for (const text of cssTexts) collectKeyframeNames(stripComments(text)).forEach(name => names.add(name))
  if (names.size === 0) return null
  return value => value.replace(/[\w-]+/g, word => (names.has(word) ? `${uid}-${word}` : word))
}
