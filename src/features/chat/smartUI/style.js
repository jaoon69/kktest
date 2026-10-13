/**
 * 智能界面 CSS 清洗。
 * 允许模型自由调整外观（颜色、边框、字体、渐变、变换、动画、伪元素内容……），
 * 拒绝脚本向量与会脱离卡片的定位方式；url() 只能经由 resolveUrl 解析成安全地址。
 */

const ALLOWED_PROPERTIES = new Set([
  'color', 'background', 'background-color', 'background-image', 'background-size', 'background-position', 'background-position-x', 'background-position-y',
  'background-repeat', 'background-clip', 'background-origin', 'background-attachment', 'background-blend-mode',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-style', 'border-width',
  'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color',
  'border-top-width', 'border-bottom-width', 'border-left-width', 'border-right-width',
  'border-top-style', 'border-bottom-style', 'border-left-style', 'border-right-style',
  'border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'border-collapse', 'border-spacing', 'border-image', 'border-image-source', 'border-image-slice', 'border-image-width', 'border-image-repeat',
  'border-inline', 'border-block', 'border-inline-start', 'border-inline-end', 'border-block-start', 'border-block-end',
  'outline', 'outline-offset', 'outline-color', 'outline-style', 'outline-width', 'box-shadow', 'box-sizing',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'padding-inline', 'padding-block',
  'padding-inline-start', 'padding-inline-end', 'padding-block-start', 'padding-block-end',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'margin-inline', 'margin-block',
  'margin-inline-start', 'margin-inline-end', 'margin-block-start', 'margin-block-end',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'aspect-ratio', 'inline-size', 'block-size',
  'display', 'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex-flow', 'order',
  'gap', 'row-gap', 'column-gap',
  'grid', 'grid-template', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'grid-area', 'grid-template-areas',
  'grid-auto-flow', 'grid-auto-rows', 'grid-auto-columns', 'grid-column-start', 'grid-column-end', 'grid-row-start', 'grid-row-end',
  'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items', 'justify-self', 'place-items', 'place-content', 'place-self',
  'text-align', 'text-align-last', 'vertical-align', 'font', 'font-size', 'font-weight', 'font-style', 'font-family', 'font-variant', 'font-variant-numeric',
  'font-feature-settings', 'font-variation-settings', 'font-stretch', 'font-kerning', 'font-synthesis',
  'letter-spacing', 'word-spacing', 'line-height', 'text-transform', 'text-decoration', 'text-decoration-line', 'text-decoration-color', 'text-decoration-style',
  'text-decoration-thickness', 'text-underline-offset', 'text-emphasis', 'text-emphasis-style', 'text-emphasis-color', 'text-emphasis-position',
  'text-shadow', 'text-indent', 'text-overflow', 'text-wrap', 'white-space', 'word-break', 'overflow-wrap', 'line-break', 'writing-mode', 'text-orientation', 'hyphens', 'direction', 'unicode-bidi',
  '-webkit-text-stroke', '-webkit-text-stroke-width', '-webkit-text-stroke-color', '-webkit-text-fill-color', '-webkit-background-clip',
  '-webkit-line-clamp', '-webkit-box-orient', 'line-clamp', 'tab-size',
  'opacity', 'visibility', 'transform', 'transform-origin', 'transform-style', 'perspective', 'perspective-origin', 'backface-visibility', 'rotate', 'scale', 'translate',
  'transition', 'transition-property', 'transition-duration', 'transition-delay', 'transition-timing-function',
  'animation', 'animation-delay', 'animation-duration', 'animation-iteration-count', 'animation-name', 'animation-timing-function',
  'animation-direction', 'animation-fill-mode', 'animation-play-state', 'will-change',
  'filter', 'backdrop-filter', '-webkit-backdrop-filter', 'mix-blend-mode', 'clip-path', 'mask', 'mask-image', 'mask-size', 'mask-position', 'mask-repeat',
  '-webkit-mask', '-webkit-mask-image', '-webkit-mask-size', '-webkit-mask-position', '-webkit-mask-repeat',
  'overflow', 'overflow-x', 'overflow-y', 'object-fit', 'object-position', 'scroll-snap-type', 'scroll-snap-align', 'scroll-behavior', 'overscroll-behavior', 'scrollbar-width',
  'position', 'top', 'right', 'bottom', 'left', 'inset', 'inset-inline', 'inset-block', 'z-index',
  'list-style', 'list-style-type', 'list-style-position', 'table-layout', 'caption-side', 'empty-cells',
  'content', 'counter-reset', 'counter-increment', 'counter-set', 'quotes',
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin', 'transform-box', 'paint-order',
  'cursor', 'user-select', 'pointer-events', 'isolation', 'contain', 'content-visibility', 'accent-color', 'caret-color', 'columns', 'column-count', 'column-width', 'column-rule',
  'image-rendering', 'shape-outside', 'float', 'clear'
])

