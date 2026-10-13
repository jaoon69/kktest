import { describe, expect, it } from 'vitest'
import { createSTCharacterCardContactData, extractSTCharacterCardFromPng, normalizeSTCharacterCard, readSTCharacterCardFile } from './stCharacterCard'
import { insertLorebookEntries } from '../composables/api/prompts/lorebook'

function card(data = {}) {
  return {
    spec: 'chara_card_v2', spec_version: '2.0',
    data: { name: '星河', description: '来自星空的旅人', first_mes: '你好，{{user}}！我是{{char}}。', ...data }
  }
}

function pngWithCards(chunks) {
  // A valid 1x1 PNG, with text chunks inserted before IEND.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=', 'base64')
  const textChunks = chunks.map(([key, payload]) => {
    const data = Buffer.from(`${key}\0${Buffer.from(JSON.stringify(payload)).toString('base64')}`)
    const chunk = Buffer.alloc(data.length + 12)
    chunk.writeUInt32BE(data.length)
    chunk.write('tEXt', 4)
    data.copy(chunk, 8)
    // Standard PNG CRC32, covering chunk type and data.
    let crc = 0xffffffff
    for (const byte of chunk.subarray(4, -4)) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
    return chunk
  })
  return Buffer.concat([png.subarray(0, -12), ...textChunks, png.subarray(-12)])
}

function file(bytes, name, type = '') {
  return { name, type, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer }
}

function injectedNames(parsed, messages) {
  const book = parsed.lorebook
  const result = insertLorebookEntries({
    activeChat: { msgs: messages.map(content => ({ role: 'user', content })), boundLorebooks: [book.id] },
    lorebook: { books: [book] }
  }, [{ role: 'system', content: parsed.prompt }], { char: parsed.name, user: '阿青' })
  return result.slice(1).map(message => message.content)
}

