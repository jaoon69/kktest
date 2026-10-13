import { describe, expect, it } from 'vitest'
import { computed, reactive } from 'vue'
import { assignPath, evaluate, renderTemplate, resolveTemplateValue, runStatements, splitTemplate } from './expr'
import { extractSmartUIText, getSmartUITitle, parseSmartUIMarkup, replaceRootStateAttr, splitSmartUISegments } from './markup'
import { sanitizeStyle } from './style'
import { compileScopedStylesheet } from './stylesheet'
import { createInitialState, stateToLiteral } from './state'
import { pickFullSmartUIMessages, rewriteSmartUIContentForModel } from './history'
import { parseMessageContent, rebuildMessageContent } from '../composables/messageParser/contentParts'

describe('smart UI expressions', () => {
  it('evaluates arithmetic, helpers and member access', () => {
    const ctx = { state: { n: 6, items: [{ price: 3 }, { price: 4.5 }], name: '小明' } }
    expect(evaluate('fixed(n * 0.4, 1)', ctx)).toBe('2.4')
    expect(evaluate('sum(items, "price")', ctx)).toBe(7.5)
    expect(evaluate('sum(map(items, it => it.price * 2))', ctx)).toBe(15)
    expect(evaluate('n >= 6 ? "够了" : "不够"', ctx)).toBe('够了')
    expect(evaluate('items.length', ctx)).toBe(2)
    expect(evaluate('name + "好"', ctx)).toBe('小明好')
    expect(evaluate('{a: n, b: [1, 2]}', ctx)).toEqual({ a: 6, b: [1, 2] })
  })

  it('cannot reach prototypes or globals', () => {
    const ctx = { state: { o: {} } }
    expect(evaluate('o.constructor', ctx)).toBeUndefined()
    expect(evaluate('o["__proto__"]', ctx)).toBeUndefined()
    expect(evaluate('window', ctx)).toBeUndefined()
    expect(evaluate('alert(1)', ctx)).toBeUndefined()
    expect(runStatements('o.__proto__ = 1', ctx)).toBe(false)
    expect(Object.prototype.polluted).toBeUndefined()
  })

  it('runs statements and mutating helpers', () => {
    const state = { n: 1, picked: [], tab: 'a' }
    expect(runStatements('n = n + 2; tab = "b"; push(picked, "x"); toggle(picked, "y"); toggle(picked, "x")', { state })).toBe(true)
    expect(state).toEqual({ n: 3, tab: 'b', picked: ['y'] })
    expect(runStatements('n += 1', { state })).toBe(true)
    expect(state.n).toBe(4)
  })

  it('assigns bound paths including loop items', () => {
    const state = { rows: [{ done: false }] }
    const row = state.rows[0]
    expect(assignPath('item.done', true, { state, locals: [{ item: row }] })).toBe(true)
    expect(state.rows[0].done).toBe(true)
    expect(assignPath('count', 5, { state })).toBe(true)
    expect(state.count).toBe(5)
  })

  it('renders templates and keeps unparseable braces literal', () => {
    const ctx = { state: { n: 3 } }
    expect(renderTemplate('共 {n * 2} 份', ctx)).toBe('共 6 份')
    expect(renderTemplate('{这不是表达式 ！}', ctx)).toBe('{这不是表达式 ！}')
    expect(renderTemplate('半截 {n *', ctx)).toBe('半截 ')
    expect(resolveTemplateValue('{[1, n]}', ctx)).toEqual([1, 3])
    expect(splitTemplate('a {n} b')).toEqual(['a ', { expr: 'n' }, ' b'])
  })

  it('rounds floating noise for display', () => {
    expect(renderTemplate('{0.1 + 0.2}', { state: {} })).toBe('0.3')
  })

  it('tracks state keys that are added after the first render', () => {
    const state = reactive({})
    const text = computed(() => renderTemplate('选了{picked ?? "无"}', { state }))
    expect(text.value).toBe('选了无')
    runStatements("picked = '东风'", { state })
    expect(text.value).toBe('选了东风')
  })
})

