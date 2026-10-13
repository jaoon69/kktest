<template>
  <div
    :class="['chat-message-row', 'chat-smart-ui-row', block.isUser ? 'chat-message-user' : 'chat-message-ai', rowClass]"
    :data-msg-id="block.msgId"
    :data-msg-part="block.msgPartKey || 'message'"
    @click="handleRootClick"
  >
    <ChatMultiSelectCheckbox :visible="multiSelectMode" :selected="isSelected" />

    <div
      v-if="!block.isUser && (block.showAvatar || block.isGroupChat || showChatAvatars)"
      class="w-8 h-8 shrink-0 mr-2 self-end"
    >
      <div
        v-if="block.showAvatar"
        class="chat-avatar chat-avatar-ai w-8 h-8 rounded-full chat-avatar-bg flex items-center justify-center text-sm overflow-hidden"
      >
        <img v-if="block.senderAvatarType === 'image'" :src="block.senderAvatar" class="w-full h-full object-cover">
        <span v-else>{{ block.senderAvatar || '🤖' }}</span>
      </div>
    </div>

    <div class="chat-smart-ui-wrapper" :class="[block.isUser ? 'items-end' : 'items-start', block.animClass, { 'is-full': fullWidth }]">
      <div v-if="block.senderName" class="chat-sender-name text-[12px] mb-1 ml-3">{{ block.senderName }}</div>
      <div
        ref="rootRef"
        class="sui-root"
        :class="{ 'is-readonly': !interactive }"
        :style="rootStyle"
        :data-sui-scope="uid"
        @contextmenu="handleContextMenu"
      >
        <div v-if="!parsed.ready" class="sui-surface">
          <div class="sui-skeleton"><i></i><i></i><i></i></div>
        </div>
        <div v-else :class="surfaceClass" :style="bare ? undefined : surfaceStyle">
          <SmartUIRenderer
            :nodes="parsed.children"
            :state="state"
            :animate="animate"
            :can-send="canSend"
            :interactive="interactive"
            :actions="actions"
            :uid="uid"
            :live="live"
            :media="mediaAdapter"
            :context="uiContext"
            @send="handleSend"
            @interact="handleInteract"
          />
          <div v-if="showStreaming" class="sui-streaming" aria-hidden="true"><span></span><span></span><span></span></div>
        </div>
      </div>
      <div v-if="block.metaText" class="msg-meta" :class="block.isUser ? 'user-meta' : 'ai-meta'">
        {{ block.metaText }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, reactive, ref, useId, watch } from 'vue'
import ChatMultiSelectCheckbox from './ChatMultiSelectCheckbox.vue'
import SmartUIRenderer from '../../smartUI/SmartUIRenderer'
import { parseSmartUIMarkup } from '../../smartUI/markup'
import { cloneStateData, createInitialState } from '../../smartUI/state'
import { useSmartUIHost } from '../../smartUI/host'
import { isSafeExternalUrl, sanitizePaintValue, sanitizeStyle } from '../../smartUI/style'
import { loadGoogleFonts } from '../../smartUI/fonts'
import '../../smartUI/smartUI.css'

const SAVE_DELAY_MS = 500
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, summary, [role="button"], [role="switch"], [role="checkbox"], .sui-clickable'

const props = defineProps({
  block: { type: Object, required: true },
  multiSelectMode: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  showChatAvatars: { type: Boolean, default: false }
})

const emit = defineEmits(['toggle-select', 'context-menu'])

const host = useSmartUIHost()
// script setup 内的计数器会在每个实例中重置；使用 Vue 的实例 ID 隔离样式、动画和 SVG 引用。
const uid = `sui-${useId()}`
const rootRef = ref(null)
const sending = ref(false)
const state = reactive({})
let initialSnapshot = {}
let saveTimer = 0
let dirty = false

const isSelected = computed(() => props.multiSelectMode && props.selected)
const parsed = computed(() => parseSmartUIMarkup(props.block.markup))
const stateSource = computed(() => (parsed.value.ready ? String(parsed.value.rootAttrs?.state ?? '') : null))
const interactive = computed(() => !props.multiSelectMode)
const canSend = computed(() => !!host && host.canSend.value && !sending.value && interactive.value && !props.block.streaming)
const animate = computed(() => !!props.block.animate)
const showStreaming = computed(() => !props.block.complete && !!props.block.streaming)
const rowClass = computed(() => `flex w-full ${props.block.mb} ${props.block.isUser ? 'justify-end' : 'justify-start'} items-end`)

