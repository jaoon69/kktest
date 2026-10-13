import { describe, expect, it } from 'vitest'
import { clearContactMemoryData, getEmbeddingConfig } from './shared'

describe('getEmbeddingConfig', () => {
  it('uses the global API connection while keeping the vector toggle per contact', () => {
    const contact = {
      memorySettings: {
        vectorSearchEnabled: true,
        embeddingApiUrl: 'https://legacy.example.com/v1',
        embeddingApiKey: 'legacy-key',
        embeddingModel: 'legacy-model'
      }
    }
    const globalSettings = {
      embeddingApiUrl: ' https://embedding.example.com/v1 ',
      embeddingApiKey: ' global-key ',
      embeddingModel: ' embed-v3 ',
      embeddingDimensions: 1024
    }

    expect(getEmbeddingConfig(contact, globalSettings)).toEqual({
      url: 'https://embedding.example.com/v1',
      key: 'global-key',
      model: 'embed-v3',
      dimensions: 1024
    })

    contact.memorySettings.vectorSearchEnabled = false
    expect(getEmbeddingConfig(contact, globalSettings)).toBeNull()
  })
})

describe('clearContactMemoryData', () => {
  it('clears every memory layer without deleting chat messages', () => {
    const contact = {
      msgs: [
        { id: 'm1', role: 'user', content: '我喜欢草莓', time: 100 },
        { id: 'm2', role: 'assistant', content: '我记住了', time: 200 }
      ],
      memory: {
        core: [{ id: 'core_1', content: '用户喜欢草莓' }],
        longTerm: [{ id: 'long_1', content: '聊过草莓' }],
        shortTerm: [{ id: 'short_1', content: '用户提到草莓' }],
        contextSummary: { content: '用户喜欢草莓' },
        momentsSummary: { content: '动态摘要' }
      }
    }

    const originalMessages = contact.msgs
    clearContactMemoryData(contact)

    expect(contact.memory.core).toEqual([])
    expect(contact.memory.longTerm).toEqual([])
    expect(contact.memory.shortTerm).toEqual([])
    expect(contact.memory.contextSummary).toBeNull()
    expect(contact.memory.momentsSummary).toBeNull()
    expect(contact.memory.lastSummaryMsgId).toBe('m2')
    expect(contact.memory.lastAIMemoryMsgId).toBe('m2')
    expect(contact.msgs).toBe(originalMessages)
    expect(contact.msgs).toHaveLength(2)
  })
})
