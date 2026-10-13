/**
 * 智能界面（<ui>）的安全表达式引擎。
 *
 * 只解释一个很小的 JS 子集：字面量、运算符、三元、成员访问、白名单函数、箭头函数、赋值语句。
 * 不使用 eval / Function，只能读写传入的纯数据（state 与循环变量），无法触达全局对象或原型链。
 */

const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor', '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__'])
const MAX_STEPS = 60000
const MAX_ARRAY = 1000
const MAX_STRING = 4000
const AST_CACHE_LIMIT = 3000

const PUNCTUATORS = [
  '===', '!==', '**=', '...',
  '==', '!=', '<=', '>=', '&&', '||', '??', '**', '+=', '-=', '*=', '/=', '%=', '=>', '?.',
  '+', '-', '*', '/', '%', '<', '>', '!', '=', '?', ':', '.', ',', '(', ')', '[', ']', '{', '}', ';'
]

const IDENT_START = /[\p{L}_$]/u
const IDENT_PART = /[\p{L}\p{N}_$]/u

export class SmartUIExprError extends Error {}

function tokenize(source) {
  const src = String(source ?? '')
  const tokens = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) { i += 1; continue }

    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const match = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))
      tokens.push({ t: 'num', v: Number(match[0]) })
      i += match[0].length
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      let out = ''
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const next = src[j + 1]
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next
          j += 2
          continue
        }
        out += src[j]
        j += 1
      }
      if (j >= src.length) throw new SmartUIExprError('unterminated string')
      tokens.push({ t: 'str', v: out })
      i = j + 1
      continue
    }

    if (IDENT_START.test(ch)) {
      let j = i + 1
      while (j < src.length && IDENT_PART.test(src[j])) j += 1
      tokens.push({ t: 'id', v: src.slice(i, j) })
      i = j
      continue
    }

    const punct = PUNCTUATORS.find(p => src.startsWith(p, i))
    if (!punct) throw new SmartUIExprError(`unexpected "${ch}"`)
    tokens.push({ t: 'p', v: punct })
    i += punct.length
  }
  tokens.push({ t: 'eof' })
  return tokens
}