describe('smart UI markup', () => {
  it('parses nested markup with attributes', () => {
    const parsed = parseSmartUIMarkup('<ui state="{n: 2}"><card><h3>标题</h3><slider bind="n" min="1" max="5"/><p>共 {n} 人</p></card></ui>')
    expect(parsed.ready).toBe(true)
    expect(parsed.rootAttrs.state).toBe('{n: 2}')
    const card = parsed.children[0]
    expect(card.tag).toBe('card')
    expect(card.children.map(child => child.tag)).toEqual(['h3', 'slider', 'p'])
  })

  it('tolerates streaming fragments', () => {
    expect(parseSmartUIMarkup('<ui sta').ready).toBe(false)
    const partial = parseSmartUIMarkup('<ui><card><h3>标题</h3><butt')
    expect(partial.ready).toBe(true)
    expect(partial.children[0].children.map(child => child.tag)).toEqual(['h3'])
    const halfAttr = parseSmartUIMarkup('<ui><stat label="人数" value="{n')
    expect(halfAttr.children).toEqual([])
  })

  it('treats comparison text as text and skips scripts', () => {
    const parsed = parseSmartUIMarkup('<ui><p>a < b</p><script>alert(1)</script><p>ok</p></ui>')
    expect(parsed.children.map(child => child.tag)).toEqual(['p', 'p'])
    expect(parsed.children[0].children[0].value).toBe('a < b')
  })

  it('splits message content into text and ui segments', () => {
    const segments = splitSmartUISegments('先看这个\n<ui><p>x</p></ui>\n好了\n<ui><p>y')
    expect(segments.map(segment => segment.type)).toEqual(['text', 'ui', 'text', 'ui'])
    expect(segments[1].complete).toBe(true)
    expect(segments[3].complete).toBe(false)
  })

  it('extracts readable summary and title', () => {
    const markup = '<ui><card><h3>周日烤羊腿</h3><stat label="羊腿" value="{n}" unit="kg"/><button send="好">采购清单</button></card></ui>'
    expect(getSmartUITitle(markup)).toBe('周日烤羊腿')
    expect(extractSmartUIText(markup)).toContain('采购清单')
  })

  it('replaces root state attribute safely', () => {
    const out = replaceRootStateAttr('<ui state="{n: 1}" accent="#f00"><p>{n}</p></ui>', stateToLiteral({ n: 5, s: 'a"b' }))
    const parsed = parseSmartUIMarkup(out)
    expect(createInitialState(parsed.rootAttrs.state)).toEqual({ n: 5, s: 'a"b' })
    expect(parsed.rootAttrs.accent).toBe('#f00')
  })
})

describe('smart UI style sanitizer', () => {
  it('keeps safe declarations and drops dangerous ones', () => {
    const out = sanitizeStyle("color: red; background: url(http://x); position: fixed; font-family: 'Kaiti', serif; transform: rotate(-1deg); behavior: x")
    expect(out).toContain('color:red')
    expect(out).toContain("font-family:'Kaiti', serif")
    expect(out).toContain('transform:rotate(-1deg)')
    expect(out).not.toContain('url(')
    expect(out).not.toContain('fixed')
  })

  it('routes url() through the resolver', () => {
    const resolveUrl = raw => (raw.startsWith('#') ? `#p-${raw.slice(1)}` : raw.startsWith('https://') ? raw : raw === 'avatar:char' ? 'data:image/png;base64,AAAA' : '')
    expect(sanitizeStyle('fill: url(#g1)', { resolveUrl })).toBe('fill:url("#p-g1")')
    expect(sanitizeStyle('background: url(avatar:char) center/cover', { resolveUrl })).toBe('background:url("data:image/png;base64,AAAA") center/cover')
    expect(sanitizeStyle("background-image: url('https://a.com/x.png')", { resolveUrl })).toBe('background-image:url("https://a.com/x.png")')
    expect(sanitizeStyle('background: url(javascript:alert(1))', { resolveUrl })).toBe('')
    expect(sanitizeStyle('background: u\\72l(http://x)', { resolveUrl })).toBe('')
  })
})

