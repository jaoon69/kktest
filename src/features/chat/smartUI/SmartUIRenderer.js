import { Fragment, computed, defineComponent, h, onBeforeUnmount, reactive, watch } from 'vue'
import {
  assignPath,
  evaluate,
  formatDisplayValue,
  renderTemplate,
  resolveTemplateValue,
  runStatements
} from './expr'
import { renderSmartUIChart } from './chart'
import { isSafeAttributeValue, isSafeExternalUrl, sanitizePaintValue, sanitizeStyle } from './style'
import { compileScopedStylesheet, createKeyframeRenamer } from './stylesheet'
import { MAX_GENERATED_IMAGES_PER_CARD, imageAssetKey } from './media'

const MAX_EACH = 200
const EACH_REGEX = /^\s*\(?\s*([\p{L}_$][\p{L}\p{N}_$]*)\s*(?:,\s*([\p{L}_$][\p{L}\p{N}_$]*))?\s*\)?\s+(?:in|of)\s+([\s\S]+)$/u

const GAP_SCALE = { none: 0, xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }
const TEXT_SIZE = { xs: 11, sm: 13, md: 15, base: 15, lg: 18, xl: 22, '2xl': 28, '3xl': 36, '4xl': 46 }
const FONT_WEIGHT = { light: 300, normal: 400, regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800, black: 900 }
const TONES = new Set(['accent', 'good', 'warn', 'bad', 'muted', 'plain', 'tint', 'dark', 'info', 'success', 'warning', 'danger', 'error'])
const TONE_ALIAS = { success: 'good', warning: 'warn', danger: 'bad', error: 'bad', info: 'accent' }

const NATIVE_TAGS = new Set([
  'div', 'span', 'p', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'small', 'mark', 'code', 'pre', 'blockquote',
  'sup', 'sub', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'details', 'summary', 'label', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'abbr', 'figure', 'figcaption', 'section', 'article', 'header', 'footer', 'nav', 'kbd', 'q', 'time'
])
const INLINE_TAGS = new Set(['span', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'ins', 'small', 'mark', 'code', 'sup', 'sub', 'br', 'abbr', 'kbd', 'q', 'time', 'label', 'icon', 'badge', 'tag', 'pill', 'text', 'a'])
const NATIVE_ATTRS = { td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], ol: ['start', 'reversed'], details: ['open'] }

const SVG_TAG_CASE = {
  svg: 'svg', g: 'g', path: 'path', rect: 'rect', circle: 'circle', ellipse: 'ellipse', line: 'line', polyline: 'polyline',
  polygon: 'polygon', text: 'text', tspan: 'tspan', textpath: 'textPath', defs: 'defs', lineargradient: 'linearGradient', radialgradient: 'radialGradient', stop: 'stop', title: 'title',
  clippath: 'clipPath', mask: 'mask', pattern: 'pattern', use: 'use', image: 'image', symbol: 'symbol', marker: 'marker',
  filter: 'filter', fegaussianblur: 'feGaussianBlur', fedropshadow: 'feDropShadow', feoffset: 'feOffset', feblend: 'feBlend',
  fecolormatrix: 'feColorMatrix', femerge: 'feMerge', femergenode: 'feMergeNode', feflood: 'feFlood', fecomposite: 'feComposite',
  feturbulence: 'feTurbulence', fedisplacementmap: 'feDisplacementMap',
  animate: 'animate', animatetransform: 'animateTransform', animatemotion: 'animateMotion', set: 'set'
}
const SVG_ATTR_CASE = {
  viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', gradientunits: 'gradientUnits', gradienttransform: 'gradientTransform',
  textlength: 'textLength', lengthadjust: 'lengthAdjust', pathlength: 'pathLength', clippathunits: 'clipPathUnits', maskunits: 'maskUnits',
  maskcontentunits: 'maskContentUnits', patternunits: 'patternUnits', patterncontentunits: 'patternContentUnits', patterntransform: 'patternTransform',
  stddeviation: 'stdDeviation', attributename: 'attributeName', repeatcount: 'repeatCount', keytimes: 'keyTimes', keysplines: 'keySplines',
  calcmode: 'calcMode', spreadmethod: 'spreadMethod', basefrequency: 'baseFrequency', numoctaves: 'numOctaves', markerwidth: 'markerWidth',
  markerheight: 'markerHeight', refx: 'refX', refy: 'refY', startoffset: 'startOffset', filterunits: 'filterUnits', primitiveunits: 'primitiveUnits',
  xchannelselector: 'xChannelSelector', ychannelselector: 'yChannelSelector', 'xlink:href': 'href'
}
const SVG_ATTRS = new Set([
  'id', 'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'dx', 'dy', 'd', 'points',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
  'opacity', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'clip-rule', 'transform', 'transform-origin', 'font-size', 'font-weight', 'font-family', 'font-style',
  'text-anchor', 'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'word-spacing', 'offset', 'stop-color', 'stop-opacity',
  'gradientUnits', 'gradientTransform', 'preserveAspectRatio', 'textLength', 'lengthAdjust', 'pathLength', 'rotate', 'vector-effect', 'paint-order',
  'clip-path', 'mask', 'filter', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'patternUnits', 'patternContentUnits', 'patternTransform', 'spreadMethod',
  'href', 'stdDeviation', 'in', 'in2', 'result', 'mode', 'values', 'type', 'operator', 'k1', 'k2', 'k3', 'k4', 'scale', 'xChannelSelector', 'yChannelSelector',
  'flood-color', 'flood-opacity', 'baseFrequency', 'numOctaves', 'seed', 'filterUnits', 'primitiveUnits',
  'attributeName', 'dur', 'begin', 'end', 'repeatCount', 'from', 'to', 'by', 'keyTimes', 'keySplines', 'calcMode', 'additive', 'accumulate', 'path',
  'markerWidth', 'markerHeight', 'refX', 'refY', 'orient', 'marker-start', 'marker-mid', 'marker-end', 'startOffset', 'side', 'method', 'spacing',
  'visibility', 'display', 'image-rendering'
])
// 这些属性可以引用 url(#id)，需要改成卡片私有 id
const SVG_REF_ATTRS = new Set(['fill', 'stroke', 'stop-color', 'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end', 'flood-color'])
// SMIL 动画不能改写这些属性，否则可绕过地址校验
const SVG_BLOCKED_ANIMATED_ATTRS = /^(?:href|xlink:href|style|on\w*)$/i
const CLASS_TOKEN_REGEX = /^[A-Za-z_][\w-]{0,40}$/
const IMAGE_SIZE_RATIO = { square: '1 / 1', portrait: '2 / 3', landscape: '3 / 2', wide: '16 / 9' }

