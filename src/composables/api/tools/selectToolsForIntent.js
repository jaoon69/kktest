const INTENT_RULES = [
  {
    keywords: ['记住', '别忘', '以后记得', '帮我记', 'remember'],
    toolNames: ['add_memory']
  },
  {
    keywords: ['日记', '写日记', '记进日记', '补记日记', 'diary'],
    toolNames: ['write_diary']
  },
  {
    keywords: ['提醒', '日程', '安排', '待办', 'remind', 'schedule', 'todo'],
    toolNames: ['create_event']
  },
  {
    keywords: ['心情', '情绪', '精力', 'mood', 'energy'],
    toolNames: ['update_mood']
  },
  {
    keywords: ['搜索', '搜一下', '搜搜', '查一下', '查查', '上网', '联网', '百度', '谷歌', 'google', 'search', '最新', '新闻', '热搜', '实时', '官网'],
    toolNames: ['web_search', 'web_scrape']
  },
  {
    keywords: ['http://', 'https://', 'www.', '网页', '网址', '链接', 'scrape', 'url'],
    patterns: [/\b[a-z0-9-]+\.(?:com|cn|org|net|io|dev|ai|me|co|app|site|wiki)(?:\/|\b)/i],
    toolNames: ['web_scrape']
  }
]

const MCP_INTENT_RULES = [
  { keywords: ['notion', '搜文档', '查文档', '工作区'], prefixes: ['mcp_notion_'] },
  {
    keywords: ['firecrawl', '网页', '网站', '搜索', '搜一下', '抓取', '爬取', 'scrape', 'crawl', 'web search', 'fetch url'],
    prefixes: ['mcp_firecrawl_'],
    toolHints: ['firecrawl', 'web', 'url', 'scrape', 'crawl', '网页', '网站']
  }
]

function toolMatchesMcpRule(tool, rule) {
  const name = String(tool?.function?.name || '').toLowerCase()
  if (!name.startsWith('mcp_')) return false

  if ((rule.prefixes || []).some((prefix) => name.startsWith(prefix))) return true

  const metadata = `${name} ${String(tool?.function?.description || '').toLowerCase()}`
  return (rule.toolHints || []).some((hint) => metadata.includes(hint))
}

export function selectToolsForIntent(userMessage, allTools) {
  if (!userMessage || !Array.isArray(allTools) || allTools.length === 0) return []

  const text = String(userMessage).toLowerCase()
  const matchedNames = new Set()

  INTENT_RULES.forEach((rule) => {
    const matched = rule.keywords.some((keyword) => text.includes(keyword))
      || (rule.patterns || []).some((pattern) => pattern.test(text))
    if (matched) {
      rule.toolNames.forEach((name) => matchedNames.add(name))
    }
  })

  const matchedMcpRules = MCP_INTENT_RULES
    .filter((rule) => rule.keywords.some((keyword) => text.includes(keyword)))

  return allTools
    .filter((tool) => {
      const name = tool?.function?.name
      if (!name) return false
      return matchedNames.has(name) || matchedMcpRules.some((rule) => toolMatchesMcpRule(tool, rule))
    })
    .slice(0, 5)
}
