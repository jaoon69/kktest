import { evaluate } from './expr'

const MAX_STATE_CHARS = 20000
const IDENT_REGEX = /^[\p{L}_$][\p{L}\p{N}_$]*$/u

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** 深拷贝成纯 JSON 数据（去掉响应式代理、函数与循环引用）。 */
export function cloneStateData(value) {
  try {
    const text = JSON.stringify(value ?? {})
    if (!text || text.length > MAX_STATE_CHARS) return null
    const parsed = JSON.parse(text)
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** 由根标签 state 属性得到初始状态。 */
export function createInitialState(stateSource) {
  const source = String(stateSource ?? '').trim()
  if (!source) return {}
  const value = evaluate(source.replace(/^\{\{([\s\S]*)\}\}$/, '{$1}'), { state: {} }, null)
  return cloneStateData(isPlainObject(value) ? value : {}) || {}
}

/** 序列化为表达式引擎能读回的对象字面量（单引号字符串，适合放进属性）。 */
export function stateToLiteral(value, depth = 0) {
  if (depth > 6) return 'null'
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
  if (Array.isArray(value)) return `[${value.map(item => stateToLiteral(item, depth + 1)).join(', ')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => {
      const safeKey = IDENT_REGEX.test(key) ? key : `'${key.replace(/'/g, "\\'")}'`
      return `${safeKey}: ${stateToLiteral(item, depth + 1)}`
    })
    return `{${entries.join(', ')}}`
  }
  return 'null'
}

export function readSavedSmartUIState(message, partIndex) {
  const states = message?.uiStates
  if (!states || typeof states !== 'object') return null
  const saved = states[String(partIndex)]
  return isPlainObject(saved) ? saved : null
}
