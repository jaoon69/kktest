/**
 * Internal tool definitions registry.
 *
 * Each tool has:
 *   name            — OpenAI function name
 *   description     — shown to the model
 *   parameters      — JSON Schema for arguments
 *   settingsGuard   — settings boolean key, or (settingsStore) => boolean; tool is excluded when falsy
 *   displayName     — optional short label for tool log cards (defaults to description)
 *   execute(args, ctx) — handler returning { success, result?, error? }
 *
 * ctx contains: { contactsStore, settingsStore, momentsStore, musicStore,
 *   plannerStore, livenessStore, stickersStore, activeChat, makeMsgId }
 */
import { getWebSearchConfig, isWebSearchAvailable } from '../../../utils/webSearchConfig'

const DIARY_ASSISTANT_VIEWPOINT_PATTERNS = [
  /作为\s*(?:ai|人工智能|助手)/i,
  /我是\s*(?:ai|人工智能|助手)/i,
  /\b(?:as an ai|as your ai|as a chatbot|as an assistant)\b/i,
  /\buser\b/i,
  /用户/
]

function normalizeDiaryText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

function looksLikeAssistantViewDiary(content) {
  const text = normalizeDiaryText(content)
  if (!text) return false
  return DIARY_ASSISTANT_VIEWPOINT_PATTERNS.some(pattern => pattern.test(text))
}

const TOOL_DEFINITIONS = [
  // ── 日程 / 记忆 / 内部状态 ──
  {
    name: 'create_event',
    description: '创建日程事件或任务提醒',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '事件标题' },
        description: { type: 'string', description: '详细描述，可选' },
        category: { type: 'string', enum: ['work', 'personal', 'ideas'], description: '分类' },
        start_date: { type: 'string', description: 'YYYY-MM-DD 格式日期' },
        start_time: { type: 'string', description: 'HH:MM 格式时间，可选' }
      },
      required: ['title', 'start_date']
    },
    settingsGuard: 'allowPlannerAI',
    async execute(args, ctx) {
      const { plannerStore } = ctx
      const evt = plannerStore.addEvent({
        title: args.title,
        description: args.description || '',
        category: args.category || 'personal',
        kind: 'todo',
        startDate: args.start_date,
        startTime: args.start_time || ''
      })
      return { success: true, result: { eventId: evt.id } }
    }
  },

  // ── 日记 ──
  {
    name: 'write_diary',
    description: '写一篇“用户本人”的日记条目。仅在用户明确要求写/补记日记，或明确表示要把经历记进日记时调用；正文必须用用户自己的视角记录经历和感受，不能写成 AI/角色视角。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '日记正文，必须以用户第一人称记录用户自己的经历、感受或想法，不能写成 AI/角色视角' },
        mood: { type: 'string', description: '心情 emoji，可选' }
      },
      required: ['content']
    },
    settingsGuard: 'allowPlannerAI',
    async execute(args, ctx) {
      const { plannerStore, activeChat } = ctx
      const content = normalizeDiaryText(args.content)
      if (!content) {
        return { success: false, error: 'Diary content cannot be empty' }
      }
      if (looksLikeAssistantViewDiary(content)) {
        return { success: false, error: '日记必须以用户视角记录，不能使用AI或角色视角' }
      }
      const entry = plannerStore.addDiaryEntry({
        content,
        mood: normalizeDiaryText(args.mood),
        shareWithAI: true,
        source: 'assistant',
        sourceChatId: activeChat?.id || '',
        sourceContactId: activeChat?.id || ''
      })
      return { success: true, result: { diaryId: entry.id } }
    }
  },

  // ── 记忆 ──
  {
    name: 'add_memory',
    description: '记住一条关于用户的重要信息（存入核心记忆）',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记住的信息' },
        category: { type: 'string', description: '分类标签，如"喜好""经历"等，可选' }
      },
      required: ['content']
    },
    settingsGuard: null,
    async execute(args, ctx) {
      const { activeChat } = ctx
      const { addCoreMemory } = await import('../../memory/coreMemory')
      const mem = addCoreMemory(activeChat, args.content, 'tool_call', {
        category: args.category || ''
      })
      return { success: !!mem, result: mem ? { memoryId: mem.id } : null }
    }
  },

  // ── 情绪更新 ──
  {
    name: 'update_mood',
    description: '更新角色当前的情绪状态（对用户不可见）',
    parameters: {
      type: 'object',
      properties: {
        mood: { type: 'number', description: '情绪值 0-1，0=低落 1=开心' },
        energy: { type: 'number', description: '精力值 0-1' },
        affection: { type: 'number', description: '亲密度 0-1' }
      },
      required: ['mood']
    },
    settingsGuard: 'allowLivenessEngine',
    async execute(args, ctx) {
      const { livenessStore, activeChat } = ctx
      const patch = {}
      if (typeof args.mood === 'number') patch.mood = args.mood
      if (typeof args.energy === 'number') patch.energy = args.energy
      if (typeof args.affection === 'number') patch.affection = args.affection
      livenessStore.adjustState(activeChat.id, patch)
      return { success: true, result: { updated: Object.keys(patch) } }
    }
  },

  // ── 联网搜索 ──
  {
    name: 'web_search',
    displayName: '联网搜索',
    description: '联网搜索最新信息（新闻、实时数据、你不确定或可能过时的事实）。返回标题、链接和摘要；相同搜索会自动走缓存。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，尽量简洁具体' },
        max_results: { type: 'integer', description: '返回条数 1-10，可选，默认按设置' },
        topic: { type: 'string', enum: ['general', 'news'], description: '新闻类问题用 news，可选' },
        time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: '只看最近一段时间的结果，可选' }
      },
      required: ['query']
    },
    settingsGuard: (settingsStore) => isWebSearchAvailable(settingsStore, 'search'),
    async execute(args, ctx) {
      const { getWebSearchService } = await import('../../webSearch/webSearchService')
      const { formatSearchResultText } = await import('../../webSearch/formatResults')
      const result = await getWebSearchService().search(getWebSearchConfig(ctx.settingsStore), {
        query: args.query,
        maxResults: args.max_results,
        topic: args.topic,
        timeRange: args.time_range
      })
      return {
        success: true,
        result: { text: formatSearchResultText(result), provider: result.provider, cached: result.cached }
      }
    }
  },
  {
    name: 'web_scrape',
    displayName: '读取网页',
    description: '读取一个网页的正文（Markdown）。用于用户发来链接，或需要查看搜索结果详情时；长页面可传 offset 分段读取，已读过的网页会走缓存。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '完整网址（http/https）' },
        offset: { type: 'integer', description: '从第几个字符开始读，用于续读长网页，可选' }
      },
      required: ['url']
    },
    settingsGuard: (settingsStore) => isWebSearchAvailable(settingsStore, 'scrape'),
    async execute(args, ctx) {
      const { getWebSearchService } = await import('../../webSearch/webSearchService')
      const { formatScrapeResultText } = await import('../../webSearch/formatResults')
      const config = getWebSearchConfig(ctx.settingsStore)
      const result = await getWebSearchService().scrape(config, { url: args.url })
      return {
        success: true,
        result: {
          text: formatScrapeResultText(result, { offset: args.offset, maxChars: config.scrapeMaxChars }),
          provider: result.provider,
          cached: result.cached
        }
      }
    }
  }
]

export default TOOL_DEFINITIONS
