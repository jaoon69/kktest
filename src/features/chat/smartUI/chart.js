import { h } from 'vue'
import { formatDisplayValue } from './expr'

export const SMART_UI_PALETTE = Object.freeze([
  'var(--ui-accent)',
  'var(--ui-good)',
  'var(--ui-warn)',
  '#AF52DE',
  '#FF375F',
  '#5AC8FA',
  '#FFD60A',
  '#8E8E93'
])

const MAX_POINTS = 60

function toNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 归一化单序列数据：[[label, value, color?]] / [{label, value, color}] / [numbers]
 * @returns {Array<{ label: string, value: number, color: string }>}
 */
export function normalizeChartData(data, colors = []) {
  const list = Array.isArray(data) ? data.slice(0, MAX_POINTS) : []
  return list.map((item, index) => {
    let label = ''
    let value = 0
    let color = ''
    if (Array.isArray(item)) {
      label = formatDisplayValue(item[0])
      value = toNumber(item[1])
      color = typeof item[2] === 'string' ? item[2] : ''
    } else if (item && typeof item === 'object') {
      label = formatDisplayValue(item.label ?? item.name ?? item.x ?? '')
      value = toNumber(item.value ?? item.y ?? item.v)
      color = typeof item.color === 'string' ? item.color : ''
    } else {
      label = String(index + 1)
      value = toNumber(item)
    }
    return { label, value, color: color || colors[index] || SMART_UI_PALETTE[index % SMART_UI_PALETTE.length] }
  })
}

/**
 * 归一化多序列：series=[{ name, data:[n...], color }]
 */
function normalizeSeries(series, labels, colors = []) {
  const list = Array.isArray(series) ? series.slice(0, 6) : []
  return list.map((item, index) => ({
    name: formatDisplayValue(item?.name ?? `系列${index + 1}`),
    color: (typeof item?.color === 'string' && item.color) || colors[index] || SMART_UI_PALETTE[index % SMART_UI_PALETTE.length],
    values: (Array.isArray(item?.data) ? item.data : []).slice(0, MAX_POINTS).map(toNumber)
  })).filter(item => item.values.length > 0).map(item => ({
    ...item,
    labels: Array.isArray(labels) ? labels.map(formatDisplayValue) : item.values.map((_, i) => String(i + 1))
  }))
}

function formatValue(value, unit) {
  const text = formatDisplayValue(value)
  return unit ? `${text}${unit}` : text
}

function renderLegend(entries) {
  if (entries.length <= 1) return null
  return h('div', { class: 'sui-chart-legend' }, entries.map((entry, index) => h('span', { class: 'sui-chart-legend-item', key: index }, [
    h('i', { class: 'sui-chart-dot', style: `background:${entry.color}` }),
    entry.label
  ])))
}

function renderBar(points, opts) {
  const max = opts.max > 0 ? opts.max : Math.max(0, ...points.map(p => p.value)) || 1
  const height = Math.max(80, Math.min(260, opts.height || 140))
  return h('div', { class: 'sui-chart sui-chart-bar' }, [
    h('div', { class: 'sui-bar-plot', style: `height:${height}px` }, points.map((point, index) => {
      const pct = Math.max(0, Math.min(100, (point.value / max) * 100))
      return h('div', { class: 'sui-bar-col', key: index }, [
        h('span', { class: 'sui-bar-value' }, formatValue(point.value, opts.unit)),
        h('div', { class: 'sui-bar-track' }, [
          h('div', { class: 'sui-bar-fill', style: `height:${pct}%;background:${point.color}` })
        ])
      ])
    })),
    h('div', { class: 'sui-bar-labels' }, points.map((point, index) => h('span', { key: index, class: 'sui-bar-label' }, point.label)))
  ])
}

function renderHBar(points, opts) {
  const max = opts.max > 0 ? opts.max : Math.max(0, ...points.map(p => p.value)) || 1
  return h('div', { class: 'sui-chart sui-chart-hbar' }, points.map((point, index) => {
    const pct = Math.max(0, Math.min(100, (point.value / max) * 100))
    return h('div', { class: 'sui-hbar-row', key: index }, [
      h('div', { class: 'sui-hbar-head' }, [
        h('span', { class: 'sui-hbar-label' }, point.label),
        h('span', { class: 'sui-hbar-value' }, formatValue(point.value, opts.unit))
      ]),
      h('div', { class: 'sui-hbar-track' }, [
        h('div', { class: 'sui-hbar-fill', style: `width:${pct}%;background:${point.color}` })
      ])
    ])
  }))
}

