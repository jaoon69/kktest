/**
 * 智能界面标记解析。
 *
 * 容错的 HTML 风格解析器：允许未闭合标签、半截属性（流式输出中常见），
 * 输出一棵只含 element / text 的纯数据树，由 SmartUIRenderer 按白名单渲染。
 */

const UI_OPEN_REGEX = /<ui(?=[\s>/])/i
const UI_CLOSE_REGEX = /<\/ui\s*>/i
const UI_ARCHIVED_REGEX = /<ui-archived\b[^>]*>[\s\S]*?(?:<\/ui-archived\s*>|$)/gi

export const VOID_TAGS = new Set([
  'br', 'hr', 'img', 'input', 'divider', 'spacer', 'icon', 'stat', 'kv', 'progress', 'chart',
  'slider', 'stepper', 'toggle', 'checkbox', 'chips', 'select', 'rating', 'meter',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'stop'
])

const RAW_SKIP_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'template', 'noscript'])
// 内容按原文保留、不解析标签的元素
const RAW_TEXT_TAGS = new Set(['style'])

const MAX_NODES = 2500
const MAX_DEPTH = 40

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·',
  times: '×', divide: '÷', minus: '−', deg: '°', yen: '¥', hellip: '…', mdash: '—', ndash: '–',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', hearts: '♥', check: '✓', copy: '©'
}

export function decodeEntities(text) {
  const src = String(text ?? '')
  if (!src.includes('&')) return src
  return src.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match
    }
    const decoded = ENTITY_MAP[body.toLowerCase()]
    return decoded ?? match
  })
}

/**
 * 在消息正文中定位 <ui> 块。
 * @returns {Array<{ type: 'text', content: string } | { type: 'ui', content: string, complete: boolean }>}
 */
export function splitSmartUISegments(content) {
  const text = stripArchivedSmartUI(content)
  const segments = []
  let rest = text
  while (rest) {
    const open = UI_OPEN_REGEX.exec(rest)
    if (!open) {
      segments.push({ type: 'text', content: rest })
      break
    }
    if (open.index > 0) segments.push({ type: 'text', content: rest.slice(0, open.index) })
    const fromOpen = rest.slice(open.index)
    const close = UI_CLOSE_REGEX.exec(fromOpen)
    if (!close) {
      segments.push({ type: 'ui', content: fromOpen, complete: false })
      break
    }
    const end = close.index + close[0].length
    segments.push({ type: 'ui', content: fromOpen.slice(0, end), complete: true })
    rest = fromOpen.slice(end)
  }
  return segments
}

export function hasSmartUIMarkup(content) {
  return UI_OPEN_REGEX.test(String(content ?? ''))
}

/** 去掉历史摘要标签 <ui-archived>（模型偶尔会照抄，不应显示）。 */
export function stripArchivedSmartUI(content) {
  const text = String(content ?? '')
  return /<ui-archived/i.test(text) ? text.replace(UI_ARCHIVED_REGEX, '').replace(/\n{3,}/g, '\n\n') : text
}

function isNameChar(ch) {
  return /[A-Za-z0-9_:.\-@]/.test(ch)
}

/**
 * 解析单个开标签（从 '<' 之后开始）。
 * @returns {{ tag: string, attrs: Record<string,string>, selfClosing: boolean, end: number } | null}
 *   返回 null 表示标签还没写完（流式中）。
 */
