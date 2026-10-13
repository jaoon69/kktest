/**
 * 智能界面（Intelligent UI）提示词。
 *
 * 设计要点：
 * - 判断优先于语法：先教模型“什么时候值得用”，再给能力清单，避免每句话都套卡片。
 * - 角色优先：界面是角色“拿出来给你看”的东西，口吻、审美都跟着角色走。
 * - 框架层面开放：样式表、字体、图片、生图、语音、定时器、状态表达式都可用，模型自己决定外观与交互。
 * - 详细说明放主系统提示（稳定、可缓存）；末尾只放一句提醒，减少对角色扮演的干扰。
 */

import { resolveImagePromptStyle, usesNaturalLanguageImagePrompt } from '../../imageGen/promptProfiles'

const JUDGMENT = `你可以在回复中嵌入一块“智能界面”：用 <ui>…</ui> 写一段 HTML 风格的标记，聊天里会把它渲染成原生的可交互界面，和文字消息自然混排。它几乎就是一块小网页：可以写样式表、用网络字体、放图片、生成插画、朗读台词、跑定时器、保存状态。

【什么时候用】
界面是表达方式，不是装饰。先判断：只看文字的话，对方是不是还得自己在脑子里排版、换算、对比、想象画面，或者得再问一轮才能拿到想要的东西？是，才用。
- 数字与方案：预算、份量、配比、行程、日程 → 参数格、表格、能拖动的即时计算
- 结构与过程：步骤、时间线、教程、原理拆解 → 步骤条、标签页、SVG 示意图
- 需要对方参与：测验、问卷、小游戏、点单、剧情分支 → 可点的选项，点了会发回给你
- 角色世界里“拿出来”的东西：手写便签、菜单、票根、账本、朋友圈 / 推特 / 小红书截图、聊天记录、报纸、信件、游戏面板、小剧场
不用：闲聊、撒娇、情绪交流、安慰、简短问答、纯叙事。大多数回复都不需要界面；一轮最多一个界面。
保持角色：界面里的文案也用角色的口吻与审美；界面外照常说话，不要说“我为你生成了一个界面”。界面里已经展示的内容，文字不再复述，文字只负责引出、点评、收尾。

【格式】
- <ui> 整块算作一条消息，可以跨多行（这是“每行一条消息”的例外）；界面里不要写 *旁白*、贴纸或其他 token。
- 直接输出标记，不要包进代码块；不要写 <script>、onclick 之类的事件属性。
- 手机屏宽约 320px（width="full" 时约 360px）；表格不超过 4 列，<row> 会自动换行。比较运算两边留空格（n < 3）。`

const BLOCKS = `【积木】可自由嵌套组合，也可以直接用普通 HTML 标签（div span p h1-h6 ul li table section header footer figure blockquote details……）
布局：<col gap> <row gap align justify> <grid cols="2"> <card tone> <divider/> <stage>（相对定位的舞台）<layer>（铺满舞台的绝对定位层）
文字：<text size weight tone> <badge tone> <icon name="Phosphor图标名"/> <b> <small> <mark> <code>
数据：<stat label value unit hint/> <kv k v/> <progress value max/> <chart type="bar|hbar|line|area|pie|donut" data="[['周一',3],['周二',5]]" unit/> <steps><step title time done>说明</step></steps>
图形：<svg viewBox>，支持 path rect circle text、渐变、clipPath、mask、pattern、filter（模糊/投影）、animate 动画、<image href>
控件：<button send | set | speak variant="primary|secondary|ghost"> <slider bind min max/> <stepper bind/> <input bind/> <textarea bind/> <toggle bind/> <checkbox bind/> <chips bind options multi/> <select bind options/> <tabs bind><tab value label>…</tab></tabs> <rating bind/>
tone：accent good warn bad muted`

const MEDIA_BASE = `【媒体】
- <img src="https://…"> 真实图片链接；<img src="avatar:char"> / avatar:user 是双方头像；<avatar who="char|user" size="40"/> 圆形头像（无图时自动显示表情或首字）
- <img src="sprite:表情名"> 角色立绘（有配置时，例：sprite:normal、sprite:害羞）
- <voice text="台词" who="char"/> 语音条，点按用角色音色朗读；任何元素加 speak="台词" 点击即朗读；set 里可调用 speak('台词')
- 这些地址也能用在 CSS：background-image: url(avatar:char)`

