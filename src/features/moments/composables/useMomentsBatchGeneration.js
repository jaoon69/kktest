import { ref } from 'vue'
import { stripOuterCodeFence } from '../utils/aiGeneration'
import { extractMomentMedia } from '../../../utils/momentMedia'
import { applyOptionalMaxTokens } from '../../../composables/api/chatCompletions'
import { fetchProviderChat, extractProviderNonStreamText } from '../../../composables/api/providerRequest'
import { getTimePeriodLabel } from '../../../composables/liveness/eventTypes'

const TOPIC_SEEDS = [
  '日常生活的小片段', '刚刚发生的一件小事', '最近的心情', '吃到/喝到的东西',
  '看到的风景或天气', '一个小小的吐槽', '最近在追/在玩/在看的东西', '突然的感悟或碎碎念',
  '今天做的一件事', '一个小愿望或小计划'
]

function shuffle(list) {
  const arr = [...list]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function pickRandom(list) {
  return list[Math.floor(Math.random() * list.length)]
}

export function useMomentsBatchGeneration({
  configsStore,
  forumContacts,
  momentsStore,
  settingsStore,
  scheduleSave,
  createAIReply
}) {
  const batchGenerating = ref(false)
  const batchProgressText = ref('')

  async function requestCompletion(cfg, systemPrompt, userPrompt, maxTokens = 500) {
    const body = {
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    }
    applyOptionalMaxTokens(body, cfg?.maxTokens, maxTokens)
    const { response: response } = await fetchProviderChat(cfg, body)
    if (!response.ok) throw new Error('API 请求失败')
    const data = await response.json()
    return extractProviderNonStreamText(cfg, data)
  }

  function buildBatchPostPrompt(contact) {
    const topic = pickRandom(TOPIC_SEEDS)
    const period = getTimePeriodLabel()
    const mediaHints = []
    if (settingsStore?.allowAIImageGeneration) {
      mediaHints.push('如果这条动态适合配图，可以在正文中插入一个 [图:英文生图标签,逗号分隔]（例如 [图:latte art, cafe, cozy]）')
    }
    if (settingsStore?.allowAIVoice) {
      mediaHints.push('如果更想用语音表达，可以插入一个 [语音:要说的话]')
    }
    const mediaBlock = mediaHints.length
      ? `\n${mediaHints.join('；')}。注意：大约三成的动态带媒体即可，其余保持纯文字。`
      : ''

    return `现在是${period}。请以你的身份写一条朋友圈动态，主题方向：${topic}（可自由发挥，贴合你的人设与生活）。

要求：
- 直接输出动态正文，简短自然（一两句话到一小段），像真人发朋友圈
- 不要加标题、引号、代码块，不要输出解释
- 可以在正文末尾加 ":emoji" 表示心情（如 "今天超顺利:😊"），也可以不加${mediaBlock}`
  }

  // 熟人分组过滤：作者未分组视作公开，任何角色都可互动
  function eligibleCommenters(authorId) {
    const authorGroup = momentsStore.getContactGroupId?.(authorId) || ''
    return forumContacts.value.filter(c => {
      if (c.id === authorId) return false
      if (!authorGroup) return true
      return momentsStore.areContactsAcquainted(c.id, authorId)
    })
  }

  async function generateOnePost(contact, index, total) {
    const cfg = configsStore.configs.find(c => c.id === contact.configId) || configsStore.getConfig
    if (!cfg?.key) return null

    batchProgressText.value = `生成动态 ${index + 1}/${total} · ${contact.name}`
    const systemPrompt = contact.prompt || `你是${contact.name}。`
    const raw = await requestCompletion(cfg, systemPrompt, buildBatchPostPrompt(contact), 500)
    const media = extractMomentMedia(stripOuterCodeFence(raw), {
      allowImages: !!settingsStore?.allowAIImageGeneration,
      allowVoice: !!settingsStore?.allowAIVoice
    })
    if (!media.text && !media.imageTags.length && !media.voiceText) return null

    // 发帖时间随机回退 0-3 小时，让信息流更像真实时间线
    const jitterMs = Math.floor(Math.random() * 3 * 60 * 60 * 1000)
    const moment = momentsStore.addMoment({
      content: media.text,
      mood: media.mood || null,
      imageTags: media.imageTags,
      voiceText: media.voiceText,
      voiceEmotion: media.voiceEmotion,
      voiceDuration: media.voiceDuration,
      time: Date.now() - jitterMs,
      authorId: contact.id,
      authorName: contact.name,
      authorAvatar: contact.avatar
    })
    if (moment) scheduleSave?.()
    return moment
  }

  async function addLiveliness(moment, author, index, total) {
    if (!moment) return
    const candidates = shuffle(eligibleCommenters(author.id))

    // 0-2 条评论（LLM）
    const commentCount = Math.floor(Math.random() * 3)
    for (let i = 0; i < Math.min(commentCount, candidates.length); i += 1) {
      const commenter = candidates[i]
      batchProgressText.value = `生成互动 ${index + 1}/${total} · ${commenter.name} 评论中`
      try {
        await createAIReply(moment, commenter, {
          progressText: batchProgressText.value,
          vibeHint: '氛围：中立自然，像真实朋友圈评论区。',
          extraHint: ''
        })
      } catch (error) {
        console.warn('[moments-batch] comment failed', error)
      }
    }

    // 0-3 个点赞（零成本）
    const likeCount = Math.floor(Math.random() * 4)
    shuffle(candidates).slice(0, likeCount).forEach(liker => {
      momentsStore.likeMomentBy(moment.id, liker.id)
    })
    scheduleSave?.()
  }

  async function generateBatchMoments({ count = 5 } = {}) {
    if (batchGenerating.value) return
    const pool = shuffle(forumContacts.value.filter(c => {
      const cfg = configsStore.configs.find(x => x.id === c.configId) || configsStore.getConfig
      return !!cfg?.key
    }))
    if (pool.length === 0) return

    const authors = pool.slice(0, Math.min(count, pool.length))
    batchGenerating.value = true
    let created = 0
    try {
      const moments = []
      for (let i = 0; i < authors.length; i += 1) {
        try {
          const moment = await generateOnePost(authors[i], i, authors.length)
          if (moment) {
            moments.push({ moment, author: authors[i] })
            created += 1
          }
        } catch (error) {
          console.warn('[moments-batch] post failed', authors[i]?.name, error)
        }
      }
      for (let i = 0; i < moments.length; i += 1) {
        await addLiveliness(moments[i].moment, moments[i].author, i, moments.length)
      }
    } finally {
      batchGenerating.value = false
      batchProgressText.value = ''
    }
    return created
  }

  return {
    batchGenerating,
    batchProgressText,
    generateBatchMoments
  }
}