const BINARY_PRECEDENCE = {
  '??': 1, '||': 1,
  '&&': 2,
  '==': 3, '!=': 3, '===': 3, '!==': 3,
  '<': 4, '>': 4, '<=': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
  '**': 7
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**='])

function createParser(tokens) {
  let pos = 0
  const peek = (offset = 0) => tokens[pos + offset]
  const next = () => tokens[pos++]
  const isP = (v, offset = 0) => peek(offset).t === 'p' && peek(offset).v === v
  const expectP = (v) => {
    if (!isP(v)) throw new SmartUIExprError(`expected "${v}"`)
    return next()
  }

  function isArrowAhead() {
    if (peek().t === 'id' && isP('=>', 1)) return true
    if (!isP('(')) return false
    let k = 1
    if (isP(')', k)) return isP('=>', k + 1)
    while (peek(k).t === 'id') {
      k += 1
      if (isP(')', k)) return isP('=>', k + 1)
      if (!isP(',', k)) return false
      k += 1
    }
    return false
  }

  function parseArrow() {
    const params = []
    if (peek().t === 'id') {
      params.push(next().v)
    } else {
      expectP('(')
      while (!isP(')')) {
        params.push(next().v)
        if (isP(',')) next()
      }
      expectP(')')
    }
    expectP('=>')
    return { k: 'fn', params, body: parseExpression() }
  }

  function parsePrimary() {
    const tok = peek()
    if (isArrowAhead()) return parseArrow()
    if (tok.t === 'num') { next(); return { k: 'lit', v: tok.v } }
    if (tok.t === 'str') { next(); return { k: 'lit', v: tok.v } }
    if (tok.t === 'id') {
      next()
      if (tok.v === 'true') return { k: 'lit', v: true }
      if (tok.v === 'false') return { k: 'lit', v: false }
      if (tok.v === 'null') return { k: 'lit', v: null }
      if (tok.v === 'undefined') return { k: 'lit', v: undefined }
      return { k: 'id', name: tok.v }
    }
    if (isP('(')) {
      next()
      const inner = parseExpression()
      expectP(')')
      return inner
    }
    if (isP('[')) {
      next()
      const items = []
      while (!isP(']')) {
        items.push(parseExpression())
        if (isP(',')) next()
        else break
      }
      expectP(']')
      return { k: 'arr', items }
    }
    if (isP('{')) {
      next()
      const entries = []
      while (!isP('}')) {
        const keyTok = next()
        let key
        if (keyTok.t === 'id' || keyTok.t === 'str') key = String(keyTok.v)
        else if (keyTok.t === 'num') key = String(keyTok.v)
        else throw new SmartUIExprError('bad object key')
        if (isP(':')) {
          next()
          entries.push([key, parseExpression()])
        } else {
          entries.push([key, { k: 'id', name: key }])
        }
        if (isP(',')) next()
        else break
      }
      expectP('}')
      return { k: 'obj', entries }
    }
    throw new SmartUIExprError('unexpected token')
  }

  function parsePostfix() {
    let node = parsePrimary()
    for (;;) {
      if (isP('.') || isP('?.')) {
        next()
        const prop = next()
        if (prop.t !== 'id') throw new SmartUIExprError('bad property')
        node = { k: 'mem', obj: node, prop: { k: 'lit', v: prop.v } }
      } else if (isP('[')) {
        next()
        const prop = parseExpression()
        expectP(']')
        node = { k: 'mem', obj: node, prop }
      } else if (isP('(')) {
        next()
        const args = []
        while (!isP(')')) {
          args.push(parseExpression())
          if (isP(',')) next()
          else break
        }
        expectP(')')
        if (node.k === 'id') {
          node = { k: 'call', name: node.name, args }
        } else if (node.k === 'mem' && node.prop.k === 'lit' && typeof node.prop.v === 'string') {
          // 兼容模型写的 arr.includes(x) / list.map(fn) 这类方法调用，转成同名白名单函数
          node = { k: 'call', name: node.prop.v, args: [node.obj, ...args] }
        } else {
          throw new SmartUIExprError('bad call')
        }
      } else {
        return node
      }
    }
  }

  function parseUnary() {
    if (isP('!') || isP('-') || isP('+')) {
      const op = next().v
      return { k: 'un', op, arg: parseUnary() }
    }
    return parsePostfix()
  }

  function parseBinary(minPrec) {
    let left = parseUnary()
    for (;;) {
      const tok = peek()
      const prec = tok.t === 'p' ? BINARY_PRECEDENCE[tok.v] : undefined
      if (!prec || prec < minPrec) return left
      next()
      const right = tok.v === '**' ? parseBinary(prec) : parseBinary(prec + 1)
      left = { k: 'bin', op: tok.v, left, right }
    }
  }

  function parseExpression() {
    const test = parseBinary(1)
    if (isP('?')) {
      next()
      const yes = parseExpression()
      expectP(':')
      const no = parseExpression()
      return { k: 'cond', test, yes, no }
    }
    return test
  }

  function parseStatement() {
    const target = parseExpression()
    if (peek().t === 'p' && ASSIGN_OPS.has(peek().v)) {
      if (target.k !== 'id' && target.k !== 'mem') throw new SmartUIExprError('bad assignment target')
      const op = next().v
      return { k: 'assign', op, target, value: parseExpression() }
    }
    return target
  }

  function parseProgram() {
    const statements = []
    while (peek().t !== 'eof') {
      if (isP(';')) { next(); continue }
      statements.push(parseStatement())
      if (!isP(';') && peek().t !== 'eof') throw new SmartUIExprError('unexpected token after statement')
    }
    return { k: 'prog', statements }
  }

  return {
    expression() {
      const node = parseExpression()
      if (peek().t !== 'eof') throw new SmartUIExprError('unexpected trailing token')
      return node
    },
    program: parseProgram
  }
}

const astCache = new Map()

function cached(kind, source, build) {
  const key = kind + '\u0000' + source
  if (astCache.has(key)) {
    const hit = astCache.get(key)
    if (hit instanceof Error) throw hit
    return hit
  }
  let result
  try {
    result = build()
  } catch (error) {
    result = error instanceof Error ? error : new SmartUIExprError(String(error))
  }
  if (astCache.size >= AST_CACHE_LIMIT) {
    astCache.delete(astCache.keys().next().value)
  }
  astCache.set(key, result)
  if (result instanceof Error) throw result
  return result
}

export function parseExpression(source) {
  return cached('e', String(source ?? ''), () => createParser(tokenize(source)).expression())
}

export function parseProgram(source) {
  return cached('p', String(source ?? ''), () => createParser(tokenize(source)).program())
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function toKey(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') return value
  return String(value)
}

function hasOwn(obj, key) {
  // 先用 in 触发响应式代理的 has 追踪（之后才新增的键也能驱动重渲染），再限定为自有属性
  const present = key in obj
  return present && Object.prototype.hasOwnProperty.call(obj, key)
}

function readMember(obj, rawKey) {
  if (obj == null) return undefined
  const key = toKey(rawKey)
  if (typeof key === 'string' && BLOCKED_KEYS.has(key)) return undefined
  if (Array.isArray(obj) || typeof obj === 'string') {
    if (key === 'length') return obj.length
    const index = Number(key)
    if (Number.isInteger(index)) return obj[index < 0 ? obj.length + index : index]
    return undefined
  }
  if (isPlainObject(obj)) {
    return hasOwn(obj, key) ? obj[key] : undefined
  }
  return undefined
}

function writeMember(obj, rawKey, value) {
  const key = toKey(rawKey)
  if (typeof key === 'string' && BLOCKED_KEYS.has(key)) throw new SmartUIExprError('blocked key')
  if (Array.isArray(obj)) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index > MAX_ARRAY) throw new SmartUIExprError('bad index')
    obj[index] = value
    return
  }
  if (isPlainObject(obj)) {
    obj[key] = value
    return
  }
  throw new SmartUIExprError('cannot assign')
}