const SmartUITimer = defineComponent({
  name: 'SmartUITimer',
  props: {
    every: { type: Number, default: 0 },
    after: { type: Number, default: 0 },
    times: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    run: { type: Function, required: true }
  },
  setup(props) {
    let handle = 0
    let count = 0
    const stop = () => {
      if (handle) {
        clearTimeout(handle)
        clearInterval(handle)
        handle = 0
      }
    }
    const tick = () => {
      count += 1
      props.run()
      if (props.times > 0 && count >= props.times) stop()
    }
    const start = () => {
      stop()
      if (!props.active || typeof window === 'undefined') return
      count = 0
      const after = Math.min(600000, Math.max(0, props.after))
      const every = props.every > 0 ? Math.max(50, Math.min(600000, props.every)) : 0
      if (!every) {
        // 只写 after：激活后执行一次
        handle = setTimeout(() => { handle = 0; props.run() }, after || 1000)
        return
      }
      if (after > 0) {
        handle = setTimeout(() => {
          tick()
          if (handle && !(props.times > 0 && count >= props.times)) handle = setInterval(tick, every)
        }, after)
      } else {
        handle = setInterval(tick, every)
      }
    }
    watch(() => [props.active, props.every, props.after, props.times], start, { immediate: true })
    onBeforeUnmount(stop)
    return () => null
  }
})

let instanceSeed = 0

function normalizeTone(value) {
  const tone = String(value || '').trim().toLowerCase()
  if (!TONES.has(tone)) return ''
  return TONE_ALIAS[tone] || tone
}

function toGap(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (Object.prototype.hasOwnProperty.call(GAP_SCALE, value)) return GAP_SCALE[value]
  const n = Number(value)
  return Number.isFinite(n) ? Math.max(0, Math.min(64, n)) : fallback
}

function toList(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') return Object.values(value)
  if (typeof value === 'string' && value.trim()) return value.split(/[,，、|]/).map(item => item.trim()).filter(Boolean)
  if (typeof value === 'number' && Number.isFinite(value)) return Array.from({ length: Math.max(0, Math.min(MAX_EACH, value)) }, (_, i) => i)
  return []
}

function normalizeOptions(raw) {
  return toList(raw).slice(0, 40).map((item) => {
    if (Array.isArray(item)) return { value: item[0], label: formatDisplayValue(item[1] ?? item[0]) }
    if (item && typeof item === 'object') {
      const value = item.value ?? item.id ?? item.label
      return { value, label: formatDisplayValue(item.label ?? item.name ?? value), icon: item.icon }
    }
    return { value: item, label: formatDisplayValue(item) }
  })
}

function sameValue(a, b) {
  if (typeof a === 'number' || typeof b === 'number') return String(a) === String(b)
  return a === b
}

function collectStyleTexts(nodes, out = []) {
  for (const node of nodes || []) {
    if (node.type !== 'el') continue
    if (node.tag === 'style') out.push(node.children.map(child => child.value || '').join(''))
    else collectStyleTexts(node.children, out)
  }
  return out
}

function classTokens(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(token => CLASS_TOKEN_REGEX.test(token))
    .slice(0, 12)
    .map(token => (token.startsWith('sui-') ? token : `u-${token}`))
}

function iconName(value) {
  const name = String(value || '').trim().toLowerCase().replace(/^ph-/, '')
  return /^[a-z0-9-]{1,40}$/.test(name) ? name : ''
}