// 内容完整后才发起生图、启动定时器
const live = computed(() => !!props.block.complete && !props.block.streaming)
const rootAttrs = computed(() => parsed.value.rootAttrs || {})
// frame="none"：不要默认卡片外壳，完全由模型自己设计外观
const frameless = computed(() => ['none', 'plain', 'false'].includes(String(rootAttrs.value.frame || '').trim().toLowerCase()))
// width="full"：占满聊天宽度（社交平台界面、小剧场、游戏面板等）
const fullWidth = computed(() => ['full', 'wide', '100%'].includes(String(rootAttrs.value.width || '').trim().toLowerCase()))

// 只有一个顶层 <card> 时，让它自己充当外壳，避免卡片套卡片
const bare = computed(() => {
  if (frameless.value) return true
  const children = parsed.value.children.filter(child => !(child.type === 'el' && child.tag === 'style'))
  return children.length === 1 && children[0].type === 'el' && ['card', 'box', 'panel'].includes(children[0].tag) && !children[0].attrs.each
})
const surfaceClass = computed(() => {
  const classes = [bare.value ? 'sui-bare' : 'sui-surface']
  if (frameless.value) classes.push('sui-frameless')
  const custom = String(rootAttrs.value.class || '').split(/\s+/).filter(token => /^[A-Za-z_][\w-]{0,40}$/.test(token)).slice(0, 8)
  classes.push(...custom.map(token => (token.startsWith('sui-') ? token : `u-${token}`)))
  return classes
})

watch(() => rootAttrs.value.fonts, (fonts) => {
  if (fonts) loadGoogleFonts(fonts)
}, { immediate: true })

const media = host?.media || null
const msgId = () => props.block.msgId
const mediaAdapter = media
  ? {
      resolveAsset: spec => media.resolveAsset(spec),
      avatarOf: who => media.avatarOf(who),
      canGenerate: () => media.canGenerateImages(),
      getImage: key => media.getImage(msgId(), key),
      requestImage: (key, request) => media.requestImage(msgId(), key, request),
      retryImage: (key, request) => media.retryImage(msgId(), key, request),
      speak: (text, options) => media.speak(text, options),
      speaking: media.speaking
    }
  : null
const uiContext = computed(() => (media ? media.context() : {}))

function resolveRootUrl(raw) {
  const value = String(raw || '').trim()
  if (isSafeExternalUrl(value)) return value
  return media?.resolveAsset(value) || ''
}

const rootStyle = computed(() => {
  const accent = sanitizePaintValue(parsed.value.rootAttrs?.accent)
  return accent && !accent.startsWith('url(') ? `--ui-accent:${accent}` : undefined
})
const surfaceStyle = computed(() => sanitizeStyle(String(rootAttrs.value.style || ''), { resolveUrl: resolveRootUrl }) || undefined)

function replaceState(next) {
  for (const key of Object.keys(state)) delete state[key]
  Object.assign(state, next || {})
}

function initState() {
  initialSnapshot = createInitialState(stateSource.value)
  const saved = host?.getState(props.block.msgId, props.block.partIndex)
  replaceState({ ...(cloneStateData(initialSnapshot) || {}), ...(saved || {}) })
}

watch(stateSource, (next) => {
  if (next === null) return
  initState()
}, { immediate: true })

function flushSave() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = 0
  }
  if (!dirty || !host) return
  dirty = false
  host.saveState(props.block.msgId, props.block.partIndex, state)
}

function handleInteract() {
  dirty = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, SAVE_DELAY_MS)
}

const actions = {
  reset() {
    replaceState(cloneStateData(initialSnapshot) || {})
    host?.clearState(props.block.msgId, props.block.partIndex)
    dirty = false
  },
  // set="i = i + 1; speak(lines[i])"：在状态变化时顺带朗读
  speak(text, who = 'char') {
    media?.speak(text, { who: who === 'user' ? 'user' : 'char' })
  },
  stopVoice() {
    media?.stopSpeaking()
  }
}

async function handleSend(text) {
  if (!canSend.value) return
  flushSave()
  sending.value = true
  try {
    await host.send(text)
  } finally {
    sending.value = false
  }
}

function handleRootClick() {
  if (!props.multiSelectMode) return
  emit('toggle-select', props.block.key)
}

function handleContextMenu(event) {
  if (props.multiSelectMode) {
    event.preventDefault()
    emit('toggle-select', props.block.key)
    return
  }
  // 长按控件时不弹消息菜单，避免拖滑块、点按钮时误触
  if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) {
    event.preventDefault()
    return
  }
  event.preventDefault()
  emit('context-menu', event, props.block)
}

onBeforeUnmount(() => {
  flushSave()
})
</script>

<style scoped>
.chat-smart-ui-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  max-width: min(440px, calc(100% - 28px));
}

.chat-smart-ui-wrapper.is-full {
  max-width: 100%;
}

.chat-smart-ui-row :deep(.sui-root) {
  width: 100%;
}

.chat-smart-ui-row.chat-message-row {
  user-select: none;
  -webkit-user-select: none;
}
</style>
