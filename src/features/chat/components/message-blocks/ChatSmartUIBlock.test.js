import { describe, expect, it } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import ChatSmartUIBlock from './ChatSmartUIBlock.vue'

async function renderBlocks(blocks) {
  const html = await renderToString(createSSRApp({
    render: () => h('div', blocks.map(block => h(ChatSmartUIBlock, { key: block.key, block })))
  }))
  return html.replace(/&quot;/g, '"')
}

function makeBlock(key, partIndex, css) {
  return {
    key,
    msgId: 'message-1',
    partIndex,
    isUser: false,
    complete: true,
    mb: 'mb-2',
    markup: `<ui><style>
      :root { --ui-radius: ${partIndex ? '0' : '24px'} }
      .bubble { ${css}; animation: appear 1s }
      @keyframes appear { from { opacity: 0 } to { opacity: 1 } }
    </style><card class="bubble" id="bubble">
      <svg viewBox="0 0 10 10"><defs><linearGradient id="paint">
        <stop offset="0" stop-color="blue"/>
      </linearGradient></defs><rect width="10" height="10" fill="url(#paint)"/></svg>
    </card></ui>`
  }
}

describe('ChatSmartUIBlock style isolation', () => {
  it('isolates rounded and pixel styles in separate UI parts of the same message', async () => {
    const html = await renderBlocks([
      makeBlock('rounded', 0, 'border-radius: 24px; background: linear-gradient(blue, purple)'),
      makeBlock('pixel', 1, 'border-radius: 0; background: black; image-rendering: pixelated')
    ])
    const scopes = [...html.matchAll(/class="sui-root[^"]*"[^>]*data-sui-scope="([^"]+)"/g)].map(match => match[1])
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1])

    expect(scopes).toHaveLength(2)
    expect(new Set(scopes).size).toBe(2)
    expect(styles).toHaveLength(2)
    for (const [index, scope] of scopes.entries()) {
      expect(styles[index]).toContain(`[data-sui-scope="${scope}"]`)
      expect(styles[index]).not.toContain(`[data-sui-scope="${scopes[1 - index]}"]`)
      expect(styles[index]).toContain(`animation:${scope}-appear 1s`)
      expect(styles[index]).toContain(`@keyframes ${scope}-appear`)
      expect(html).toContain(`id="${scope}-bubble"`)
      expect(html).toContain(`id="${scope}-paint"`)
      expect(html).toContain(`fill="url(#${scope}-paint)"`)
    }
    expect(styles[0]).toContain('border-radius:24px')
    expect(styles[0]).not.toContain('pixelated')
    expect(styles[1]).toContain('border-radius:0')
    expect(styles[1]).toContain('image-rendering:pixelated')
  })

  it('isolates styles across different messages with identical part indexes', async () => {
    const html = await renderBlocks([
      makeBlock('message-1-ui', 0, 'color: purple'),
      { ...makeBlock('message-2-ui', 0, 'color: green'), msgId: 'message-2' }
    ])
    const scopes = [...html.matchAll(/class="sui-root[^"]*"[^>]*data-sui-scope="([^"]+)"/g)].map(match => match[1])

    expect(scopes).toHaveLength(2)
    expect(new Set(scopes).size).toBe(2)
    expect(html).toContain(`[data-sui-scope="${scopes[0]}"] .u-bubble{color:purple`)
    expect(html).toContain(`[data-sui-scope="${scopes[1]}"] .u-bubble{color:green`)
  })
})
