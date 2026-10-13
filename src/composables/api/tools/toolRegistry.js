/**
 * Tool registry: filters available tools by settings and returns OpenAI-format arrays.
 */
import TOOL_DEFINITIONS from './toolDefinitions'

// 上限只作为 prompt 体积的保险丝：内置工具最多 6 个，其余留给 MCP 工具。
// intent 模式下 selectToolsForIntent 还会按意图收敛到更小的集合。
const MAX_TOOLS = 32

const executorMap = new Map()
TOOL_DEFINITIONS.forEach(t => executorMap.set(t.name, t.execute))

/**
 * Return the OpenAI-compatible `tools` array for the current settings/contact.
 * @param {object} settingsStore - Pinia settings store instance
 * @param {object} [contact] - active chat contact (unused for now, reserved for per-contact overrides)
 * @param {object[]} [extraTools] - additional tool definitions (e.g. from MCP)
 * @returns {Array<{type:string, function:object}>}
 */
export function getAvailableTools(settingsStore, contact, extraTools = []) {
  const tools = []

  for (const def of TOOL_DEFINITIONS) {
    // Settings guard: skip if the required setting is falsy
    if (typeof def.settingsGuard === 'function') {
      if (!def.settingsGuard(settingsStore)) continue
    } else if (def.settingsGuard && !settingsStore[def.settingsGuard]) continue

    tools.push({
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: def.parameters
      }
    })
  }

  // Append any MCP or external tools
  for (const ext of extraTools) {
    tools.push({
      type: 'function',
      function: {
        name: ext.name,
        description: ext.description,
        parameters: ext.parameters || { type: 'object', properties: {} }
      }
    })
  }

  if (tools.length > MAX_TOOLS) {
    const removed = tools.length - MAX_TOOLS
    tools.length = MAX_TOOLS
    console.warn(`[ToolRegistry] Truncated ${removed} tools (total exceeded ${MAX_TOOLS})`)
  }

  return tools
}

/**
 * Look up the execute function for a tool by name.
 * @param {string} name
 * @returns {Function|null}
 */
export function getToolExecutor(name) {
  return executorMap.get(name) || null
}

/**
 * Get the full definition for a tool by name.
 * @param {string} name
 * @returns {object|undefined}
 */
export function getToolDefinition(name) {
  return TOOL_DEFINITIONS.find(t => t.name === name)
}