function parseOpenTag(src, start) {
  let i = start
  let tag = ''
  while (i < src.length && isNameChar(src[i])) {
    tag += src[i]
    i += 1
  }
  if (!tag) return { invalid: true }
  const attrs = {}
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i += 1
    if (i >= src.length) return null
    const ch = src[i]
    if (ch === '>') return { tag: tag.toLowerCase(), attrs, selfClosing: false, end: i + 1 }
    if (ch === '/' ) {
      if (src[i + 1] === '>') return { tag: tag.toLowerCase(), attrs, selfClosing: true, end: i + 2 }
      if (i + 1 >= src.length) return null
      i += 1
      continue
    }
    let name = ''
    while (i < src.length && !/[\s=>/]/.test(src[i])) {
      name += src[i]
      i += 1
    }
    if (i >= src.length) return null
    while (i < src.length && /\s/.test(src[i])) i += 1
    if (i >= src.length) return null
    if (src[i] !== '=') {
      if (name) attrs[name.toLowerCase()] = ''
      continue
    }
    i += 1
    while (i < src.length && /\s/.test(src[i])) i += 1
    if (i >= src.length) return null
    const quote = src[i]
    let value = ''
    if (quote === '"' || quote === "'") {
      const closeAt = src.indexOf(quote, i + 1)
      if (closeAt < 0) return null
      value = src.slice(i + 1, closeAt)
      i = closeAt + 1
    } else {
      while (i < src.length && !/[\s>]/.test(src[i]) && !(src[i] === '/' && src[i + 1] === '>')) {
        value += src[i]
        i += 1
      }
      if (i >= src.length) return null
    }
    if (name) attrs[name.toLowerCase()] = decodeEntities(value)
  }
}

/**
 * 解析 <ui ...>...</ui> 片段。
 * @returns {{ ready: boolean, rootAttrs: Record<string,string>, children: any[], nodeCount: number }}
 */
export function parseSmartUIMarkup(markup) {
  const src = String(markup ?? '')
  const openMatch = UI_OPEN_REGEX.exec(src)
  if (!openMatch) return { ready: false, rootAttrs: {}, children: [], nodeCount: 0 }
  const rootTag = parseOpenTag(src, openMatch.index + 1)
  if (!rootTag || rootTag.invalid) return { ready: false, rootAttrs: {}, children: [], nodeCount: 0 }

  const root = { type: 'el', tag: 'ui', attrs: rootTag.attrs, children: [] }
  if (rootTag.selfClosing) return { ready: true, rootAttrs: root.attrs, children: [], nodeCount: 0 }

  const stack = [root]
  let nodeCount = 0
  let i = rootTag.end

  const current = () => stack[stack.length - 1]
  const pushText = (text) => {
    if (!text) return
    const parent = current()
    const last = parent.children[parent.children.length - 1]
    if (last && last.type === 'text') {
      last.value += text
      return
    }
    nodeCount += 1
    parent.children.push({ type: 'text', value: text })
  }

  while (i < src.length && nodeCount < MAX_NODES) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      pushText(decodeEntities(src.slice(i)))
      break
    }
    if (lt > i) pushText(decodeEntities(src.slice(i, lt)))
    i = lt

    if (src.startsWith('<!--', i)) {
      const endComment = src.indexOf('-->', i + 4)
      if (endComment < 0) break
      i = endComment + 3
      continue
    }

    if (src[i + 1] === '/') {
      const gt = src.indexOf('>', i)
      if (gt < 0) break
      const name = src.slice(i + 2, gt).trim().toLowerCase()
      i = gt + 1
      if (name === 'ui') break
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].tag === name) {
          stack.length = depth
          break
        }
      }
      continue
    }

    if (i + 1 >= src.length) break
    if (!/[A-Za-z]/.test(src[i + 1])) {
      pushText('<')
      i += 1
      continue
    }

    const tag = parseOpenTag(src, i + 1)
    if (!tag) break
    if (tag.invalid) {
      pushText('<')
      i += 1
      continue
    }
    i = tag.end

    if (RAW_SKIP_TAGS.has(tag.tag)) {
      if (tag.selfClosing) continue
      const closeRegex = new RegExp(`</${tag.tag}\\s*>`, 'i')
      const closeMatch = closeRegex.exec(src.slice(i))
      if (!closeMatch) break
      i += closeMatch.index + closeMatch[0].length
      continue
    }

    if (RAW_TEXT_TAGS.has(tag.tag)) {
      if (tag.selfClosing) continue
      const closeMatch = /<\/style\s*>/i.exec(src.slice(i))
      // 样式没写完时先不应用，避免半截规则造成闪烁
      if (!closeMatch) break
      nodeCount += 1
      current().children.push({ type: 'el', tag: tag.tag, attrs: tag.attrs, raw: true, children: [{ type: 'text', value: src.slice(i, i + closeMatch.index) }] })
      i += closeMatch.index + closeMatch[0].length
      continue
    }

    const node = { type: 'el', tag: tag.tag, attrs: tag.attrs, children: [] }
    nodeCount += 1
    current().children.push(node)
    if (!tag.selfClosing && !VOID_TAGS.has(tag.tag) && stack.length < MAX_DEPTH) {
      stack.push(node)
    }
  }

  trimWhitespaceChildren(root)
  return { ready: true, rootAttrs: root.attrs, children: root.children, nodeCount }
}