function toNumber(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value == null || value === '') return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function toList(value) {
  if (Array.isArray(value)) return value
  if (isPlainObject(value)) return Object.values(value)
  if (typeof value === 'string') return Array.from(value)
  return []
}

function looseEqual(a, b) {
  if (typeof a === 'number' || typeof b === 'number') {
    if (a === '' || b === '' || a == null || b == null) return a === b
    return toNumber(a) === toNumber(b)
  }
  return a === b
}

function roundTo(value, digits = 0) {
  const d = Math.max(0, Math.min(10, Math.trunc(toNumber(digits))))
  const factor = 10 ** d
  return Math.round((toNumber(value) + Number.EPSILON) * factor) / factor
}

function clampLength(arr) {
  return arr.length > MAX_ARRAY ? arr.slice(0, MAX_ARRAY) : arr
}

function clampString(text) {
  const s = String(text)
  return s.length > MAX_STRING ? s.slice(0, MAX_STRING) : s
}

function makeAccessor(arg) {
  if (typeof arg === 'function') return arg
  if (typeof arg === 'string' && arg) return item => readMember(item, arg)
  return item => item
}

function formatGrouped(value, digits = 0) {
  const n = roundTo(value, digits)
  const [intPart, decPart] = Math.abs(n).toFixed(Math.max(0, Math.trunc(toNumber(digits)))).split('.')
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (n < 0 ? '-' : '') + grouped + (decPart ? '.' + decPart : '')
}