function renderLine(seriesList, opts) {
  const all = seriesList.flatMap(series => series.values)
  if (all.length === 0) return null
  const rawMin = Math.min(...all)
  const rawMax = Math.max(...all)
  const min = Number.isFinite(opts.min) ? opts.min : (rawMin >= 0 && rawMin / (rawMax || 1) < 0.5 ? 0 : rawMin)
  const max = opts.max > min ? opts.max : (rawMax === min ? min + 1 : rawMax)
  const height = Math.max(80, Math.min(260, opts.height || 130))
  const W = 300
  const H = 100
  const pad = 6
  const toXY = (value, index, count) => {
    const x = count <= 1 ? W / 2 : (index / (count - 1)) * W
    const y = pad + (1 - (value - min) / (max - min)) * (H - pad * 2)
    return [x, y]
  }

  const paths = []
  const dots = []
  seriesList.forEach((series, sIndex) => {
    const count = series.values.length
    const coords = series.values.map((value, index) => toXY(value, index, count))
    const line = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
    if (opts.area) {
      const area = `${line} L${coords[coords.length - 1][0].toFixed(2)},${H} L${coords[0][0].toFixed(2)},${H} Z`
      paths.push(h('path', { key: `a${sIndex}`, d: area, fill: series.color, 'fill-opacity': '0.14', stroke: 'none' }))
    }
    paths.push(h('path', {
      key: `l${sIndex}`,
      d: line,
      fill: 'none',
      stroke: series.color,
      'stroke-width': '2.25',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'vector-effect': 'non-scaling-stroke',
      class: 'sui-line-path'
    }))
    if (count <= 24) {
      coords.forEach(([x, y], index) => {
        dots.push(h('span', {
          key: `d${sIndex}-${index}`,
          class: 'sui-line-dot',
          style: `left:${(x / W) * 100}%;top:${(y / H) * 100}%;background:${series.color}`,
          title: `${series.labels[index] ?? ''} ${formatValue(series.values[index], opts.unit)}`
        }))
      })
    }
  })

  const labels = seriesList[0].labels
  const labelStep = Math.max(1, Math.ceil(labels.length / 6))
  return h('div', { class: 'sui-chart sui-chart-line' }, [
    h('div', { class: 'sui-line-plot', style: `height:${height}px` }, [
      h('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'sui-line-svg' }, paths),
      ...dots,
      h('span', { class: 'sui-line-range is-max' }, formatValue(max, opts.unit)),
      h('span', { class: 'sui-line-range is-min' }, formatValue(min, opts.unit))
    ]),
    h('div', { class: 'sui-line-labels' }, labels.map((label, index) => h('span', {
      key: index,
      style: index % labelStep === 0 || index === labels.length - 1 ? '' : 'visibility:hidden'
    }, label))),
    renderLegend(seriesList.map(series => ({ label: series.name, color: series.color })))
  ])
}

function renderPie(points, opts) {
  const total = points.reduce((acc, point) => acc + Math.max(0, point.value), 0) || 1
  const radius = 15.9155
  const strokeWidth = opts.donut ? 6.5 : radius * 2
  const r = opts.donut ? radius : radius / 2
  const circumference = 2 * Math.PI * r
  let offset = 0
  const slices = points.map((point, index) => {
    const fraction = Math.max(0, point.value) / total
    const dash = fraction * circumference
    const slice = h('circle', {
      key: index,
      cx: '21',
      cy: '21',
      r: String(r),
      fill: 'none',
      stroke: point.color,
      'stroke-width': String(strokeWidth),
      'stroke-dasharray': `${dash.toFixed(3)} ${(circumference - dash).toFixed(3)}`,
      'stroke-dashoffset': String((-offset).toFixed(3)),
      class: 'sui-pie-slice'
    })
    offset += dash
    return slice
  })
  return h('div', { class: 'sui-chart sui-chart-pie' }, [
    h('div', { class: 'sui-pie-figure' }, [
      h('svg', { viewBox: '0 0 42 42', class: 'sui-pie-svg' }, [
        h('g', { transform: 'rotate(-90 21 21)' }, slices)
      ]),
      opts.donut && opts.center ? h('div', { class: 'sui-pie-center' }, opts.center) : null
    ]),
    h('div', { class: 'sui-pie-legend' }, points.map((point, index) => h('div', { class: 'sui-pie-legend-row', key: index }, [
      h('i', { class: 'sui-chart-dot', style: `background:${point.color}` }),
      h('span', { class: 'sui-pie-legend-label' }, point.label),
      h('span', { class: 'sui-pie-legend-value' }, `${formatValue(point.value, opts.unit)} · ${Math.round((Math.max(0, point.value) / total) * 100)}%`)
    ])))
  ])
}

/**
 * @param {{ type?: string, data?: any, series?: any, labels?: any, unit?: string, height?: number, max?: number, min?: number, colors?: string[], center?: string }} options
 */
export function renderSmartUIChart(options = {}) {
  const type = String(options.type || 'bar').toLowerCase()
  const colors = Array.isArray(options.colors) ? options.colors.filter(c => typeof c === 'string') : []
  const opts = {
    unit: options.unit ? String(options.unit) : '',
    height: toNumber(options.height),
    max: toNumber(options.max),
    min: options.min === undefined || options.min === '' ? undefined : toNumber(options.min),
    center: options.center ? String(options.center) : '',
    area: type === 'area',
    donut: type === 'donut' || type === 'ring'
  }

  if (type === 'line' || type === 'area') {
    let seriesList = normalizeSeries(options.series, options.labels, colors)
    if (seriesList.length === 0) {
      const points = normalizeChartData(options.data, colors)
      if (points.length === 0) return h('div', { class: 'sui-chart-empty' }, '暂无数据')
      seriesList = [{
        name: '',
        color: colors[0] || SMART_UI_PALETTE[0],
        values: points.map(p => p.value),
        labels: points.map(p => p.label)
      }]
    }
    return renderLine(seriesList, opts)
  }

  const points = normalizeChartData(options.data, colors)
  if (points.length === 0) return h('div', { class: 'sui-chart-empty' }, '暂无数据')
  if (type === 'pie' || type === 'donut' || type === 'ring') return renderPie(points, opts)
  if (type === 'hbar' || type === 'rank' || points.length > 7) return renderHBar(points, opts)
  const singleColor = colors.length <= 1 && !points.some((p, i) => p.color !== (colors[i] || SMART_UI_PALETTE[i % SMART_UI_PALETTE.length]))
  const barPoints = singleColor ? points.map(p => ({ ...p, color: colors[0] || SMART_UI_PALETTE[0] })) : points
  return renderBar(barPoints, opts)
}