const PRESERVE_WHITESPACE_TAGS = new Set(['pre', 'code', 'textarea', 'style'])

function trimWhitespaceChildren(node) {
  if (!node || node.type !== 'el') return
  if (PRESERVE_WHITESPACE_TAGS.has(node.tag)) return
  node.children = node.children.filter(child => !(child.type === 'text' && !child.value.trim()))
  node.children.forEach((child) => {
    if (child.type === 'text') {
      child.value = child.value.replace(/\s*\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ')
    } else {
      trimWhitespaceChildren(child)
    }
  })
}

/** 提取标记中的可读文本（用于预览、历史摘要）。 */
export function extractSmartUIText(markup, maxChars = 160) {
  const parsed = parseSmartUIMarkup(markup)
  const pieces = []
  const visit = (nodes) => {
    for (const node of nodes) {
      if (pieces.join(' ').length > maxChars * 2) return
      if (node.type === 'text') {
        const text = node.value.replace(/\{[^{}]*\}/g, '…').trim()
        if (text) pieces.push(text)
        continue
      }
      if (node.tag === 'svg' || node.tag === 'style') continue
      const labelAttrs = ['title', 'label', 'k', 'v', 'value']
      if (['stat', 'kv', 'button', 'tab', 'step', 'slider', 'stepper', 'toggle', 'checkbox', 'progress'].includes(node.tag)) {
        for (const key of labelAttrs) {
          const value = String(node.attrs?.[key] ?? '').replace(/\{[^{}]*\}/g, '…').trim()
          if (value && !/^…$/.test(value)) pieces.push(value)
        }
      }
      visit(node.children || [])
    }
  }
  visit(parsed.children)
  const text = pieces.join(' ').replace(/\s+/g, ' ').trim()
  const title = String(parsed.rootAttrs?.title || '').trim()
  const joined = title ? `${title}：${text}` : text
  return joined.length > maxChars ? `${joined.slice(0, Math.max(1, maxChars - 1))}…` : joined
}

/** 预览用标题：优先 title 属性，其次第一个标题元素。 */
export function getSmartUITitle(markup) {
  const parsed = parseSmartUIMarkup(markup)
  const title = String(parsed.rootAttrs?.title || '').trim()
  if (title) return title
  const find = (nodes) => {
    for (const node of nodes) {
      if (node.type !== 'el') continue
      if (/^h[1-4]$/.test(node.tag) || node.tag === 'title') {
        const text = (node.children || []).filter(child => child.type === 'text').map(child => child.value).join('').replace(/\{[^{}]*\}/g, '').trim()
        if (text) return text
      }
      const nested = find(node.children || [])
      if (nested) return nested
    }
    return ''
  }
  return find(parsed.children)
}

/** 用新的 state 字面量替换根标签上的 state 属性（历史回放时让模型看到用户调整后的状态）。 */
export function replaceRootStateAttr(markup, stateLiteral) {
  const src = String(markup ?? '')
  const openMatch = UI_OPEN_REGEX.exec(src)
  if (!openMatch) return src
  const rootTag = parseOpenTag(src, openMatch.index + 1)
  if (!rootTag || rootTag.invalid) return src
  const attrs = { ...rootTag.attrs, state: stateLiteral }
  const attrText = Object.entries(attrs)
    .map(([key, value]) => {
      const raw = String(value ?? '')
      if (!raw && key !== 'state') return key
      return `${key}="${raw.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`
    })
    .join(' ')
  return src.slice(0, openMatch.index) + `<ui ${attrText}${rootTag.selfClosing ? ' />' : '>'}` + src.slice(rootTag.end)
}