function randomInt(a, b) {
  const lo = Math.ceil(Math.min(toNumber(a), toNumber(b)))
  const hi = Math.floor(Math.max(toNumber(a), toNumber(b)))
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

const PURE_FUNCTIONS = {
  round: (x, d) => roundTo(x, d),
  floor: x => Math.floor(toNumber(x)),
  ceil: x => Math.ceil(toNumber(x)),
  trunc: x => Math.trunc(toNumber(x)),
  abs: x => Math.abs(toNumber(x)),
  sign: x => Math.sign(toNumber(x)),
  sqrt: x => Math.sqrt(toNumber(x)),
  pow: (a, b) => toNumber(a) ** toNumber(b),
  log: x => Math.log(toNumber(x)),
  exp: x => Math.exp(toNumber(x)),
  sin: x => Math.sin(toNumber(x)),
  cos: x => Math.cos(toNumber(x)),
  min: (...args) => Math.min(...(args.length === 1 ? toList(args[0]) : args).map(toNumber)),
  max: (...args) => Math.max(...(args.length === 1 ? toList(args[0]) : args).map(toNumber)),
  clamp: (x, lo, hi) => Math.min(toNumber(hi), Math.max(toNumber(lo), toNumber(x))),
  sum: (list, by) => toList(list).reduce((acc, item, i) => acc + toNumber(makeAccessor(by)(item, i)), 0),
  avg: (list, by) => {
    const items = toList(list)
    return items.length ? PURE_FUNCTIONS.sum(items, by) / items.length : 0
  },
  len: value => (value == null ? 0 : (typeof value === 'string' || Array.isArray(value)) ? value.length : toList(value).length),
  count: (list, match) => toList(list).filter((item, i) => (typeof match === 'function' ? !!match(item, i) : looseEqual(item, match))).length,
  fixed: (x, d = 2) => roundTo(x, d).toFixed(Math.max(0, Math.min(10, Math.trunc(toNumber(d))))),
  fmt: (x, d = 0) => formatGrouped(x, d),
  pct: (x, d = 0) => `${roundTo(toNumber(x) * 100, d)}%`,
  money: (x, symbol = '¥', d = 2) => `${symbol}${formatGrouped(x, d)}`,
  num: x => toNumber(x),
  int: x => Math.trunc(toNumber(x)),
  str: x => (x == null ? '' : clampString(x)),
  upper: x => String(x ?? '').toUpperCase(),
  lower: x => String(x ?? '').toLowerCase(),
  trim: x => String(x ?? '').trim(),
  pad: (x, n = 2, c = '0') => String(x ?? '').padStart(Math.min(64, toNumber(n)), String(c || '0')),
  repeat: (x, n) => String(x ?? '').repeat(Math.max(0, Math.min(500, Math.trunc(toNumber(n))))),
  split: (x, sep = ',') => clampLength(String(x ?? '').split(String(sep))),
  includes: (hay, needle) => (typeof hay === 'string' ? hay.includes(String(needle)) : toList(hay).some(item => looseEqual(item, needle))),
  indexOf: (list, value) => (typeof list === 'string' ? list.indexOf(String(value)) : toList(list).findIndex(item => looseEqual(item, value))),
  join: (list, sep = '、') => toList(list).join(String(sep)),
  range: (a, b, step = 1) => {
    const start = b === undefined ? 0 : toNumber(a)
    const end = b === undefined ? toNumber(a) : toNumber(b)
    const inc = toNumber(step) || 1
    const out = []
    for (let v = start; inc > 0 ? v < end : v > end; v += inc) {
      out.push(v)
      if (out.length >= MAX_ARRAY) break
    }
    return out
  },
  slice: (list, s, e) => (typeof list === 'string' ? list.slice(s, e) : toList(list).slice(s, e)),
  at: (list, i) => readMember(toList(list), toNumber(i)),
  first: list => toList(list)[0],
  last: list => { const items = toList(list); return items[items.length - 1] },
  keys: obj => (isPlainObject(obj) ? Object.keys(obj) : []),
  values: obj => toList(obj),
  map: (list, fn) => toList(list).map((item, i) => makeAccessor(fn)(item, i)),
  filter: (list, fn) => toList(list).filter((item, i) => !!makeAccessor(fn)(item, i)),
  find: (list, fn) => toList(list).find((item, i) => !!makeAccessor(fn)(item, i)),
  some: (list, fn) => toList(list).some((item, i) => !!makeAccessor(fn)(item, i)),
  every: (list, fn) => toList(list).every((item, i) => !!makeAccessor(fn)(item, i)),
  sort: (list, by) => {
    const accessor = makeAccessor(by)
    return [...toList(list)].sort((a, b) => {
      const va = accessor(a)
      const vb = accessor(b)
      return typeof va === 'number' || typeof vb === 'number' ? toNumber(va) - toNumber(vb) : String(va).localeCompare(String(vb))
    })
  },
  reverse: list => [...toList(list)].reverse(),
  concat: (...lists) => clampLength([].concat(...lists.map(item => (Array.isArray(item) ? item : [item])))),
  unique: list => Array.from(new Set(toList(list))),
  rand: (a = 0, b = 1) => randomInt(a, b),
  random: () => Math.random(),
  choice: list => { const items = toList(list); return items[Math.floor(Math.random() * items.length)] },
  shuffle: list => {
    const items = [...toList(list)]
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[items[i], items[j]] = [items[j], items[i]]
    }
    return items
  },
  now: () => Date.now(),
  iff: (cond, a, b) => (cond ? a : b)
}

