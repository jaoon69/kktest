/**
 * 智能界面的网络字体加载。
 * 只接入纯字体 CSS 服务（内容只有 @font-face），通过 <link> 注入且去重；
 * 默认走国内可访问的 Google Fonts 镜像，失败再回落官方地址。
 */

const FONT_CSS_HOSTS = new Set(['fonts.googleapis.com', 'fonts.loli.net', 'fonts.font.im'])
const GOOGLE_FONT_MIRRORS = ['https://fonts.loli.net', 'https://fonts.googleapis.com']
const FAMILY_REGEX = /^[A-Za-z0-9 ]{2,60}(?::[a-z,@;.0-9]{1,60})?$/
const MAX_FONT_LINKS = 40

const requested = new Set()

function appendStylesheet(hrefs, key) {
  if (typeof document === 'undefined' || requested.has(key) || requested.size >= MAX_FONT_LINKS) return
  requested.add(key)
  let index = 0
  const tryNext = () => {
    if (index >= hrefs.length) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = hrefs[index]
    link.dataset.smartUiFont = key
    index += 1
    link.onerror = () => {
      link.remove()
      tryNext()
    }
    document.head.appendChild(link)
  }
  tryNext()
}

/** 解析 fonts="Ma Shan Zheng, Noto Serif SC:wght@400;700" 并加载。 */
export function loadGoogleFonts(spec) {
  const families = String(spec || '')
    .split(/[,，|]/)
    .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(item => FAMILY_REGEX.test(item))
    .slice(0, 6)
  for (const family of families) {
    const query = `family=${family.replace(/ /g, '+')}&display=swap`
    appendStylesheet(GOOGLE_FONT_MIRRORS.map(base => `${base}/css2?${query}`), family.toLowerCase())
  }
}

/** @import 的字体 CSS：只放行字体服务域名。返回是否已接受。 */
export function loadFontStylesheet(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl || '').trim())
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || !FONT_CSS_HOSTS.has(url.hostname)) return false
  // 这几个域名都是 Google Fonts 的同构镜像，统一按镜像顺序尝试
  appendStylesheet(GOOGLE_FONT_MIRRORS.map(base => `${base}${url.pathname}${url.search}`), url.pathname + url.search)
  return true
}
