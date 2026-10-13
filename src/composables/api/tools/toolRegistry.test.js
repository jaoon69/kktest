import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAvailableTools } from './toolRegistry'

describe('toolRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('only exposes后台型工具，不替换现有可见 token 能力', () => {
    const tools = getAvailableTools({
      allowPlannerAI: true,
      allowLivenessEngine: true,
      allowAIStickers: true,
      allowAIImageGeneration: true,
      allowAIMusicRecommend: true,
      syncForumToAI: true
    })

    expect(tools.map((tool) => tool.function.name)).toEqual([
      'create_event',
      'write_diary',
      'add_memory',
      'update_mood'
    ])
  })

  it('caps total tools while preserving built-in tool priority', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const extraTools = Array.from({ length: 40 }, (_, index) => ({
      name: `mcp_docs_tool_${index}`,
      description: `MCP tool ${index}`,
      parameters: { type: 'object', properties: {} }
    }))

    const tools = getAvailableTools({
      allowPlannerAI: true,
      allowLivenessEngine: true
    }, null, extraTools)

    expect(tools).toHaveLength(32)
    expect(tools.map((tool) => tool.function.name).slice(0, 4)).toEqual([
      'create_event',
      'write_diary',
      'add_memory',
      'update_mood'
    ])
    // 28 MCP slots remain after the 4 built-ins
    expect(tools[4].function.name).toBe('mcp_docs_tool_0')
    expect(tools[31].function.name).toBe('mcp_docs_tool_27')
    expect(warnSpy).toHaveBeenCalledWith('[ToolRegistry] Truncated 12 tools (total exceeded 32)')
  })

  it('keeps a realistic MCP server tool set intact (no silent truncation)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const extraTools = Array.from({ length: 18 }, (_, index) => ({
      name: `mcp_notion_tool_${index}`,
      description: `Notion tool ${index}`,
      parameters: { type: 'object', properties: {} }
    }))

    const tools = getAvailableTools({
      allowPlannerAI: true,
      allowLivenessEngine: true
    }, null, extraTools)

    expect(tools).toHaveLength(22)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('exposes web search tools only when enabled with at least one API key', () => {
    const names = (webSearch) => getAvailableTools({ toolCallingConfig: { webSearch } })
      .map((tool) => tool.function.name)

    expect(names({ enabled: true, apiKeys: {} })).not.toContain('web_search')
    expect(names({ enabled: false, apiKeys: { tavily: 'k' } })).not.toContain('web_search')
    expect(names({ enabled: true, apiKeys: { firecrawl: 'k' } })).toEqual(['add_memory', 'web_search', 'web_scrape'])
  })
})