// 反斜杠可被用来转义拼出 url( 等关键字，统一拒绝
const FORBIDDEN_VALUE_REGEX = /expression\s*\(|javascript\s*:|vbscript\s*:|@import|behavior\s*:|-moz-binding|[<>\\]|\/\*/i
const URL_FUNCTION_REGEX = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi
const ALLOWED_POSITIONS = new Set(['static', 'relative', 'absolute', 'sticky'])

export function splitDeclarations(text) {
  const out = []
  let depth = 0
  let quote = ''
  let buffer = ''
  for (const ch of String(text ?? '')) {
    if (quote) {
      buffer += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; buffer += ch; continue }
    if (ch === '(') depth += 1
    if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ';' && depth === 0) {
      out.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  if (buffer.trim()) out.push(buffer)
  return out
}

/**
 * 把值里的 url(...) 逐个交给 resolveUrl；任何一个无法解析就返回 null（丢弃整条声明）。
 */
function rewriteUrls(value, resolveUrl) {
  if (!/url\s*\(/i.test(value)) return value
  if (typeof resolveUrl !== 'function') return null
  let failed = false
  const next = value.replace(URL_FUNCTION_REGEX, (match, dq, sq, bare) => {
    const resolved = resolveUrl(String(dq ?? sq ?? bare ?? '').trim())
    if (!resolved) {
      failed = true
      return ''
    }
    return `url("${resolved.replace(/["\\\n\r]/g, '')}")`
  })
  if (failed || /url\s*\(/i.test(next.replace(URL_FUNCTION_REGEX, ''))) return null
  return next
}

/**
 * 清洗单条声明。
 * @returns {string | null} `prop:value` 或 null
 */
export function sanitizeDeclaration(property, rawValue, options = {}) {
  const prop = String(property || '').trim().toLowerCase()
  let value = String(rawValue ?? '').trim().replace(/!important\s*$/i, '').trim()
  if (!prop || !value || value.length > 2000) return null

  const isCustomProperty = /^--[a-z0-9-]{1,40}$/.test(prop)
  const allowed = options.allowedProperties || ALLOWED_PROPERTIES
  if (!isCustomProperty && !allowed.has(prop)) return null

  // url() 先抽出来单独校验，避免其中的合法字符（如 data: 里的 /）被整体规则误杀
  const placeholders = []
  const masked = value.replace(URL_FUNCTION_REGEX, (match) => {
    placeholders.push(match)
    return `__SUI_URL_${placeholders.length - 1}__`
  })
  if (FORBIDDEN_VALUE_REGEX.test(masked)) return null
  if (/url\s*\(/i.test(masked)) return null
  value = placeholders.length
    ? rewriteUrls(masked.replace(/__SUI_URL_(\d+)__/g, (m, i) => placeholders[Number(i)]), options.resolveUrl)
    : masked
  if (value == null) return null

  if (prop === 'position' && !ALLOWED_POSITIONS.has(value.toLowerCase())) return null
  if (prop === 'z-index') {
    const n = Number.parseInt(value, 10)
    if (!Number.isFinite(n)) return null
    value = String(Math.max(-1, Math.min(50, n)))
  }
  if ((prop === 'animation' || prop === 'animation-name') && typeof options.renameKeyframes === 'function') {
    value = options.renameKeyframes(value)
  }
  return `${prop}:${value}`
}

/**
 * @param {string} text 原始 style 文本
 * @param {{ resolveUrl?: (raw: string) => string, renameKeyframes?: (value: string) => string }} [options]
 * @returns {string} 清洗后的 style 文本
 */
export function sanitizeStyle(text, options = {}) {
  if (!text) return ''
  const declarations = []
  for (const raw of splitDeclarations(text)) {
    const colon = raw.indexOf(':')
    if (colon <= 0) continue
    const cleaned = sanitizeDeclaration(raw.slice(0, colon), raw.slice(colon + 1), options)
    if (cleaned) declarations.push(cleaned)
  }
  return declarations.join(';')
}

/** 单个颜色类属性值（svg fill / stroke 等）的清洗。 */
export function sanitizePaintValue(value, rewriteUrlRef) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const ref = /^url\(\s*#([\w-]+)\s*\)$/i.exec(raw)
  if (ref) return typeof rewriteUrlRef === 'function' ? `url(#${rewriteUrlRef(ref[1])})` : ''
  if (FORBIDDEN_VALUE_REGEX.test(raw) || /url\s*\(/i.test(raw)) return ''
  return raw
}

export function isSafeAttributeValue(value) {
  const text = String(value ?? '')
  return !FORBIDDEN_VALUE_REGEX.test(text) && !/url\s*\(/i.test(text) && !/^\s*(?:javascript|data|vbscript)\s*:/i.test(text)
}

/** 外链资源地址校验：https 或内联图片 data URL。 */
export function isSafeExternalUrl(value) {
  const url = String(value || '').trim()
  return /^https:\/\/[^\s"'<>\\()]+$/i.test(url) || /^data:image\/(?:png|jpe?g|gif|webp|avif|svg\+xml);base64,[a-z0-9+/=\s]+$/i.test(url)
}
