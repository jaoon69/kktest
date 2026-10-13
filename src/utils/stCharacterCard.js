import { makeId } from './id'
import { applyTemplateVars } from '../composables/api/prompts/templateVars'

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const CHARACTER_FIELDS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example']
const MAX_CARD_BYTES = 50 * 1024 * 1024

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function stringList(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : []
}

function finiteNumber(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function parseJson(value) {
  try {
    return JSON.parse(value.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('角色卡 JSON 格式无效')
  }
}

function isPng(bytes) {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

// Read metadata before image compression, which removes PNG text chunks.
export function extractSTCharacterCardFromPng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (!isPng(bytes)) throw new Error('文件不是有效的 PNG 角色卡')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const chunks = new Map()
  let offset = PNG_SIGNATURE.length
  let ended = false

  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset)
    const end = offset + 12 + length
    if (end > bytes.length) throw new Error('PNG 角色卡文件已损坏或不完整')
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8))
    if (type === 'tEXt') {
      const data = bytes.subarray(offset + 8, offset + 8 + length)
      const separator = data.indexOf(0)
      if (separator > 0) {
        const keyword = decoder.decode(data.subarray(0, separator))
        if (keyword === 'chara' || keyword === 'ccv3') {
          chunks.set(keyword, decoder.decode(data.subarray(separator + 1)))
        }
      }
    }
    offset = end
    if (type === 'IEND') {
      ended = true
      break
    }
  }

  if (!ended) throw new Error('PNG 角色卡文件已损坏或不完整')
  const encoded = chunks.get('ccv3') ?? chunks.get('chara')
  if (encoded === undefined) throw new Error('这张 PNG 未包含角色卡数据，请选择从酒馆导出的角色卡')
  try {
    const binary = atob(encoded.trim())
    const json = new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, character => character.charCodeAt(0))
    )
    return parseJson(json)
  } catch {
    throw new Error('PNG 中的角色卡数据无效')
  }
}

export function normalizeSTCharacterBook(raw, characterName) {
  if (!isObject(raw)) throw new Error('角色卡的世界书格式无效')
  const entries = Array.isArray(raw.entries)
    ? raw.entries
    : isObject(raw.entries) ? Object.values(raw.entries) : null
  if (!entries || entries.some(entry => !isObject(entry) || typeof entry.content !== 'string')) {
    throw new Error('角色卡的世界书条目格式无效')
  }
  const now = Date.now()
  return {
    id: makeId('book'),
    name: text(raw.name) || `${characterName}的世界书`,
    description: text(raw.description),
    icon: '📖',
    source: 'sillytavern',
    scanDepth: Math.max(0, Math.floor(finiteNumber(raw.scan_depth, 10))),
    entries: entries.map((entry, index) => {
      const extensions = isObject(entry.extensions) ? entry.extensions : {}
      const position = extensions.position ?? entry.position
      const depth = Math.max(0, Math.floor(finiteNumber(extensions.depth ?? entry.depth, 4)))
      return {
        id: makeId('entry'),
        name: text(entry.name) || text(entry.comment) || `条目 ${index + 1}`,
        content: entry.content,
        keywords: stringList(entry.keys ?? entry.key),
        secondaryKeywords: stringList(entry.secondary_keys ?? entry.keysecondary),
        selective: entry.selective === true,
        selectiveLogic: finiteNumber(extensions.selectiveLogic ?? entry.selectiveLogic, 0),
        caseSensitive: (entry.case_sensitive ?? extensions.case_sensitive ?? entry.caseSensitive) === true,
        useRegex: entry.use_regex === true,
        scanDepth: Math.max(0, Math.floor(finiteNumber(extensions.scan_depth ?? entry.scanDepth, finiteNumber(raw.scan_depth, 10)))),
        alwaysActive: entry.constant === true,
        enabled: entry.enabled !== false && entry.disable !== true,
        // ST's in-chat depth counts from the end; native negative depths include an offset of one.
        insertDepth: position === 4 ? -(depth + 1) : 0,
        order: finiteNumber(entry.insertion_order ?? entry.order, index),
        stWorldInfo: { ...entry },
        createdAt: now,
        updatedAt: now
      }
    }),
    stWorldInfo: { ...raw, entries: undefined },
    createdAt: now,
    updatedAt: now
  }
}

export function normalizeSTCharacterCard(payload) {
  if (!isObject(payload)) throw new Error('未识别到有效的 SillyTavern 角色卡')
  if (payload.spec && !['chara_card_v2', 'chara_card_v3'].includes(payload.spec)) {
    throw new Error('暂不支持此角色卡格式，请导出为 V2/V3 PNG 或 JSON')
  }
  const data = payload.spec ? payload.data : payload
  if (!isObject(data) || !text(data.name) || !CHARACTER_FIELDS.some(key => typeof data[key] === 'string')) {
    throw new Error('未识别到有效的 SillyTavern 角色卡，请检查名称和角色设定')
  }
  const name = text(data.name)
  const promptFields = [
    ['system_prompt', '系统指令'],
    ['description', '角色描述'],
    ['personality', '性格'],
    ['scenario', '场景'],
    ['mes_example', '示例对话'],
    ['post_history_instructions', '补充指令']
  ]
  const prompt = promptFields.map(([key, label]) => {
    // There is no separate user-defined ST system/jailbreak prompt in this app.
    const content = text(data[key]).replace(/\{\{\s*original\s*\}\}/gi, '')
    return content.trim() ? `${label}：\n${content.trim()}` : ''
  }).filter(Boolean).join('\n\n')
  return {
    name,
    prompt,
    firstMessage: text(data.first_mes),
    alternateGreetings: stringList(data.alternate_greetings),
    creatorNotes: text(data.creator_notes),
    lorebook: data.character_book == null ? null : normalizeSTCharacterBook(data.character_book, name),
    referencedLorebook: text(data.extensions?.world),
    metadata: {
      source: 'sillytavern',
      spec: payload.spec || 'chara_card_v1',
      specVersion: text(payload.spec_version),
      creator: text(data.creator),
      characterVersion: text(data.character_version),
      creatorNotes: text(data.creator_notes),
      tags: stringList(data.tags),
      firstMessage: text(data.first_mes),
      alternateGreetings: stringList(data.alternate_greetings),
      extensions: isObject(data.extensions) ? { ...data.extensions } : {}
    }
  }
}

export async function readSTCharacterCardFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('请选择 PNG 或 JSON 角色卡')
  if (file.size > MAX_CARD_BYTES) throw new Error('角色卡文件过大，请选择 50 MB 以内的文件')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const png = isPng(bytes)
  if (!png && !/\.json$/i.test(file.name || '') && file.type !== 'application/json') {
    throw new Error('请选择 PNG 或 JSON 角色卡')
  }
  const payload = png ? extractSTCharacterCardFromPng(bytes) : parseJson(new TextDecoder().decode(bytes))
  return { ...normalizeSTCharacterCard(payload), hasAvatar: png }
}

export function createSTCharacterCardContactData(card, { greeting = card.firstMessage, charName = card.name, userName = '用户' } = {}) {
  const content = applyTemplateVars(greeting, { char: charName, user: userName })
  return {
    stCharacterCard: { ...card.metadata },
    msgs: content.trim() ? [{ id: makeId('msg'), role: 'assistant', content, time: Date.now() }] : []
  }
}