function ensureArray(value) {
  if (!Array.isArray(value)) throw new SmartUIExprError('not an array')
  return value
}

const MUTATING_FUNCTIONS = {
  push: (list, ...items) => {
    const arr = ensureArray(list)
    if (arr.length + items.length > MAX_ARRAY) return arr.length
    return arr.push(...items)
  },
  pop: list => ensureArray(list).pop(),
  shift: list => ensureArray(list).shift(),
  unshift: (list, ...items) => ensureArray(list).unshift(...items),
  insert: (list, index, item) => { ensureArray(list).splice(Math.trunc(toNumber(index)), 0, item) },
  remove: (list, index) => { ensureArray(list).splice(Math.trunc(toNumber(index)), 1) },
  removeWhere: (list, fn) => {
    const arr = ensureArray(list)
    const accessor = makeAccessor(fn)
    for (let i = arr.length - 1; i >= 0; i -= 1) {
      if (accessor(arr[i], i)) arr.splice(i, 1)
    }
  },
  toggle: (list, value) => {
    const arr = ensureArray(list)
    const index = arr.findIndex(item => looseEqual(item, value))
    if (index >= 0) arr.splice(index, 1)
    else if (arr.length < MAX_ARRAY) arr.push(value)
  },
  clear: list => { ensureArray(list).splice(0) }
}

export const SMART_UI_CONSTANTS = Object.freeze({ PI: Math.PI, E: Math.E })

/**
 * @typedef {{ state: Record<string, any>, locals?: Record<string, any>[], globals?: Record<string, any>, actions?: Record<string, Function> }} EvalContext
 */