const STYLE_AND_LOGIC = `【样式】
- 每个元素都能写 style 和 class；<ui> 里可放 <style>…</style>，选择器自动只作用于这张界面：可用 class、#id、::before/::after、:hover/:active/:nth-child、@keyframes、@media、CSS 变量、渐变、阴影、滤镜、backdrop-filter、clip-path、transform、transition。积木名也能当选择器（card、row、stat、btn、chip……）。
- 字体：<ui fonts="Ma Shan Zheng, Noto Serif SC"> 加载 Google Fonts 字体，然后 font-family 直接用；也可写 @font-face（https 字体文件）。中文可选：Noto Sans SC、Noto Serif SC、ZCOOL KuaiLe、ZCOOL XiaoWei、ZCOOL QingKe HuangYou、Ma Shan Zheng、Zhi Mang Xing、Liu Jian Mao Cao、Long Cang。
- 外壳：默认是一张主题卡片；<ui frame="none"> 去掉外壳完全自己设计；<ui width="full"> 占满聊天宽度；<ui accent="#ff7a59"> 换主色。
- 主题变量（深浅色自适应）：var(--ui-accent) var(--ui-surface) var(--ui-surface-2) var(--ui-text) var(--ui-muted) var(--ui-border)；自定义配色时自己保证在深色模式下也清晰。

【状态与交互】
- <ui state="{n: 4, page: 0, picked: []}"> 声明状态。任何文本和属性里都能写 {表达式}：{n * 0.4}、{round(total / n, 1)}、{len(picked)}、{score >= 60 ? '及格' : '再来'}
- bind="n" 把控件绑到状态；set="n = n + 1; page = 2" 点击时修改状态（任何元素都能加 set）；if="表达式" 条件显示；each="item, i in list" 重复渲染；class="{on ? 'lit' : ''}" 动态样式
- <timer every="1000" set="t = t + 1" while="running"/> 定时执行（after="2000" 延迟执行一次，times 限次数），可做倒计时、自动播放、打字机效果、小游戏循环
- send="我选了{picked}" 点击后以用户身份把这句话发给你，你下一轮接着回应——用于提交答案、做决定、推进剧情。只改界面、不需要你回应的操作用 set。
- 可读变量：{char.name} {user.name} {today} {clock} {weekday}
- 函数：round floor ceil abs min max sum avg len fixed fmt pct money clamp includes join split slice range map filter find count sort rand choice shuffle push remove toggle reset speak stopVoice

【设计】
- 一个界面一个目的；最有用的放最前面；别把整篇回答塞进去。
- 对方可能想调的数（人数、预算、时长）做成滑块或步进器，结果实时算出来。选项 2–4 个、文案短。
- 模仿某个 App 或实物时，抓住它的标志性细节（配色、圆角、字体、图标、排版密度），做到一眼认出来。
- 历史里的 <ui-archived> 是早前界面的摘要存档，不要输出这个标签。`

const EXAMPLES = `【示例一】对方说想周末请朋友吃烤羊腿，人数还没定：
人数没定也没事，我按人头帮你算好了，拖一下就行
<ui state="{n: 6}">
<card>
<h3>周日烤羊腿</h3>
<slider bind="n" min="2" max="12" label="几个人吃" unit="人"/>
<grid cols="3">
<stat label="带骨羊腿" value="{fixed(n * 0.4, 1)}" unit="kg"/>
<stat label="土豆" value="{n * 250}" unit="g"/>
<stat label="烤制" value="{60 + n * 5}" unit="分钟"/>
</grid>
<row><button send="帮我配两道素菜">配两道素菜</button><button variant="ghost" send="给我{n}人份的采购清单">采购清单</button></row>
</card>
</ui>

【示例二】角色把自己刚发的动态截图甩过来：
*把手机屏幕怼到你面前* 你看他们都在评论什么
<ui frame="none" width="full" fonts="Noto Sans SC" state="{liked: false}">
<style>
.post { background: #fff; color: #0f1419; border-radius: 16px; padding: 14px; font-family: 'Noto Sans SC', sans-serif; border: 1px solid #eff3f4 }
.head { display: flex; gap: 10px; align-items: center }
.name { font-weight: 700 } .handle { color: #536471; font-size: 13px }
.actions { display: flex; justify-content: space-between; color: #536471; font-size: 13px; margin-top: 10px }
.lit { color: #f91880 }
</style>
<div class="post">
<div class="head"><avatar who="char" size="40"/><div><div class="name">{char.name}</div><div class="handle">@{char.name} · 2小时</div></div></div>
<p style="margin: 8px 0">今天又被某人放鸽子了，但是晚霞很好看，原谅你一次</p>
<div class="actions"><span><icon name="chat-circle"/> 12</span><span><icon name="repeat"/> 3</span><span class="{liked ? 'lit' : ''}" set="liked = !liked"><icon name="heart" weight="{liked ? 'fill' : 'regular'}"/> {liked ? 129 : 128}</span></div>
</div>
</ui>`

function buildImageGenSection(store) {
  if (!store?.allowAIImageGeneration) return ''
  const style = resolveImagePromptStyle(store.vnImageGenConfig || {})
  const promptHint = usesNaturalLanguageImagePrompt(style)
    ? 'gen 写简洁的自然语言画面描述（主体、场景、光线、构图、画风）'
    : 'gen 写英文 danbooru 标签，逗号分隔（例：1girl, rain, convenience store, night, warm lighting）'
  return `- <img gen="画面描述" size="square|portrait|landscape|wide" type="scene|char"/> 现场生成插画（调用已配置的生图服务，几秒到几十秒，生成前显示占位）。${promptHint}；type="char" 会自动带上角色外貌设定。每张界面最多 6 张，只在画面确实重要时用（插图、场景、立绘、商品图、帖子配图）。`
}

const INTELLIGENT_UI_REMINDER = '智能界面：只有当界面明显比纯文字更好用时，才输出一个 <ui>…</ui>（能力见 <intelligent_ui>）；闲聊和情感交流只用文字。'

function isSupportedChat(store) {
  const chat = store?.activeChat
  return !!chat && chat.type !== 'group'
}

/**
 * @param {{ allowAIIntelligentUI?: boolean, allowAIImageGeneration?: boolean, vnImageGenConfig?: any, activeChat?: any }} store
 * @returns {{ reference: string, reminder: string }}
 */
export function buildIntelligentUIPrompts(store) {
  if (!store?.allowAIIntelligentUI || !isSupportedChat(store)) {
    return { reference: '', reminder: '' }
  }
  const media = [MEDIA_BASE, buildImageGenSection(store)].filter(Boolean).join('\n')
  return {
    reference: [JUDGMENT, BLOCKS, media, STYLE_AND_LOGIC, EXAMPLES].join('\n\n'),
    reminder: INTELLIGENT_UI_REMINDER
  }
}
