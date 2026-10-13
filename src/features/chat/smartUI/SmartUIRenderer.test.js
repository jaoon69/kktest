import { describe, expect, it } from 'vitest'
import { createSSRApp, h, reactive } from 'vue'
import { renderToString } from 'vue/server-renderer'
import SmartUIRenderer from './SmartUIRenderer'
import { parseSmartUIMarkup } from './markup'
import { createInitialState } from './state'

async function render(markup, overrides = {}) {
  const parsed = parseSmartUIMarkup(markup)
  const state = reactive(createInitialState(parsed.rootAttrs.state))
  const app = createSSRApp({
    render: () => h(SmartUIRenderer, { nodes: parsed.children, state, canSend: true, ...overrides })
  })
  return renderToString(app)
}

describe('SmartUIRenderer', () => {
  it('renders the prompt example with computed values', async () => {
    const html = await render(`<ui state="{n: 6}">
<card>
<h3>周日烤羊腿</h3>
<slider bind="n" min="2" max="12" label="几个人吃" unit="人"/>
<grid cols="3">
<stat label="带骨羊腿" value="{fixed(n * 0.4, 1)}" unit="kg"/>
<stat label="土豆" value="{n * 250}" unit="g"/>
</grid>
<steps><step time="开饭前 {round((60 + n * 5) / 60 + 1, 1)} 小时" title="进烤箱">220℃</step></steps>
<row><button send="给我{n}人份的采购清单">采购清单</button></row>
</card>
</ui>`)
    expect(html).toContain('周日烤羊腿')
    expect(html).toContain('2.4')
    expect(html).toContain('1500')
    expect(html).toContain('开饭前 2.5 小时')
    expect(html).toContain('6人')
    expect(html).toContain('sui-btn-send')
    expect(html).toContain('class="sui-range"')
  })

  it('renders chips, conditional content and loops', async () => {
    const html = await render(`<ui state="{pick: '咸', list: [{t: 'a', done: true}, {t: 'b', done: false}]}">
<chips bind="pick" options="['甜', '咸']"/>
<button variant="primary" if="pick" send="我选了「{pick}」">交卷</button>
<text if="pick == '甜'">不会出现</text>
<checkbox each="item in list" bind="item.done" label="{item.t}"/>
</ui>`)
    expect(html).toContain('sui-chip is-active')
    expect(html).toContain('交卷')
    expect(html).not.toContain('不会出现')
    expect((html.match(/sui-check /g) || []).length + (html.match(/sui-check"/g) || []).length).toBeGreaterThanOrEqual(1)
    expect(html).toContain('is-checked')
  })

  it('renders charts, tabs and sanitized svg', async () => {
    const html = await render(`<ui state="{tab: 'b'}">
<chart type="bar" data="[['A', 3], ['B', 5]]" unit="次"/>
<chart type="donut" data="[['x', 1], ['y', 3]]" center="共4"/>
<tabs bind="tab"><tab value="a" label="甲">第一页</tab><tab value="b" label="乙">第二页</tab></tabs>
<svg viewBox="0 0 10 10" onclick="alert(1)"><defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)" href="javascript:alert(1)"/></svg>
</ui>`)
    expect(html).toContain('5次')
    expect(html).toContain('共4')
    expect(html).toContain('第二页')
    expect(html).not.toContain('第一页')
    expect(html).toContain('viewBox="0 0 10 10"')
    expect(html).toContain('linearGradient')
    expect(html).toMatch(/fill="url\(#sui\d+-g\)"/)
    expect(html).not.toContain('javascript')
    expect(html).not.toContain('onclick')
  })

  it('disables send buttons when sending is not possible', async () => {
    const html = await render('<ui><button send="好">好</button><button set="x = 1">本地</button></ui>', { canSend: false })
    const buttons = html.split('</button>')
    expect(buttons[0]).toContain('disabled')
    expect(buttons[0]).toContain('好')
    expect(buttons[1]).toContain('本地')
    expect(buttons[1]).not.toContain('disabled')
  })
})

function createFakeMedia(overrides = {}) {
  const requests = []
  return {
    requests,
    resolveAsset: spec => (spec === 'avatar:char' ? 'data:image/png;base64,QUJD' : spec === 'sprite:smile' ? 'https://cdn.example.com/smile.png' : ''),
    avatarOf: who => (who === 'user' ? { avatar: '🐱', type: 'emoji', name: '我' } : { avatar: 'data:image/png;base64,QUJD', type: 'image', name: '阿杰' }),
    canGenerate: () => true,
    getImage: key => (overrides.images?.[key] ? { status: 'done', url: overrides.images[key] } : { status: 'idle', url: '' }),
    requestImage: (key, request) => requests.push({ key, request }),
    retryImage: () => {},
    speak: () => {},
    speaking: { key: '' },
    ...overrides.media
  }
}

describe('SmartUIRenderer framework capabilities', () => {
  it('compiles a scoped stylesheet and prefixes classes', async () => {
    const html = (await render('<ui state="{on: true}"><style>.post { color: #111 } .lit::after { content: "!" }</style><div class="post {on ? \'lit\' : \'\'}" id="p1">hi</div></ui>', { uid: 'tst' })).replace(/&quot;/g, '"')
    expect(html).toContain('<style>')
    expect(html).toContain('[data-sui-scope="tst"] .u-post{color:#111}')
    expect(html).toContain('[data-sui-scope="tst"] .u-lit::after{content:"!"}')
    expect(html).toContain('class="sui-div u-post u-lit"')
    expect(html).toContain('id="tst-p1"')
  })

  it('renders avatars, sprites and context variables', async () => {
    const media = createFakeMedia()
    const html = await render('<ui><avatar who="char" size="32"/><avatar who="user"/><img src="sprite:smile"/><p>{char.name}和{user.name}</p></ui>', {
      media,
      context: { char: { name: '阿杰' }, user: { name: '我' } }
    })
    expect(html).toContain('src="data:image/png;base64,QUJD"')
    expect(html).toContain('🐱')
    expect(html).toContain('src="https://cdn.example.com/smile.png"')
    expect(html).toContain('阿杰和我')
  })

  it('requests generated images only when live and shows cached results', async () => {
    const media = createFakeMedia()
    const waiting = await render('<ui><img gen="rainy street" size="landscape"/></ui>', { media, live: false })
    expect(waiting).toContain('is-pending')
    await Promise.resolve()
    expect(media.requests).toHaveLength(0)

    await render('<ui><img gen="rainy street" size="landscape"/></ui>', { media, live: true })
    await Promise.resolve()
    expect(media.requests).toHaveLength(1)
    expect(media.requests[0].request).toEqual({ prompt: 'rainy street', type: 'scene', size: 'landscape' })

    const cachedKey = media.requests[0].key
    const done = await render('<ui><img gen="rainy street" size="landscape"/></ui>', { media: createFakeMedia({ images: { [cachedKey]: 'https://cdn.example.com/out.png' } }) })
    expect(done).toContain('src="https://cdn.example.com/out.png"')
  })

  it('renders voice pills and rejects unsafe svg animation targets', async () => {
    const html = await render('<ui><voice text="晚安，早点睡"/><svg viewBox="0 0 10 10"><image href="sprite:smile" width="10" height="10"/><a><set attributeName="href" to="javascript:alert(1)"/></a><use href="https://evil.com/x.svg#a"/></svg></ui>', { media: createFakeMedia() })
    expect(html).toContain('sui-voice')
    expect(html).toContain('href="https://cdn.example.com/smile.png"')
    expect(html).not.toContain('javascript')
    expect(html).not.toContain('evil.com')
  })
})