function createEvaluator(ctx, allowMutation) {
  let steps = 0
  const tick = () => {
    steps += 1
    if (steps > MAX_STEPS) throw new SmartUIExprError('too many steps')
  }
  const locals = Array.isArray(ctx.locals) ? ctx.locals : []

  function lookup(name, scopes) {
    for (let i = scopes.length - 1; i >= 0; i -= 1) {
      if (Object.prototype.hasOwnProperty.call(scopes[i], name)) return scopes[i][name]
    }
    if (ctx.state && hasOwn(ctx.state, name)) return ctx.state[name]
    if (ctx.globals && Object.prototype.hasOwnProperty.call(ctx.globals, name)) return ctx.globals[name]
    if (Object.prototype.hasOwnProperty.call(SMART_UI_CONSTANTS, name)) return SMART_UI_CONSTANTS[name]
    return undefined
  }

  function evalNode(node, scopes) {
    tick()
    switch (node.k) {
      case 'lit': return node.v
      case 'id': return lookup(node.name, scopes)
      case 'arr': return clampLength(node.items.map(item => evalNode(item, scopes)))
      case 'obj': {
        const out = {}
        for (const [key, valueNode] of node.entries) {
          if (BLOCKED_KEYS.has(key)) continue
          out[key] = evalNode(valueNode, scopes)
        }
        return out
      }
      case 'mem': return readMember(evalNode(node.obj, scopes), evalNode(node.prop, scopes))
      case 'un': {
        const value = evalNode(node.arg, scopes)
        if (node.op === '!') return !value
        if (node.op === '-') return -toNumber(value)
        return toNumber(value)
      }
      case 'bin': return evalBinary(node, scopes)
      case 'cond': return evalNode(node.test, scopes) ? evalNode(node.yes, scopes) : evalNode(node.no, scopes)
      case 'fn': return (...args) => {
        const frame = {}
        node.params.forEach((param, index) => { frame[param] = args[index] })
        return evalNode(node.body, [...scopes, frame])
      }
      case 'call': return evalCall(node, scopes)
      case 'assign': return evalAssign(node, scopes)
      default: throw new SmartUIExprError('unknown node')
    }
  }

  function evalBinary(node, scopes) {
    const { op } = node
    if (op === '&&') return evalNode(node.left, scopes) && evalNode(node.right, scopes)
    if (op === '||') return evalNode(node.left, scopes) || evalNode(node.right, scopes)
    if (op === '??') return evalNode(node.left, scopes) ?? evalNode(node.right, scopes)
    const a = evalNode(node.left, scopes)
    const b = evalNode(node.right, scopes)
    switch (op) {
      case '+':
        if (typeof a === 'string' || typeof b === 'string') return clampString(`${a ?? ''}${b ?? ''}`)
        if (Array.isArray(a) && Array.isArray(b)) return clampLength([...a, ...b])
        return toNumber(a) + toNumber(b)
      case '-': return toNumber(a) - toNumber(b)
      case '*': return toNumber(a) * toNumber(b)
      case '/': return toNumber(b) === 0 ? 0 : toNumber(a) / toNumber(b)
      case '%': return toNumber(b) === 0 ? 0 : toNumber(a) % toNumber(b)
      case '**': return toNumber(a) ** toNumber(b)
      case '==': case '===': return looseEqual(a, b)
      case '!=': case '!==': return !looseEqual(a, b)
      case '<': return typeof a === 'string' && typeof b === 'string' ? a < b : toNumber(a) < toNumber(b)
      case '>': return typeof a === 'string' && typeof b === 'string' ? a > b : toNumber(a) > toNumber(b)
      case '<=': return typeof a === 'string' && typeof b === 'string' ? a <= b : toNumber(a) <= toNumber(b)
      case '>=': return typeof a === 'string' && typeof b === 'string' ? a >= b : toNumber(a) >= toNumber(b)
      default: throw new SmartUIExprError('bad operator')
    }
  }

  function evalCall(node, scopes) {
    const name = node.name
    if (allowMutation && Object.prototype.hasOwnProperty.call(MUTATING_FUNCTIONS, name)) {
      return MUTATING_FUNCTIONS[name](...node.args.map(arg => evalNode(arg, scopes)))
    }
    if (allowMutation && ctx.actions && Object.prototype.hasOwnProperty.call(ctx.actions, name)) {
      return ctx.actions[name](...node.args.map(arg => evalNode(arg, scopes)))
    }
    if (Object.prototype.hasOwnProperty.call(PURE_FUNCTIONS, name)) {
      return PURE_FUNCTIONS[name](...node.args.map(arg => evalNode(arg, scopes)))
    }
    const local = lookup(name, scopes)
    if (typeof local === 'function') return local(...node.args.map(arg => evalNode(arg, scopes)))
    return undefined
  }

  function evalAssign(node, scopes) {
    if (!allowMutation) throw new SmartUIExprError('assignment not allowed here')
    const compute = (current) => {
      const value = evalNode(node.value, scopes)
      switch (node.op) {
        case '=': return value
        case '+=': return typeof current === 'string' || typeof value === 'string' ? clampString(`${current ?? ''}${value ?? ''}`) : toNumber(current) + toNumber(value)
        case '-=': return toNumber(current) - toNumber(value)
        case '*=': return toNumber(current) * toNumber(value)
        case '/=': return toNumber(value) === 0 ? 0 : toNumber(current) / toNumber(value)
        case '%=': return toNumber(value) === 0 ? 0 : toNumber(current) % toNumber(value)
        case '**=': return toNumber(current) ** toNumber(value)
        default: throw new SmartUIExprError('bad assignment')
      }
    }
    return assignTo(node.target, compute, scopes)
  }

  function assignTo(target, compute, scopes) {
    if (target.k === 'id') {
      const name = target.name
      if (BLOCKED_KEYS.has(name)) throw new SmartUIExprError('blocked key')
      for (let i = scopes.length - 1; i >= 0; i -= 1) {
        if (Object.prototype.hasOwnProperty.call(scopes[i], name)) {
          throw new SmartUIExprError('cannot reassign loop variable')
        }
      }
      const next = compute(ctx.state[name])
      ctx.state[name] = next
      return next
    }
    if (target.k === 'mem') {
      const obj = evalNode(target.obj, scopes)
      const key = evalNode(target.prop, scopes)
      const next = compute(readMember(obj, key))
      writeMember(obj, key, next)
      return next
    }
    throw new SmartUIExprError('bad assignment target')
  }

  return {
    evaluate: node => evalNode(node, locals),
    assignTo: (target, value) => assignTo(target, () => value, locals)
  }
}