describe('SillyTavern character card import', () => {
  it('imports legacy V1 and wrapped V2/V3 cards, keeping character instructions separate from creator notes', () => {
    const parsed = normalizeSTCharacterCard(card({
      system_prompt: '{{original}}\n以角色身份回答', personality: '温柔', scenario: '星际旅行',
      mes_example: '{{char}}: 我带你看星星', post_history_instructions: '回答保持简短',
      creator_notes: '仅供作者说明', alternate_greetings: ['夜安，{{user}}'], tags: ['科幻']
    }))
    for (const text of ['以角色身份回答', '来自星空的旅人', '温柔', '星际旅行', '我带你看星星', '回答保持简短']) {
      expect(parsed.prompt).toContain(text)
    }
    expect(parsed.prompt).not.toContain('{{original}}')
    expect(parsed.prompt).not.toContain('仅供作者说明')
    expect(parsed.alternateGreetings).toEqual(['夜安，{{user}}'])
    expect(parsed.metadata.tags).toEqual(['科幻'])
    expect(normalizeSTCharacterCard(card().data).metadata.spec).toBe('chara_card_v1')
    expect(normalizeSTCharacterCard({ ...card(), spec: 'chara_card_v3', spec_version: '3.0' }).metadata.spec).toBe('chara_card_v3')
  })

  it('decodes Unicode PNG metadata and prefers ccv3 over backfilled chara', async () => {
    const v3 = { ...card({ name: '星河🌌' }), spec: 'chara_card_v3', spec_version: '3.0' }
    const bytes = pngWithCards([['chara', card({ name: '旧版' })], ['ccv3', v3]])
    expect(extractSTCharacterCardFromPng(bytes)).toEqual(v3)
    const parsed = await readSTCharacterCardFile(file(bytes, '角色.png', 'image/png'))
    expect(parsed.name).toBe('星河🌌')
    expect(parsed.hasAvatar).toBe(true)
    expect(extractSTCharacterCardFromPng(pngWithCards([['chara', card()]]))).toEqual(card())
  })

  it('imports UTF-8 JSON including BOM and preserves named external book references', async () => {
    const bytes = Buffer.from('\uFEFF' + JSON.stringify(card({ extensions: { world: '星际设定' } })))
    const parsed = await readSTCharacterCardFile(file(bytes, '角色.JSON'))
    expect(parsed.referencedLorebook).toBe('星际设定')
    expect(parsed.lorebook).toBeNull()
    expect(parsed.hasAvatar).toBe(false)
  })

  it('normalizes embedded worldbook flags, depth, ordering and generates independent IDs on repeated imports', () => {
    const payload = card({ character_book: {
      name: '星际设定', description: '星河的故事', scan_depth: 2,
      entries: [
        { id: 1, comment: '常驻', keys: [], content: '{{char}}来自群星', constant: true, enabled: true, insertion_order: 50 },
        { id: 2, name: '隐藏', keys: ['星河'], content: '隐藏内容', enabled: false },
        { keys: ['星舰'], secondary_keys: ['航行'], content: '航行设定', selective: true, extensions: { depth: 2, position: 4, selectiveLogic: 3 } }
      ]
    } })
    const first = normalizeSTCharacterCard(payload)
    const second = normalizeSTCharacterCard(payload)
    expect(first.lorebook.name).toBe('星际设定')
    expect(first.lorebook.scanDepth).toBe(2)
    expect(first.lorebook.entries[0]).toMatchObject({ name: '常驻', alwaysActive: true, enabled: true, order: 50 })
    expect(first.lorebook.entries[1].enabled).toBe(false)
    expect(first.lorebook.entries[2]).toMatchObject({ secondaryKeywords: ['航行'], selective: true, selectiveLogic: 3, insertDepth: -3 })
    expect(second.lorebook.id).not.toBe(first.lorebook.id)
    expect(new Set([...first.lorebook.entries, ...second.lorebook.entries].map(entry => entry.id)).size).toBe(6)
    expect(payload.data.character_book.entries[0].id).toBe(1)
  })

  it('injects imported worldbooks after a persistence roundtrip while respecting disabled, constant, selective and scan rules', () => {
    const parsed = JSON.parse(JSON.stringify(normalizeSTCharacterCard(card({ character_book: {
      scan_depth: 1,
      entries: [
        { keys: [], content: '{{char}}的常驻设定', constant: true },
        { keys: [], content: '禁用设定', constant: true, enabled: false },
        { keys: ['星舰'], secondary_keys: ['航行'], content: '次要关键词设定', selective: true },
        { keys: ['旧消息'], content: '旧关键词设定' },
        { keys: ['NASA'], content: '大小写设定', case_sensitive: true },
        { keys: ['/星[舰河]/u'], content: '正则设定', use_regex: true },
        { keys: ['/[invalid/'], content: '无效正则设定', use_regex: true }
      ]
    } }))))
    const injected = injectedNames(parsed, ['旧消息', '星舰航行 nasa'])
    expect(injected.join('\n')).toContain('星河的常驻设定')
    expect(injected.join('\n')).toContain('次要关键词设定')
    expect(injected.join('\n')).toContain('正则设定')
    for (const absent of ['禁用设定', '旧关键词设定', '大小写设定', '无效正则设定']) expect(injected.join('\n')).not.toContain(absent)
    expect(injectedNames(parsed, ['星舰 NASA']).join('\n')).not.toContain('次要关键词设定')
    expect(injectedNames(parsed, ['星舰 NASA']).join('\n')).toContain('大小写设定')
  })

  it.each([
    [0, '星舰 飞行', true], [0, '星舰', false],
    [1, '星舰 飞行', true], [1, '星舰 飞行 燃料', false],
    [2, '星舰', true], [2, '星舰 飞行', false],
    [3, '星舰 飞行 燃料', true], [3, '星舰 飞行', false]
  ])('honors secondary keyword logic %s for %s', (logic, message, expected) => {
    const parsed = normalizeSTCharacterCard(card({ character_book: { entries: [{
      keys: ['星舰'], secondary_keys: ['飞行', '燃料'], content: '条件设定', selective: true,
      extensions: { selectiveLogic: logic }
    }] } }))
    expect(injectedNames(parsed, [message]).length > 0).toBe(expected)
  })

  it('creates an editable greeting with selected names, and lets users omit the greeting', () => {
    const parsed = normalizeSTCharacterCard(card())
    const result = createSTCharacterCardContactData(parsed, { charName: '银河', userName: '阿青' })
    expect(result.msgs[0]).toMatchObject({ role: 'assistant', content: '你好，阿青！我是银河。' })
    expect(result.stCharacterCard.firstMessage).toContain('{{user}}')
    expect(createSTCharacterCardContactData(parsed, { greeting: '' }).msgs).toEqual([])
  })

  it('rejects unrelated JSON, unsupported formats and malformed worldbooks without partially importing a card', () => {
    for (const payload of [null, [], { name: '预设', prompts: [] }, { ...card(), data: null }]) {
      expect(() => normalizeSTCharacterCard(payload)).toThrow('角色卡')
    }
    expect(() => normalizeSTCharacterCard({ ...card(), spec: 'unknown' })).toThrow('暂不支持')
    expect(() => normalizeSTCharacterCard(card({ character_book: { entries: [null] } }))).toThrow('世界书')
    expect(() => normalizeSTCharacterCard(card({ character_book: '书名' }))).toThrow('世界书')
  })

  it('rejects PNGs without card data, corrupted chunks, invalid base64 and truncated files', async () => {
    expect(() => extractSTCharacterCardFromPng(pngWithCards([]))).toThrow('未包含角色卡数据')
    const bytes = pngWithCards([['chara', card()]])
    expect(() => extractSTCharacterCardFromPng(bytes.subarray(0, -5))).toThrow('损坏')
    const corrupt = Buffer.from(bytes)
    corrupt.writeUInt32BE(0xffffffff, 8)
    expect(() => extractSTCharacterCardFromPng(corrupt)).toThrow('损坏')
    const badData = Buffer.from(bytes)
    badData[badData.indexOf(Buffer.from('chara\0')) + 6] = 33
    expect(() => extractSTCharacterCardFromPng(badData)).toThrow('数据无效')
    await expect(readSTCharacterCardFile(file(Buffer.from('{'), 'bad.json'))).rejects.toThrow('JSON 格式无效')
    await expect(readSTCharacterCardFile(file(Buffer.from('text'), 'card.webp'))).rejects.toThrow('PNG 或 JSON')
    await expect(readSTCharacterCardFile({ ...file(bytes, 'card.png'), size: 51 * 1024 * 1024 })).rejects.toThrow('50 MB')
  })
})