export default defineComponent({
  name: 'SmartUIRenderer',
  props: {
    nodes: { type: Array, default: () => [] },
    state: { type: Object, required: true },
    animate: { type: Boolean, default: false },
    canSend: { type: Boolean, default: false },
    interactive: { type: Boolean, default: true },
    actions: { type: Object, default: () => ({}) },
    // 卡片作用域 id（与外层 data-sui-scope 一致）
    uid: { type: String, default: '' },
    // 内容已完整（非流式）：允许发起生图、启动定时器
    live: { type: Boolean, default: true },
    // 媒体能力适配器（已绑定到当前消息）
    media: { type: Object, default: null },
    // 只读上下文变量：char / user / today …
    context: { type: Object, default: () => ({}) }
  },
  emits: ['send', 'interact'],
  setup(props, { emit }) {
    instanceSeed += 1
    const uid = props.uid || `sui${instanceSeed}`
    const local = reactive({})
    const brokenImages = reactive({})
    let generatedThisRender = 0

    const ctxFor = scopes => ({ state: props.state, locals: scopes, globals: props.context, actions: props.actions })
    const attrValue = (node, name, scopes) => {
      if (!Object.prototype.hasOwnProperty.call(node.attrs, name)) return undefined
      return resolveTemplateValue(node.attrs[name], ctxFor(scopes))
    }
    const attrText = (node, name, scopes, fallback = '') => {
      const value = attrValue(node, name, scopes)
      return value === undefined ? fallback : formatDisplayValue(value)
    }
    const attrNumber = (node, name, scopes, fallback) => {
      const value = attrValue(node, name, scopes)
      if (value === undefined || value === '') return fallback
      const n = Number(value)
      return Number.isFinite(n) ? n : fallback
    }
    const attrBool = (node, name, scopes) => {
      if (!Object.prototype.hasOwnProperty.call(node.attrs, name)) return false
      const raw = String(node.attrs[name] ?? '').trim()
      if (raw === '' || raw === 'true' || raw === name) return true
      if (raw === 'false') return false
      return !!evaluate(raw.replace(/^\{([\s\S]*)\}$/, '$1'), ctxFor(scopes), false)
    }
    // data / options：既可写表达式也可写 {表达式}
    const attrData = (node, name, scopes) => {
      const raw = node.attrs[name]
      if (raw === undefined) return undefined
      const trimmed = String(raw).trim()
      if (/^\{[\s\S]*\}$/.test(trimmed)) {
        const templated = resolveTemplateValue(trimmed, ctxFor(scopes))
        if (templated !== undefined && typeof templated !== 'string') return templated
      }
      const value = evaluate(trimmed, ctxFor(scopes), undefined)
      return value === undefined ? trimmed : value
    }
    const condition = (source, scopes) => !!evaluate(String(source).trim().replace(/^\{([\s\S]*)\}$/, '$1'), ctxFor(scopes), false)
    const scopedId = id => `${uid}-${String(id).replace(/[^\w-]/g, '')}`

    // CSS / 属性中的资源地址：卡片内 #id、https、内联图片、avatar: / sprite: 内置资源
    function resolveUrl(raw) {
      const value = String(raw || '').trim()
      if (value.startsWith('#')) return /^#[\w-]+$/.test(value) ? `#${scopedId(value.slice(1))}` : ''
      if (isSafeExternalUrl(value)) return value
      return props.media?.resolveAsset(value) || ''
    }

    const styleTexts = computed(() => collectStyleTexts(props.nodes))
    const renameKeyframes = computed(() => createKeyframeRenamer(styleTexts.value, uid))
    const stylesheet = computed(() => {
      if (styleTexts.value.length === 0) return ''
      return compileScopedStylesheet(styleTexts.value.join('\n'), {
        scope: `[data-sui-scope="${uid}"]`,
        uid,
        scopedId,
        resolveUrl
      })
    })

    function styleOf(node, scopes, extra = '') {
      const raw = node.attrs.style !== undefined ? renderTemplate(node.attrs.style, ctxFor(scopes)) : ''
      const cleaned = sanitizeStyle(raw, { resolveUrl, renameKeyframes: renameKeyframes.value || undefined })
      return [extra, cleaned].filter(Boolean).join(';')
    }

    function bindingOf(node, scopes, key, fallback) {
      const path = node.attrs.bind ?? node.attrs.model ?? node.attrs['v-model']
      if (path && String(path).trim()) {
        const source = String(path).trim().replace(/^\{([\s\S]*)\}$/, '$1')
        return {
          get: () => evaluate(source, ctxFor(scopes), undefined),
          set: (value) => {
            if (!props.interactive) return
            assignPath(source, value, ctxFor(scopes))
            emit('interact')
          }
        }
      }
      // 未绑定状态的控件用组件内局部值；渲染期间只读不写，避免触发额外的重渲染
      return {
        get: () => (key in local ? local[key] : fallback),
        set: (value) => {
          if (!props.interactive) return
          local[key] = value
          emit('interact')
        }
      }
    }

    function textOf(nodes, scopes) {
      let out = ''
      for (const node of nodes || []) {
        if (node.type === 'text') out += renderTemplate(node.value, ctxFor(scopes))
        else out += textOf(node.children, scopes)
      }
      return out.trim()
    }

    function clickHandler(node, scopes) {
      const setSource = node.attrs.set ?? node.attrs.action
      const hasSend = Object.prototype.hasOwnProperty.call(node.attrs, 'send')
      const speakSource = node.attrs.speak
      if (!setSource && !hasSend && speakSource === undefined) return null
      return (event) => {
        event?.stopPropagation?.()
        if (!props.interactive) return
        if (speakSource !== undefined) {
          const line = String(speakSource).trim() ? renderTemplate(String(speakSource), ctxFor(scopes)) : textOf(node.children, scopes)
          props.media?.speak(line, { who: node.attrs.who === 'user' ? 'user' : 'char', emotion: attrText(node, 'emotion', scopes) })
        }
        if (setSource) {
          // 兼容 set="{n = n + 1}" 这种多包一层花括号的写法
          const statements = String(setSource).trim().replace(/^\{([\s\S]*=[\s\S]*)\}$/, '$1')
          runStatements(statements, ctxFor(scopes))
          emit('interact')
        }
        if (hasSend) {
          if (!props.canSend) return
          const template = String(node.attrs.send || '').trim()
          const text = template ? renderTemplate(template, ctxFor(scopes)) : textOf(node.children, scopes)
          if (text) emit('send', text)
        }
      }
    }

    function expand(nodes, scopes, keyPrefix) {
      const out = []
      ;(nodes || []).forEach((node, index) => {
        const key = `${keyPrefix}.${index}`
        if (node.type !== 'el') {
          out.push({ node, scopes, key })
          return
        }
        if (node.attrs.each !== undefined) {
          const match = EACH_REGEX.exec(String(node.attrs.each))
          if (!match) return
          const [, itemName, indexName, listSource] = match
          const list = toList(evaluate(listSource.trim().replace(/^\{([\s\S]*)\}$/, '$1'), ctxFor(scopes), []))
          const { each, ...restAttrs } = node.attrs
          const clone = { ...node, attrs: restAttrs }
          list.slice(0, MAX_EACH).forEach((item, itemIndex) => {
            const frame = { [itemName]: item }
            if (indexName) frame[indexName] = itemIndex
            const nextScopes = [...scopes, frame]
            if (clone.attrs.if !== undefined && !condition(clone.attrs.if, nextScopes)) return
            out.push({ node: clone, scopes: nextScopes, key: `${key}#${itemIndex}` })
          })
          return
        }
        if (node.attrs.if !== undefined && !condition(node.attrs.if, scopes)) return
        out.push({ node, scopes, key })
      })
      return out
    }

    function renderChildren(nodes, scopes, keyPrefix, svgMode = false) {
      return expand(nodes, scopes, keyPrefix).map(entry => renderNode(entry.node, entry.scopes, entry.key, svgMode))
    }

    function enterClass(tag) {
      return props.animate && !INLINE_TAGS.has(tag) ? 'sui-enter' : ''
    }

    function withCommon(node, scopes, key, baseClass, extraStyle = '') {
      const onClick = clickHandler(node, scopes)
      const cls = [baseClass, enterClass(node.tag), onClick ? 'sui-clickable' : '']
      const tone = normalizeTone(node.attrs.tone)
      if (tone) cls.push(`sui-tone-${tone}`)
      if (node.attrs.class !== undefined) cls.push(...classTokens(renderTemplate(node.attrs.class, ctxFor(scopes))))
      const vnodeProps = { key, class: cls.filter(Boolean).join(' '), style: styleOf(node, scopes, extraStyle) || undefined }
      if (node.attrs.id && /^[\w-]{1,40}$/.test(node.attrs.id)) vnodeProps.id = scopedId(node.attrs.id)
      if (onClick) {
        vnodeProps.onClick = onClick
        vnodeProps.role = 'button'
        vnodeProps.tabindex = '0'
      }
      return vnodeProps
    }

    function renderNode(node, scopes, key, svgMode) {
      if (node.type === 'text') return renderTemplate(node.value, ctxFor(scopes))
      const tag = node.tag
      if (svgMode || tag === 'svg') return renderSvg(node, scopes, key)
      const kids = () => renderChildren(node.children, scopes, key)

      switch (tag) {
        case 'ui':
          return h(Fragment, { key }, kids())
        case 'col':
        case 'stack':
        case 'vstack':
        case 'column':
          return h('div', withCommon(node, scopes, key, 'sui-col', flexStyle(node, scopes, 'column')), kids())
        case 'row':
        case 'hstack':
          return h('div', withCommon(node, scopes, key, 'sui-row', flexStyle(node, scopes, 'row')), kids())
        case 'grid': {
          const cols = Math.trunc(attrNumber(node, 'cols', scopes, 0))
          const min = attrNumber(node, 'min', scopes, 96)
          const template = cols > 0
            ? `grid-template-columns:repeat(${Math.min(8, cols)},minmax(0,1fr))`
            : `grid-template-columns:repeat(auto-fit,minmax(${Math.max(48, Math.min(240, min))}px,1fr))`
          return h('div', withCommon(node, scopes, key, 'sui-grid', `${template};gap:${toGap(node.attrs.gap, 8)}px`), kids())
        }
        case 'card':
        case 'box':
        case 'panel':
          return h('div', withCommon(node, scopes, key, `sui-card${attrBool(node, 'flat', scopes) ? ' sui-card-flat' : ''}`, flexStyle(node, scopes, 'column', 10)), kids())
        case 'divider':
        case 'hr': {
          const label = attrText(node, 'label', scopes)
          return h('div', withCommon(node, scopes, key, label ? 'sui-divider sui-divider-label' : 'sui-divider'), label ? [h('span', null, label)] : [])
        }
        case 'spacer':
          return h('div', withCommon(node, scopes, key, 'sui-spacer', node.attrs.size ? `flex:none;height:${toGap(node.attrs.size, 12)}px` : ''))
        case 'title':
        case 'heading': {
          const level = Math.max(1, Math.min(4, Math.trunc(attrNumber(node, 'level', scopes, 3))))
          return h(`h${level}`, withCommon(node, scopes, key, 'sui-heading'), kids())
        }
        case 'text':
          return renderText(node, scopes, key)
        case 'badge':
        case 'tag':
        case 'pill':
          return h('span', withCommon(node, scopes, key, 'sui-badge'), node.children.length ? kids() : attrText(node, 'label', scopes))
        case 'icon':
          return renderIcon(node, scopes, key)
        case 'img':
        case 'image':
          return renderImage(node, scopes, key)
        case 'style':
          return null
        case 'avatar':
          return renderAvatar(node, scopes, key)
        case 'voice':
        case 'speech':
          return renderVoice(node, scopes, key)
        case 'timer':
        case 'every':
          return renderTimer(node, scopes, key)
        case 'layer':
        case 'stage':
          return h('div', withCommon(node, scopes, key, node.tag === 'stage' ? 'sui-stage' : 'sui-layer'), kids())
        case 'stat':
        case 'metric':
          return renderStat(node, scopes, key)
        case 'kv':
        case 'spec':
          return h('div', withCommon(node, scopes, key, 'sui-kv'), [
            h('span', { class: 'sui-kv-k' }, attrText(node, 'k', scopes) || attrText(node, 'label', scopes)),
            h('span', { class: 'sui-kv-v' }, node.children.length ? kids() : (attrText(node, 'v', scopes) || attrText(node, 'value', scopes)))
          ])
        case 'progress':
        case 'meter':
          return renderProgress(node, scopes, key)
        case 'chart':
          return h('div', withCommon(node, scopes, key, 'sui-chart-wrap'), [
            node.attrs.title ? h('div', { class: 'sui-chart-title' }, attrText(node, 'title', scopes)) : null,
            renderSmartUIChart({
              type: attrText(node, 'type', scopes, 'bar'),
              data: attrData(node, 'data', scopes),
              series: attrData(node, 'series', scopes),
              labels: attrData(node, 'labels', scopes),
              colors: attrData(node, 'colors', scopes),
              unit: attrText(node, 'unit', scopes),
              height: attrNumber(node, 'height', scopes, 0),
              max: attrNumber(node, 'max', scopes, 0),
              min: node.attrs.min === undefined ? undefined : attrNumber(node, 'min', scopes, 0),
              center: attrText(node, 'center', scopes)
            })
          ])
        case 'steps':
        case 'timeline':
          return h('div', withCommon(node, scopes, key, 'sui-steps'), kids())
        case 'step':
          return renderStep(node, scopes, key)
        case 'button':
        case 'btn':
          return renderButton(node, scopes, key)
        case 'slider':
        case 'range':
          return renderSlider(node, scopes, key)
        case 'stepper':
        case 'counter':
          return renderStepper(node, scopes, key)
        case 'input':
        case 'textarea':
          return renderInput(node, scopes, key)
        case 'toggle':
        case 'switch':
          return renderToggle(node, scopes, key)
        case 'checkbox':
        case 'check':
          return renderCheckbox(node, scopes, key)
        case 'chips':
        case 'choices':
        case 'options':
        case 'segmented':
          return renderChips(node, scopes, key)
        case 'select':
          return renderSelect(node, scopes, key)
        case 'rating':
          return renderRating(node, scopes, key)
        case 'tabs':
          return renderTabs(node, scopes, key)
        case 'tab':
          return h('div', withCommon(node, scopes, key, 'sui-col'), kids())
        case 'table':
          return h('div', { key, class: `sui-table-wrap ${enterClass('table')}` }, [
            h('table', withCommon(node, scopes, `${key}-t`, 'sui-table'), kids())
          ])
        case 'a':
          return h('span', withCommon(node, scopes, key, 'sui-link'), kids())
        default:
          if (NATIVE_TAGS.has(tag)) return renderNative(node, scopes, key)
          return h(Fragment, { key }, kids())
      }
    }

    function flexStyle(node, scopes, direction, defaultGap = 8) {
      const parts = [`gap:${toGap(node.attrs.gap, defaultGap)}px`]
      const align = String(node.attrs.align || '').trim()
      const justify = String(node.attrs.justify || '').trim()
      const alignMap = { start: 'flex-start', end: 'flex-end', center: 'center', stretch: 'stretch', baseline: 'baseline' }
      const justifyMap = { start: 'flex-start', end: 'flex-end', center: 'center', between: 'space-between', around: 'space-around', evenly: 'space-evenly' }
      if (alignMap[align]) parts.push(`align-items:${alignMap[align]}`)
      if (justifyMap[justify]) parts.push(`justify-content:${justifyMap[justify]}`)
      if (direction === 'row' && String(node.attrs.wrap) === 'false') parts.push('flex-wrap:nowrap')
      const pad = node.attrs.pad ?? node.attrs.padding
      if (pad !== undefined) parts.push(`padding:${toGap(pad, 12)}px`)
      return parts.join(';')
    }

    function renderText(node, scopes, key) {
      const parts = []
      const size = String(node.attrs.size || '').trim()
      if (TEXT_SIZE[size]) parts.push(`font-size:${TEXT_SIZE[size]}px`)
      else if (Number(size) > 0) parts.push(`font-size:${Math.min(64, Number(size))}px`)
      const weight = attrText(node, 'weight', scopes).trim()
      if (FONT_WEIGHT[weight]) parts.push(`font-weight:${FONT_WEIGHT[weight]}`)
      else if (/^[1-9]00$/.test(weight)) parts.push(`font-weight:${weight}`)
      const align = String(node.attrs.align || '').trim()
      const isBlock = attrBool(node, 'block', scopes) || ['left', 'center', 'right'].includes(align)
      if (['left', 'center', 'right'].includes(align)) parts.push(`text-align:${align}`)
      if (attrBool(node, 'italic', scopes)) parts.push('font-style:italic')
      if (attrBool(node, 'mono', scopes)) parts.push('font-family:ui-monospace,SFMono-Regular,Menlo,monospace')
      if (attrBool(node, 'muted', scopes)) parts.push('color:var(--ui-muted)')
      const content = node.children.length ? renderChildren(node.children, scopes, key) : attrText(node, 'value', scopes)
      return h(isBlock ? 'div' : 'span', withCommon(node, scopes, key, 'sui-text', parts.join(';')), content)
    }

    function renderIcon(node, scopes, key) {
      const name = iconName(attrText(node, 'name', scopes) || attrText(node, 'icon', scopes))
      if (!name) return null
      const weight = attrText(node, 'weight', scopes).trim().toLowerCase()
      const family = ['fill', 'bold', 'duotone', 'light', 'thin'].includes(weight) ? `ph-${weight}` : 'ph'
      const size = attrNumber(node, 'size', scopes, 0)
      const extra = [size > 0 ? `font-size:${Math.min(96, size)}px` : '', node.attrs.color ? `color:${sanitizePaintValue(attrText(node, 'color', scopes))}` : ''].filter(Boolean).join(';')
      return h('i', withCommon(node, scopes, key, `sui-icon ${family} ph-${name}`, extra))
    }

    function imageSizeOf(node, scopes) {
      const size = attrText(node, 'size', scopes, 'square').toLowerCase()
      return IMAGE_SIZE_RATIO[size] ? size : 'square'
    }

    // gen="描述"：调用已配置的生图服务；结果缓存在消息里
    function resolveGeneratedImage(node, scopes) {
      const prompt = (attrText(node, 'gen', scopes) || attrText(node, 'prompt', scopes)).trim()
      const media = props.media
      if (!prompt || !media) return { status: 'disabled', url: '' }
      const type = attrText(node, 'type', scopes, 'scene').toLowerCase()
      const size = imageSizeOf(node, scopes)
      const assetKey = imageAssetKey(prompt, type, size)
      const info = media.getImage(assetKey)
      if (info.url || info.status === 'pending' || info.status === 'error') return { ...info, assetKey, request: { prompt, type, size } }
      if (!media.canGenerate()) return { status: 'disabled', url: '' }
      if (!props.live) return { status: 'waiting', url: '' }
      generatedThisRender += 1
      if (generatedThisRender > MAX_GENERATED_IMAGES_PER_CARD) return { status: 'disabled', url: '' }
      // 渲染期间不直接改响应式状态，放到微任务里发起
      Promise.resolve().then(() => media.requestImage(assetKey, { prompt, type, size }))
      return { status: 'pending', url: '', assetKey, request: { prompt, type, size } }
    }

    function renderImage(node, scopes, key) {
      const alt = attrText(node, 'alt', scopes) || attrText(node, 'gen', scopes) || attrText(node, 'prompt', scopes)
      const ratio = attrText(node, 'ratio', scopes)
      const isGen = node.attrs.gen !== undefined || node.attrs.prompt !== undefined
      const ratioValue = /^\d+(?:\.\d+)?\s*[/:]\s*\d+(?:\.\d+)?$/.test(ratio)
        ? ratio.replace(':', '/')
        : (isGen ? IMAGE_SIZE_RATIO[imageSizeOf(node, scopes)] : '')
      const ratioStyle = ratioValue ? `aspect-ratio:${ratioValue}` : ''

      let src = ''
      let status = 'done'
      let generated = null
      if (isGen) {
        generated = resolveGeneratedImage(node, scopes)
        src = generated.url
        status = generated.url ? 'done' : generated.status
      } else {
        src = resolveUrl(attrText(node, 'src', scopes))
        if (!src) status = 'disabled'
      }

      if (!src || brokenImages[key]) {
        const pending = status === 'pending' || status === 'waiting'
        const failed = status === 'error' || brokenImages[key]
        const placeholder = withCommon(node, scopes, key, ['sui-img-placeholder', pending ? 'is-pending' : '', failed ? 'is-error' : ''].filter(Boolean).join(' '), ratioStyle)
        if (failed && generated?.assetKey) {
          placeholder.onClick = (event) => {
            event.stopPropagation()
            delete brokenImages[key]
            props.media?.retryImage(generated.assetKey, generated.request)
          }
          placeholder.class += ' sui-clickable'
        }
        return h('div', placeholder, [
          h('i', { class: pending ? 'ph ph-sparkle' : failed ? 'ph ph-arrow-clockwise' : 'ph ph-image' }),
          alt && !pending ? h('span', null, failed ? '生成失败，点按重试' : alt) : null
        ])
      }
      return h('img', {
        ...withCommon(node, scopes, key, isGen ? 'sui-img sui-img-generated' : 'sui-img', ratioStyle),
        src,
        alt,
        loading: 'lazy',
        referrerpolicy: 'no-referrer',
        draggable: 'false',
        onError: () => { brokenImages[key] = true }
      })
    }

    function renderAvatar(node, scopes, key) {
      const who = attrText(node, 'who', scopes, 'char') === 'user' ? 'user' : 'char'
      const size = Math.max(16, Math.min(160, attrNumber(node, 'size', scopes, 40)))
      const explicit = node.attrs.src !== undefined ? resolveUrl(attrText(node, 'src', scopes)) : ''
      const info = props.media?.avatarOf(who) || { avatar: '', type: 'emoji', name: '' }
      const url = explicit || (info.type === 'image' ? info.avatar : '')
      const fallback = attrText(node, 'text', scopes) || (info.type !== 'image' ? info.avatar : '') || (info.name || '?').slice(0, 1)
      return h('span', withCommon(node, scopes, key, 'sui-avatar', `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.5)}px`), [
        url && !brokenImages[key]
          ? h('img', { src: url, alt: info.name, draggable: 'false', referrerpolicy: 'no-referrer', onError: () => { brokenImages[key] = true } })
          : h('span', null, fallback)
      ])
    }

    function renderVoice(node, scopes, key) {
      const text = attrText(node, 'text', scopes) || textOf(node.children, scopes)
      const who = attrText(node, 'who', scopes) === 'user' ? 'user' : 'char'
      const speakKey = `${uid}:${key}`
      const playing = props.media?.speaking?.key === speakKey
      const seconds = Math.max(1, Math.min(60, Math.round(text.length / 4.5)))
      const bars = Math.max(6, Math.min(22, Math.round(seconds * 1.6)))
      const label = attrText(node, 'label', scopes)
      const base = withCommon(node, scopes, key, ['sui-voice', playing ? 'is-playing' : ''].filter(Boolean).join(' '))
      return h('button', {
        ...base,
        type: 'button',
        role: undefined,
        tabindex: undefined,
        disabled: !text || !props.media,
        onClick: (event) => {
          event.stopPropagation()
          if (!props.interactive) return
          props.media?.speak(text, { key: speakKey, who, emotion: attrText(node, 'emotion', scopes) })
        }
      }, [
        h('i', { class: playing ? 'ph-fill ph-pause' : 'ph-fill ph-play' }),
        h('span', { class: 'sui-voice-wave', 'aria-hidden': 'true' }, Array.from({ length: bars }, (_, i) => h('i', { key: i, style: `--h:${30 + ((i * 37) % 70)}%;--d:${(i % 5) * 0.08}s` }))),
        h('span', { class: 'sui-voice-time' }, label || `${seconds}″`)
      ])
    }

    function renderTimer(node, scopes, key) {
      const setSource = String(node.attrs.set ?? node.attrs.action ?? '').trim()
      if (!setSource) return null
      const active = props.live && props.interactive && (node.attrs.while === undefined || condition(node.attrs.while, scopes))
      return h(SmartUITimer, {
        key,
        every: attrNumber(node, 'every', scopes, node.tag === 'every' ? 1000 : 0),
        after: attrNumber(node, 'after', scopes, 0),
        times: Math.trunc(attrNumber(node, 'times', scopes, 0)),
        active,
        run: () => {
          if (!props.interactive) return
          runStatements(setSource.replace(/^\{([\s\S]*=[\s\S]*)\}$/, '$1'), ctxFor(scopes))
          emit('interact')
        }
      })
    }

    function renderStat(node, scopes, key) {
      const icon = iconName(attrText(node, 'icon', scopes))
      const unit = attrText(node, 'unit', scopes)
      const hint = attrText(node, 'hint', scopes) || attrText(node, 'sub', scopes) || attrText(node, 'note', scopes)
      const trend = attrText(node, 'trend', scopes)
      const value = node.children.length ? renderChildren(node.children, scopes, key) : attrText(node, 'value', scopes)
      return h('div', withCommon(node, scopes, key, 'sui-stat'), [
        h('div', { class: 'sui-stat-label' }, [icon ? h('i', { class: `ph ph-${icon}` }) : null, attrText(node, 'label', scopes)]),
        h('div', { class: 'sui-stat-value' }, [
          h('span', { class: 'sui-stat-number' }, value),
          unit ? h('span', { class: 'sui-stat-unit' }, unit) : null,
          trend ? h('span', { class: `sui-stat-trend ${/^[-−↓]/.test(trend) ? 'is-down' : 'is-up'}` }, trend) : null
        ]),
        hint ? h('div', { class: 'sui-stat-hint' }, hint) : null
      ])
    }

    function renderProgress(node, scopes, key) {
      const max = attrNumber(node, 'max', scopes, 100) || 100
      const value = attrNumber(node, 'value', scopes, 0)
      const pct = Math.max(0, Math.min(100, (value / max) * 100))
      const label = attrText(node, 'label', scopes)
      const showValue = node.attrs.show !== 'false'
      const text = attrText(node, 'text', scopes) || `${Math.round(pct)}%`
      return h('div', withCommon(node, scopes, key, 'sui-progress'), [
        label || showValue ? h('div', { class: 'sui-progress-head' }, [
          h('span', null, label),
          showValue ? h('span', { class: 'sui-progress-value' }, text) : null
        ]) : null,
        h('div', { class: 'sui-progress-track' }, [h('div', { class: 'sui-progress-fill', style: `width:${pct}%` })])
      ])
    }

    function renderStep(node, scopes, key) {
      const done = attrBool(node, 'done', scopes)
      const active = attrBool(node, 'active', scopes)
      const icon = iconName(attrText(node, 'icon', scopes))
      const title = attrText(node, 'title', scopes)
      const time = attrText(node, 'time', scopes)
      const cls = ['sui-step', done ? 'is-done' : '', active ? 'is-active' : ''].filter(Boolean).join(' ')
      return h('div', withCommon(node, scopes, key, cls), [
        h('div', { class: 'sui-step-marker' }, [
          done ? h('i', { class: 'ph-bold ph-check' }) : (icon ? h('i', { class: `ph ph-${icon}` }) : null)
        ]),
        h('div', { class: 'sui-step-body' }, [
          time ? h('div', { class: 'sui-step-time' }, time) : null,
          title ? h('div', { class: 'sui-step-title' }, title) : null,
          node.children.length ? h('div', { class: 'sui-step-desc' }, renderChildren(node.children, scopes, key)) : null
        ])
      ])
    }

    function renderButton(node, scopes, key) {
      const variant = String(node.attrs.variant || node.attrs.kind || 'secondary').trim().toLowerCase()
      const size = String(node.attrs.size || '').trim().toLowerCase()
      const icon = iconName(attrText(node, 'icon', scopes))
      const sends = Object.prototype.hasOwnProperty.call(node.attrs, 'send')
      const disabled = attrBool(node, 'disabled', scopes) || (sends && !props.canSend)
      const base = withCommon(node, scopes, key, [
        'sui-btn',
        `sui-btn-${['primary', 'secondary', 'ghost', 'outline', 'danger', 'link'].includes(variant) ? variant : 'secondary'}`,
        size === 'sm' || size === 'lg' ? `sui-btn-${size}` : '',
        attrBool(node, 'full', scopes) || attrBool(node, 'block', scopes) ? 'sui-btn-full' : '',
        sends ? 'sui-btn-send' : ''
      ].filter(Boolean).join(' '))
      const label = node.children.length ? renderChildren(node.children, scopes, key) : attrText(node, 'label', scopes)
      return h('button', { ...base, type: 'button', disabled, role: undefined, tabindex: undefined }, [
        icon ? h('i', { class: `ph ph-${icon}` }) : null,
        label,
        sends ? h('i', { class: 'ph ph-arrow-up-right sui-btn-send-mark' }) : null
      ])
    }

    function fieldHead(label, valueText) {
      if (!label && !valueText) return null
      return h('div', { class: 'sui-field-head' }, [
        h('span', { class: 'sui-field-label' }, label),
        valueText ? h('span', { class: 'sui-field-value' }, valueText) : null
      ])
    }

    function renderSlider(node, scopes, key) {
      const min = attrNumber(node, 'min', scopes, 0)
      const max = attrNumber(node, 'max', scopes, 100)
      const step = attrNumber(node, 'step', scopes, 1) || 1
      const binding = bindingOf(node, scopes, key, attrNumber(node, 'value', scopes, min))
      const current = Number(binding.get())
      const value = Number.isFinite(current) ? Math.min(max, Math.max(min, current)) : min
      const unit = attrText(node, 'unit', scopes)
      const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
      const display = node.attrs.display !== undefined ? attrText(node, 'display', scopes) : `${formatDisplayValue(value)}${unit}`
      return h('div', withCommon(node, scopes, key, 'sui-field sui-slider'), [
        fieldHead(attrText(node, 'label', scopes), display),
        h('input', {
          class: 'sui-range',
          type: 'range',
          min,
          max,
          step,
          value,
          style: `--sui-fill:${pct}%`,
          disabled: !props.interactive,
          onInput: (event) => binding.set(Number(event.target.value)),
          onPointerdown: event => event.stopPropagation(),
          onTouchstart: event => event.stopPropagation()
        }),
        attrBool(node, 'ticks', scopes) || node.attrs['min-label'] || node.attrs['max-label']
          ? h('div', { class: 'sui-range-ticks' }, [
            h('span', null, attrText(node, 'min-label', scopes) || `${formatDisplayValue(min)}${unit}`),
            h('span', null, attrText(node, 'max-label', scopes) || `${formatDisplayValue(max)}${unit}`)
          ])
          : null
      ])
    }

    function renderStepper(node, scopes, key) {
      const min = attrNumber(node, 'min', scopes, -Infinity)
      const max = attrNumber(node, 'max', scopes, Infinity)
      const step = attrNumber(node, 'step', scopes, 1) || 1
      const binding = bindingOf(node, scopes, key, attrNumber(node, 'value', scopes, Number.isFinite(min) ? min : 0))
      const value = Number(binding.get()) || 0
      const unit = attrText(node, 'unit', scopes)
      const change = delta => (event) => {
        event.stopPropagation()
        const next = Math.round((value + delta) * 1e6) / 1e6
        binding.set(Math.min(max, Math.max(min, next)))
      }
      return h('div', withCommon(node, scopes, key, 'sui-field sui-stepper-field'), [
        h('span', { class: 'sui-field-label' }, attrText(node, 'label', scopes)),
        h('div', { class: 'sui-stepper' }, [
          h('button', { type: 'button', class: 'sui-stepper-btn', disabled: !props.interactive || value <= min, onClick: change(-step), 'aria-label': '减少' }, [h('i', { class: 'ph-bold ph-minus' })]),
          h('span', { class: 'sui-stepper-value' }, [formatDisplayValue(value), unit ? h('small', null, unit) : null]),
          h('button', { type: 'button', class: 'sui-stepper-btn', disabled: !props.interactive || value >= max, onClick: change(step), 'aria-label': '增加' }, [h('i', { class: 'ph-bold ph-plus' })])
        ])
      ])
    }

    function renderInput(node, scopes, key) {
      const isArea = node.tag === 'textarea'
      const type = String(node.attrs.type || 'text').toLowerCase()
      const isNumber = type === 'number'
      const binding = bindingOf(node, scopes, key, isNumber ? attrNumber(node, 'value', scopes, '') : attrText(node, 'value', scopes))
      const value = binding.get()
      const label = attrText(node, 'label', scopes)
      const prefix = attrText(node, 'prefix', scopes)
      const suffix = attrText(node, 'suffix', scopes) || attrText(node, 'unit', scopes)
      const control = h(isArea ? 'textarea' : 'input', {
        class: isArea ? 'sui-input sui-textarea' : 'sui-input',
        type: isArea ? undefined : (type === 'date' || type === 'time' ? type : 'text'),
        inputmode: isNumber ? 'decimal' : undefined,
        rows: isArea ? Math.max(2, Math.min(8, attrNumber(node, 'rows', scopes, 3))) : undefined,
        value: value ?? '',
        placeholder: attrText(node, 'placeholder', scopes),
        maxlength: 500,
        disabled: !props.interactive,
        onInput: (event) => {
          const raw = event.target.value
          if (!isNumber) {
            binding.set(raw)
            return
          }
          const normalized = raw.replace(/[，,]/g, '')
          const n = Number(normalized)
          binding.set(normalized.trim() === '' ? '' : (Number.isFinite(n) && !/[.]$/.test(normalized) ? n : normalized))
        },
        onKeydown: event => event.stopPropagation()
      })
      return h('label', withCommon(node, scopes, key, 'sui-field sui-input-field'), [
        label ? h('span', { class: 'sui-field-label' }, label) : null,
        prefix || suffix
          ? h('span', { class: 'sui-input-group' }, [prefix ? h('span', { class: 'sui-input-affix' }, prefix) : null, control, suffix ? h('span', { class: 'sui-input-affix' }, suffix) : null])
          : control
      ])
    }

    function renderToggle(node, scopes, key) {
      const binding = bindingOf(node, scopes, key, attrBool(node, 'value', scopes))
      const on = !!binding.get()
      const label = node.children.length ? renderChildren(node.children, scopes, key) : attrText(node, 'label', scopes)
      return h('div', withCommon(node, scopes, key, 'sui-toggle-row'), [
        h('span', { class: 'sui-toggle-label' }, label),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          class: ['sui-switch', on ? 'is-on' : ''].join(' '),
          disabled: !props.interactive,
          onClick: (event) => { event.stopPropagation(); binding.set(!on) }
        }, [h('span', { class: 'sui-switch-thumb' })])
      ])
    }

    function renderCheckbox(node, scopes, key) {
      const hasValue = Object.prototype.hasOwnProperty.call(node.attrs, 'value')
      const itemValue = hasValue ? attrValue(node, 'value', scopes) : undefined
      const binding = bindingOf(node, scopes, key, hasValue ? [] : false)
      const bound = binding.get()
      const checked = Array.isArray(bound) && hasValue ? bound.some(item => sameValue(item, itemValue)) : !!bound
      const label = node.children.length ? renderChildren(node.children, scopes, key) : attrText(node, 'label', scopes)
      const toggle = (event) => {
        event.stopPropagation()
        if (Array.isArray(bound) && hasValue) {
          const next = checked ? bound.filter(item => !sameValue(item, itemValue)) : [...bound, itemValue]
          binding.set(next)
        } else {
          binding.set(!checked)
        }
      }
      return h('div', {
        ...withCommon(node, scopes, key, ['sui-check', checked ? 'is-checked' : ''].join(' ')),
        role: 'checkbox',
        'aria-checked': checked ? 'true' : 'false',
        tabindex: '0',
        onClick: toggle
      }, [
        h('span', { class: 'sui-check-box' }, [checked ? h('i', { class: 'ph-bold ph-check' }) : null]),
        h('span', { class: 'sui-check-label' }, label)
      ])
    }

    function renderChips(node, scopes, key) {
      const multi = attrBool(node, 'multi', scopes) || attrBool(node, 'multiple', scopes)
      const options = normalizeOptions(attrData(node, 'options', scopes))
      const binding = bindingOf(node, scopes, key, multi ? [] : undefined)
      const current = binding.get()
      const sendTemplate = node.attrs.send
      const segmented = node.tag === 'segmented' || String(node.attrs.variant || '') === 'segmented'
      const label = attrText(node, 'label', scopes)
      const isActive = option => (multi ? (Array.isArray(current) && current.some(item => sameValue(item, option.value))) : sameValue(current, option.value))
      return h('div', withCommon(node, scopes, key, 'sui-field'), [
        label ? h('span', { class: 'sui-field-label' }, label) : null,
        h('div', { class: segmented ? 'sui-segmented' : 'sui-chips' }, options.map((option, index) => {
          const active = isActive(option)
          return h('button', {
            key: index,
            type: 'button',
            class: [segmented ? 'sui-segment' : 'sui-chip', active ? 'is-active' : ''].join(' '),
            disabled: !props.interactive || (sendTemplate !== undefined && !props.canSend),
            onClick: (event) => {
              event.stopPropagation()
              if (multi) {
                const list = Array.isArray(current) ? current : []
                binding.set(active ? list.filter(item => !sameValue(item, option.value)) : [...list, option.value])
              } else {
                binding.set(option.value)
              }
              if (sendTemplate !== undefined && props.canSend) {
                const frame = { value: option.value, label: option.label }
                const text = String(sendTemplate).trim() ? renderTemplate(String(sendTemplate), ctxFor([...scopes, frame])) : option.label
                if (text) emit('send', text)
              }
            }
          }, [option.icon && iconName(option.icon) ? h('i', { class: `ph ph-${iconName(option.icon)}` }) : null, option.label])
        }))
      ])
    }

    function renderSelect(node, scopes, key) {
      const options = normalizeOptions(attrData(node, 'options', scopes))
      const binding = bindingOf(node, scopes, key, options[0]?.value)
      const current = binding.get()
      const index = options.findIndex(option => sameValue(option.value, current))
      return h('label', withCommon(node, scopes, key, 'sui-field sui-input-field'), [
        node.attrs.label ? h('span', { class: 'sui-field-label' }, attrText(node, 'label', scopes)) : null,
        h('span', { class: 'sui-select-wrap' }, [
          h('select', {
            class: 'sui-input sui-select',
            value: index >= 0 ? String(index) : '',
            disabled: !props.interactive,
            onChange: (event) => {
              const option = options[Number(event.target.value)]
              if (option) binding.set(option.value)
            }
          }, [
            index < 0 ? h('option', { value: '', disabled: true }, attrText(node, 'placeholder', scopes, '请选择')) : null,
            ...options.map((option, i) => h('option', { key: i, value: String(i) }, option.label))
          ]),
          h('i', { class: 'ph ph-caret-down sui-select-caret' })
        ])
      ])
    }

    function renderRating(node, scopes, key) {
      const max = Math.max(1, Math.min(10, Math.trunc(attrNumber(node, 'max', scopes, 5))))
      const binding = bindingOf(node, scopes, key, attrNumber(node, 'value', scopes, 0))
      const value = Number(binding.get()) || 0
      return h('div', withCommon(node, scopes, key, 'sui-field'), [
        node.attrs.label ? h('span', { class: 'sui-field-label' }, attrText(node, 'label', scopes)) : null,
        h('div', { class: 'sui-rating' }, Array.from({ length: max }, (_, i) => h('button', {
          key: i,
          type: 'button',
          class: ['sui-star', i < value ? 'is-on' : ''].join(' '),
          disabled: !props.interactive,
          onClick: (event) => { event.stopPropagation(); binding.set(i + 1 === value ? 0 : i + 1) }
        }, [h('i', { class: i < value ? 'ph-fill ph-star' : 'ph ph-star' })])))
      ])
    }

    function renderTabs(node, scopes, key) {
      const entries = expand(node.children, scopes, key).filter(entry => entry.node.type === 'el' && entry.node.tag === 'tab')
      if (entries.length === 0) return h('div', { key }, renderChildren(node.children, scopes, key))
      const tabs = entries.map((entry, index) => {
        const valueAttr = attrValue(entry.node, 'value', entry.scopes)
        return {
          ...entry,
          value: valueAttr === undefined || valueAttr === '' ? index : valueAttr,
          label: attrText(entry.node, 'label', entry.scopes) || attrText(entry.node, 'title', entry.scopes) || String(index + 1),
          icon: iconName(attrText(entry.node, 'icon', entry.scopes))
        }
      })
      const binding = bindingOf(node, scopes, key, tabs[0].value)
      let current = binding.get()
      if (!tabs.some(tab => sameValue(tab.value, current))) current = tabs[0].value
      const active = tabs.find(tab => sameValue(tab.value, current)) || tabs[0]
      const variant = String(node.attrs.variant || '').trim()
      return h('div', withCommon(node, scopes, key, 'sui-tabs'), [
        h('div', { class: variant === 'pills' || variant === 'pill' ? 'sui-chips sui-tab-pills' : 'sui-segmented sui-tab-bar', role: 'tablist' }, tabs.map((tab, index) => h('button', {
          key: index,
          type: 'button',
          role: 'tab',
          'aria-selected': tab === active ? 'true' : 'false',
          class: [variant === 'pills' || variant === 'pill' ? 'sui-chip' : 'sui-segment', tab === active ? 'is-active' : ''].join(' '),
          onClick: (event) => { event.stopPropagation(); binding.set(tab.value) }
        }, [tab.icon ? h('i', { class: `ph ph-${tab.icon}` }) : null, tab.label]))),
        h('div', { class: 'sui-tab-panel', key: `${key}-panel-${String(active.value)}` }, renderChildren(active.node.children, active.scopes, active.key))
      ])
    }

    function renderNative(node, scopes, key) {
      const tag = node.tag
      const base = withCommon(node, scopes, key, `sui-${tag}`)
      for (const name of NATIVE_ATTRS[tag] || []) {
        if (node.attrs[name] === undefined) continue
        if (name === 'open' || name === 'reversed') base[name] = true
        else {
          const n = Math.trunc(attrNumber(node, name, scopes, 0))
          if (n > 0) base[name] = Math.min(50, n)
        }
      }
      if ((tag === 'td' || tag === 'th') && ['left', 'center', 'right'].includes(String(node.attrs.align || ''))) {
        base.style = [base.style, `text-align:${node.attrs.align}`].filter(Boolean).join(';')
      }
      if (tag === 'br') return h('br', { key })
      if (tag === 'summary') {
        return h('summary', { ...base, onClick: (event) => event.stopPropagation() }, renderChildren(node.children, scopes, key))
      }
      return h(tag, base, renderChildren(node.children, scopes, key))
    }

    function renderSvg(node, scopes, key) {
      if (node.type === 'text') return renderTemplate(node.value, ctxFor(scopes))
      const tag = SVG_TAG_CASE[node.tag]
      if (!tag) return null
      const attrs = { key }
      const isAnimation = tag === 'animate' || tag === 'animateTransform' || tag === 'animateMotion' || tag === 'set'
      if (isAnimation && SVG_BLOCKED_ANIMATED_ATTRS.test(String(node.attrs.attributename || ''))) return null
      for (const [rawName, rawValue] of Object.entries(node.attrs)) {
        const name = SVG_ATTR_CASE[rawName] || rawName
        if (!SVG_ATTRS.has(name)) continue
        let value = formatDisplayValue(resolveTemplateValue(rawValue, ctxFor(scopes)))
        if (name === 'id') {
          value = scopedId(value)
        } else if (name === 'href') {
          // <use href="#id"> 指向卡片内元素；<image href> 可用 https / 内置资源
          value = resolveUrl(value)
          if (!value || (tag !== 'image' && !value.startsWith('#'))) continue
        } else if (SVG_REF_ATTRS.has(name)) {
          value = sanitizePaintValue(value, scopedId)
          if (!value) continue
        } else if (!isSafeAttributeValue(value)) {
          continue
        }
        attrs[name] = value
      }
      const style = node.attrs.style !== undefined ? sanitizeStyle(renderTemplate(node.attrs.style, ctxFor(scopes)), { resolveUrl, renameKeyframes: renameKeyframes.value || undefined }) : ''
      const onClick = clickHandler(node, scopes)
      const classes = node.attrs.class !== undefined ? classTokens(renderTemplate(node.attrs.class, ctxFor(scopes))) : []
      if (onClick) {
        attrs.onClick = onClick
        classes.push('sui-clickable')
      }
      if (tag === 'svg') {
        classes.push('sui-svg')
        if (props.animate) classes.push('sui-enter')
        if (attrs.width === undefined) attrs.width = '100%'
      }
      if (classes.length) attrs.class = classes.join(' ')
      if (style) attrs.style = style
      return h(tag, attrs, expand(node.children, scopes, key).map(entry => renderSvg(entry.node, entry.scopes, entry.key)))
    }

    return () => {
      generatedThisRender = 0
      const css = stylesheet.value
      return h(Fragment, null, [
        css ? h('style', { key: '__sui-style' }, css) : null,
        ...renderChildren(props.nodes, [], 'n')
      ])
    }
  }
})