/** 求值表达式；出错时返回 fallback。 */
export function evaluate(source, ctx, fallback = undefined) {
  try {
    const node = typeof source === 'string' ? parseExpression(source) : source
    return createEvaluator(ctx, false).evaluate(node)
  } catch {
    return fallback
  }
}

/** 执行一段 set="..." 语句，可修改 ctx.state。返回是否成功。 */
export function runStatements(source, ctx) {
  try {
    const program = parseProgram(source)
    const evaluator = createEvaluator(ctx, true)
    program.statements.forEach(statement => evaluator.evaluate(statement))
    return true
  } catch (error) {
    if (typeof console !== 'undefined') console.warn('[smart-ui] set failed:', source, error?.message || error)
    return false
  }
}

/** bind="path" 的写回。 */
export function assignPath(source, value, ctx) {
  try {
    const node = parseExpression(source)
    if (node.k !== 'id' && node.k !== 'mem') return false
    createEvaluator(ctx, true).assignTo(node, value)
    return true
  } catch {
    return false
  }
}

export function isValidExpression(source) {
  try {
    parseExpression(source)
    return true
  } catch {
    return false
  }
}

/** 把任意值转成适合展示的文本。 */
export function formatDisplayValue(value) {
  if (value == null) return ''
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—'
    if (Number.isInteger(value)) return String(value)
    return String(roundTo(value, Math.abs(value) >= 100 ? 1 : 2))
  }
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.map(formatDisplayValue).join('、')
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return String(value)
}

/**
 * 把含 {expr} 的模板切成片段。无法解析的花括号按原文保留；
 * 末尾未闭合的 { 视为仍在流式生成中，直接丢弃。
 * @returns {Array<string | { expr: string }>}
 */
export function splitTemplate(text) {
  const src = String(text ?? '')
  if (!src.includes('{')) return [src]
  const segments = []
  let buffer = ''
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch !== '{') {
      buffer += ch
      i += 1
      continue
    }
    let depth = 0
    let j = i
    let quote = ''
    for (; j < src.length; j += 1) {
      const c = src[j]
      if (quote) {
        if (c === '\\') { j += 1; continue }
        if (c === quote) quote = ''
        continue
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue }
      if (c === '{') depth += 1
      else if (c === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    if (j >= src.length) {
      // 未闭合：正在生成中
      break
    }
    const inner = src.slice(i + 1, j)
    if (inner.trim() && isValidExpression(inner)) {
      if (buffer) segments.push(buffer)
      buffer = ''
      segments.push({ expr: inner })
    } else {
      buffer += src.slice(i, j + 1)
    }
    i = j + 1
  }
  if (buffer) segments.push(buffer)
  return segments
}

/** 渲染模板文本。 */
export function renderTemplate(text, ctx) {
  const segments = splitTemplate(text)
  if (segments.length === 1 && typeof segments[0] === 'string') return segments[0]
  return segments.map(segment => (typeof segment === 'string' ? segment : formatDisplayValue(evaluate(segment.expr, ctx, '')))).join('')
}

/**
 * 属性值：整个值就是一个 {expr} 时返回原始值（数组、数字等），否则返回拼接后的字符串。
 */
export function resolveTemplateValue(text, ctx) {
  const segments = splitTemplate(text)
  if (segments.length === 1 && typeof segments[0] === 'object') {
    return evaluate(segments[0].expr, ctx, undefined)
  }
  return segments.map(segment => (typeof segment === 'string' ? segment : formatDisplayValue(evaluate(segment.expr, ctx, '')))).join('')
}
