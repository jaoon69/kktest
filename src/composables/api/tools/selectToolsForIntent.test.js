import { describe, expect, it } from 'vitest'
import { selectToolsForIntent } from './selectToolsForIntent'

function tool(name, description = name) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties: {} }
    }
  }
}

const ALL_TOOLS = [
  tool('add_memory'),
  tool('write_diary'),
  tool('create_event'),
  tool('update_mood'),
  tool('mcp_notion_search'),
  tool('mcp_notion_fetch'),
  tool('mcp_docs_search'),
  tool('mcp_firecrawl_search'),
  tool('mcp_firecrawl_scrape')
]

describe('selectToolsForIntent', () => {
  it('returns an empty list for empty messages', () => {
    expect(selectToolsForIntent('', ALL_TOOLS)).toEqual([])
  })

  it('returns an empty list for ordinary chat messages', () => {
    expect(selectToolsForIntent('你好', ALL_TOOLS)).toEqual([])
    expect(selectToolsForIntent('今天天气好', ALL_TOOLS)).toEqual([])
  })

  it('selects add_memory for remember intent', () => {
    expect(selectToolsForIntent('记住我喜欢乌龙茶', ALL_TOOLS).map(t => t.function.name)).toEqual(['add_memory'])
  })

  it('selects write_diary for diary intent', () => {
    expect(selectToolsForIntent('帮我写日记', ALL_TOOLS).map(t => t.function.name)).toEqual(['write_diary'])
  })

  it('selects create_event for reminder intent', () => {
    expect(selectToolsForIntent('明天提醒我交材料', ALL_TOOLS).map(t => t.function.name)).toEqual(['create_event'])
  })

  it('selects multiple intents but caps the result at five tools', () => {
    const selected = selectToolsForIntent('记住这件事，写日记，安排提醒，还要记录心情，notion 搜文档', ALL_TOOLS)
      .map(t => t.function.name)

    expect(selected).toEqual([
      'add_memory',
      'write_diary',
      'create_event',
      'update_mood',
      'mcp_notion_search'
    ])
  })

  it('returns an empty list when the tool list is empty', () => {
    expect(selectToolsForIntent('记住这件事', [])).toEqual([])
  })

  it('selects notion MCP tools only for notion intent', () => {
    expect(selectToolsForIntent('帮我查工作区里的文档', ALL_TOOLS).map(t => t.function.name)).toEqual([
      'mcp_notion_search',
      'mcp_notion_fetch'
    ])
  })

  it('selects Firecrawl MCP tools for web search and scraping intent', () => {
    expect(selectToolsForIntent('帮我用 Firecrawl 搜一下这个网页资料', ALL_TOOLS).map(t => t.function.name)).toEqual([
      'mcp_firecrawl_search',
      'mcp_firecrawl_scrape'
    ])
  })

  it('selects web MCP tools by metadata when the server name is customized', () => {
    const customNamedTools = [
      tool('mcp_remote_lookup_search', 'Search the web for current pages'),
      tool('mcp_remote_lookup_scrape_url', 'Scrape a URL and return clean markdown'),
      tool('mcp_remote_docs_search', 'Search private docs')
    ]

    expect(selectToolsForIntent('帮我搜索这个网站资料', customNamedTools).map(t => t.function.name)).toEqual([
      'mcp_remote_lookup_search',
      'mcp_remote_lookup_scrape_url'
    ])
  })

  it('selects built-in web search tools for search intent and urls', () => {
    const tools = [...ALL_TOOLS.slice(0, 4), tool('web_search'), tool('web_scrape')]
    expect(selectToolsForIntent('帮我查一下最新的新闻', tools).map(t => t.function.name)).toEqual([
      'web_search',
      'web_scrape'
    ])
    expect(selectToolsForIntent('看看这个 https://vuejs.org/guide', tools).map(t => t.function.name)).toEqual(['web_scrape'])
    expect(selectToolsForIntent('github.com/vuejs/core 这个仓库讲了啥', tools).map(t => t.function.name)).toEqual(['web_scrape'])
    expect(selectToolsForIntent('今天天气好', tools)).toEqual([])
  })
})