describe('smart UI scoped stylesheet', () => {
  const compile = css => compileScopedStylesheet(css, {
    scope: '[data-sui-scope="s1"]',
    uid: 's1',
    scopedId: id => `s1-${id}`,
    resolveUrl: raw => (raw.startsWith('https://') ? raw : '')
  })

  it('scopes selectors, prefixes classes and maps component tags', () => {
    const out = compile('.post > .name::before { content: "@"; color: #536471 } card:hover, #hero { opacity: .9 } :root { --x: 1 }')
    expect(out).toContain('[data-sui-scope="s1"] .u-post > .u-name::before{content:"@";color:#536471}')
    expect(out).toContain('[data-sui-scope="s1"] .sui-card:hover, [data-sui-scope="s1"] #s1-hero{opacity:.9}')
    expect(out).toContain('[data-sui-scope="s1"]{--x:1}')
  })

  it('renames keyframes and keeps media queries scoped', () => {
    const out = compile('@keyframes pop { from { transform: scale(.8) } to { transform: none } } .a { animation: pop .3s ease } @media (max-width: 300px) { .a { font-size: 12px } }')
    expect(out).toContain('@keyframes s1-pop{')
    expect(out).toContain('animation:s1-pop .3s ease')
    expect(out).toContain('@media (max-width: 300px){[data-sui-scope="s1"] .u-a{font-size:12px}}')
  })

  it('drops dangerous rules and imports from non-font hosts', () => {
    const out = compile('@import url(https://evil.com/x.css); .a { background: url(http://insecure/x.png) } .b { color: red; position: fixed } } body { color: blue }')
    expect(out).not.toContain('evil')
    expect(out).not.toContain('insecure')
    expect(out).not.toContain('fixed')
    expect(out).toContain('.u-b{color:red}')
    expect(out).toContain('[data-sui-scope="s1"]{color:blue}')
  })

  it('allows https font faces', () => {
    const out = compile("@font-face { font-family: 'Hand'; src: url(https://cdn.example.com/hand.woff2) format('woff2') }")
    expect(out).toContain('@font-face{font-family:\'Hand\';src:url("https://cdn.example.com/hand.woff2") format(\'woff2\')}')
  })
})

describe('smart UI style blocks in markup', () => {
  it('keeps style content raw and waits for it to close', () => {
    const parsed = parseSmartUIMarkup('<ui><style>.a > .b { color: red }</style><div class="a"><span class="b">x</span></div></ui>')
    expect(parsed.children[0].tag).toBe('style')
    expect(parsed.children[0].children[0].value).toBe('.a > .b { color: red }')
    expect(parseSmartUIMarkup('<ui><p>x</p><style>.a { col').children.map(child => child.tag)).toEqual(['p'])
  })
})

describe('smart UI in message content', () => {
  it('keeps the whole ui block as one part with stable indexes', () => {
    const content = '*推过来一张纸条*\n看看\n<ui state="{a: 1}">\n<card>\n<p>{a * 2}</p>\n</card>\n</ui>\n(transfer:5)'
    const parts = parseMessageContent(content, true)
    expect(parts.map(part => part.type)).toEqual(['narration', 'normal', 'ui', 'transfer'])
    expect(parts[2].content.startsWith('<ui')).toBe(true)
    const interactionOnly = parseMessageContent(content, { allowStickers: false, allowTransfer: true })
    expect(interactionOnly.findIndex(part => part.type === 'transfer')).toBe(3)
    expect(rebuildMessageContent(parts)).toContain('</ui>')
  })

  it('does not apply narration parsing inside ui markup', () => {
    const parts = parseMessageContent('<ui><p>{n*2*3}</p></ui>', true)
    expect(parts).toHaveLength(1)
    expect(parts[0].type).toBe('ui')
  })

  it('hides archived summaries the model may echo', () => {
    expect(parseMessageContent('<ui-archived>旧卡片</ui-archived>\n你好', true).map(part => part.content)).toEqual(['你好'])
  })
})

describe('smart UI history compaction', () => {
  it('keeps the latest ui messages full with saved state and archives older ones', () => {
    const older = { role: 'assistant', content: '<ui><h3>旧的</h3></ui>' }
    const recent = { role: 'assistant', content: '算好了\n<ui state="{n: 2}"><p>{n}</p></ui>', uiStates: { 1: { n: 7 } } }
    const keep = pickFullSmartUIMessages([older, { role: 'user', content: 'hi' }, recent], 1)
    expect(keep.has(recent)).toBe(true)
    expect(keep.has(older)).toBe(false)
    expect(rewriteSmartUIContentForModel(older, older.content, false)).toBe('<ui-archived>旧的</ui-archived>')
    const full = rewriteSmartUIContentForModel(recent, recent.content, true)
    expect(full).toContain('state="{n: 7}"')
    expect(full.startsWith('算好了')).toBe(true)
  })
})
