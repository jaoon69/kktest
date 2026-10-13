<template>
  <div class="px-4 py-3 border-b border-[var(--border-color)] space-y-3">
    <div class="flex items-start justify-between gap-3">
      <div class="flex flex-col gap-1 flex-1 min-w-0">
        <span class="text-[16px] text-[var(--text-primary)]">联网搜索</span>
        <span class="text-[12px] text-[var(--text-secondary)]">让 AI 用 Tavily / Exa / Firecrawl 搜索和读取网页，结果自动缓存以节省额度</span>
      </div>
      <IosToggle :model-value="config.enabled" class="shrink-0" @update:modelValue="updateConfig({ enabled: !!$event })" />
    </div>

    <template v-if="config.enabled">
      <div class="rounded-xl border border-[var(--border-color)] px-3 py-3 space-y-3">
        <div class="flex items-center gap-3">
          <span class="w-20 text-[14px] text-[var(--text-secondary)] shrink-0">搜索引擎</span>
          <select :value="config.provider" class="flex-1 text-[var(--primary-color)] bg-transparent outline-none text-right" @change="updateConfig({ provider: $event.target.value })">
            <option v-for="id in WEB_SEARCH_PROVIDER_IDS" :key="`search-${id}`" :value="id">{{ WEB_SEARCH_PROVIDER_LABELS[id] }}</option>
          </select>
        </div>
        <div class="flex items-center gap-3">
          <span class="w-20 text-[14px] text-[var(--text-secondary)] shrink-0">网页读取</span>
          <select :value="config.scrapeProvider" class="flex-1 text-[var(--primary-color)] bg-transparent outline-none text-right" @change="updateConfig({ scrapeProvider: $event.target.value })">
            <option value="">跟随搜索引擎</option>
            <option v-for="id in WEB_SEARCH_PROVIDER_IDS" :key="`scrape-${id}`" :value="id">{{ WEB_SEARCH_PROVIDER_LABELS[id] }}</option>
          </select>
        </div>
        <div v-if="!hasAnyKey" class="text-[12px] text-red-500">至少填写一个引擎的 API Key，AI 才能使用联网搜索</div>
      </div>

      <div v-for="id in WEB_SEARCH_PROVIDER_IDS" :key="`key-${id}`" class="rounded-xl border border-[var(--border-color)] px-3 py-3 space-y-2">
        <div class="flex items-center justify-between gap-3">
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-[15px] text-[var(--text-primary)]">{{ WEB_SEARCH_PROVIDER_LABELS[id] }}</span>
            <span v-if="providerRoleLabel(id)" class="rounded-md bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]">{{ providerRoleLabel(id) }}</span>
          </div>
          <a :href="PROVIDER_KEY_URLS[id]" target="_blank" rel="noopener noreferrer" class="shrink-0 text-[12px] text-[var(--primary-color)]">获取 Key</a>
        </div>
        <div class="flex items-center gap-3">
          <span class="w-16 text-[14px] text-[var(--text-secondary)] shrink-0">API Key</span>
          <input :value="config.apiKeys[id]" type="password" autocomplete="off" class="flex-1 min-w-0 text-[14px] outline-none bg-transparent text-[var(--text-primary)]" :placeholder="PROVIDER_KEY_PLACEHOLDERS[id]" @change="updateProviderField('apiKeys', id, $event.target.value)" />
        </div>
        <div v-if="showAdvanced" class="flex items-center gap-3">
          <span class="w-16 text-[14px] text-[var(--text-secondary)] shrink-0">地址</span>
          <input :value="config.baseUrls[id]" class="flex-1 min-w-0 text-[14px] outline-none bg-transparent text-[var(--text-primary)]" :placeholder="`默认 ${WEB_SEARCH_PROVIDERS[id].defaultBaseUrl}`" @change="updateProviderField('baseUrls', id, $event.target.value)" />
        </div>
        <div class="flex items-center justify-between gap-3">
          <span class="text-[12px] min-w-0 break-all" :class="testResults[id]?.ok ? 'text-green-500' : 'text-red-500'">{{ testResults[id]?.message || '' }}</span>
          <button class="shrink-0 rounded-xl border border-[var(--border-color)] px-3 py-1.5 text-[13px] text-[var(--primary-color)] disabled:opacity-60" :disabled="!config.apiKeys[id] || testBusy[id]" @click="handleTestProvider(id)">
            {{ testBusy[id] ? '测试中...' : '测试' }}
          </button>
        </div>
      </div>

      <div class="rounded-xl border border-[var(--border-color)] px-3 py-3 space-y-3">
        <div class="flex items-center gap-3">
          <span class="w-28 text-[14px] text-[var(--text-secondary)] shrink-0">每次结果条数</span>
          <select :value="config.maxResults" class="flex-1 text-[var(--primary-color)] bg-transparent outline-none text-right" @change="updateConfig({ maxResults: Number($event.target.value) })">
            <option v-for="count in MAX_RESULT_OPTIONS" :key="`results-${count}`" :value="count">{{ count }} 条</option>
          </select>
        </div>
        <div class="flex items-center gap-3">
          <span class="w-28 text-[14px] text-[var(--text-secondary)] shrink-0">网页单次字数</span>
          <select :value="config.scrapeMaxChars" class="flex-1 text-[var(--primary-color)] bg-transparent outline-none text-right" @change="updateConfig({ scrapeMaxChars: Number($event.target.value) })">
            <option v-for="chars in SCRAPE_CHAR_OPTIONS" :key="`chars-${chars}`" :value="chars">{{ chars }} 字符</option>
          </select>
        </div>
        <div class="flex items-center justify-between gap-3">
          <div class="flex flex-col flex-1 min-w-0">
            <span class="text-[14px] text-[var(--text-primary)]">失败时自动换引擎</span>
            <span class="text-[12px] text-[var(--text-secondary)]">当前引擎报错或额度用完时，改用其他已填 Key 的引擎</span>
          </div>
          <IosToggle :model-value="config.fallbackEnabled" class="shrink-0" @update:modelValue="updateConfig({ fallbackEnabled: !!$event })" />
        </div>
        <button class="text-[12px] text-[var(--primary-color)]" @click="showAdvanced = !showAdvanced">
          {{ showAdvanced ? '收起自定义地址' : '自定义接口地址（自建 Firecrawl / 反代）' }}
        </button>
      </div>

      <div class="rounded-xl border border-[var(--border-color)] px-3 py-3 space-y-3">
        <div class="flex items-center justify-between gap-3">
          <div class="flex flex-col flex-1 min-w-0">
            <span class="text-[14px] text-[var(--text-primary)]">结果缓存</span>
            <span class="text-[12px] text-[var(--text-secondary)]">相同搜索、已读网页直接复用本地结果，不再消耗 API 额度</span>
          </div>
          <IosToggle :model-value="config.cacheEnabled" class="shrink-0" @update:modelValue="updateConfig({ cacheEnabled: !!$event })" />
        </div>
        <template v-if="config.cacheEnabled">
          <div class="flex items-center gap-3">
            <span class="w-28 text-[14px] text-[var(--text-secondary)] shrink-0">搜索缓存</span>
            <select :value="config.searchCacheHours" class="flex-1 text-[var(--primary-color)] bg-transparent outline-none text-right" @change="updateConfig({ searchCacheHours: Number($event.target.value) })">
              <option v-for="hours in SEARCH_CACHE_OPTIONS" :key="`search-ttl-${hours}`" :value="hours">{{ formatHours(hours) }}</option>
            </select>
          </div>
          <div class="flex items-center gap-3">
            <span class="w-28 text-[14px] text-[var(--text-secondary)] shrink-0">网页缓存</span>
            <select :value="config.scrapeCacheHours" class="flex-1 text-[var(--primary-color)] bg-transparent outline-none text-right" @change="updateConfig({ scrapeCacheHours: Number($event.target.value) })">
              <option v-for="hours in SCRAPE_CACHE_OPTIONS" :key="`scrape-ttl-${hours}`" :value="hours">{{ formatHours(hours) }}</option>
            </select>
          </div>
        </template>
        <div class="flex items-center justify-between gap-3">
          <span class="text-[12px] text-[var(--text-secondary)]">{{ cacheStatsLabel }}</span>
          <button class="shrink-0 rounded-xl border border-[var(--border-color)] px-3 py-1.5 text-[13px] text-red-500 disabled:opacity-60" :disabled="clearBusy" @click="handleClearCache">
            {{ clearBusy ? '清理中...' : '清空缓存' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { useStorage } from '../../composables/useStorage'
import { useToast } from '../../composables/useToast'
import IosToggle from '../../components/common/IosToggle.vue'
import {
  WEB_SEARCH_PROVIDER_IDS,
  WEB_SEARCH_PROVIDER_LABELS,
  getWebSearchConfig,
  normalizeWebSearchConfig,
  resolveWebSearchProviderOrder
} from '../../utils/webSearchConfig'
import { WEB_SEARCH_PROVIDERS } from '../../composables/webSearch/providers'
import { getWebSearchService } from '../../composables/webSearch/webSearchService'

const PROVIDER_KEY_URLS = Object.freeze({
  tavily: 'https://app.tavily.com/home',
  exa: 'https://dashboard.exa.ai/api-keys',
  firecrawl: 'https://www.firecrawl.dev/app/api-keys'
})
const PROVIDER_KEY_PLACEHOLDERS = Object.freeze({
  tavily: 'tvly-...',
  exa: 'Exa API Key',
  firecrawl: 'fc-...'
})
const MAX_RESULT_OPTIONS = [3, 5, 8, 10]
const SCRAPE_CHAR_OPTIONS = [4000, 8000, 16000, 30000]
const SEARCH_CACHE_OPTIONS = [1, 6, 12, 24, 72, 168]
const SCRAPE_CACHE_OPTIONS = [24, 72, 168, 720]

const store = useSettingsStore()
const { scheduleSave } = useStorage()
const { showToast } = useToast()

const showAdvanced = ref(false)
const testBusy = ref({})
const testResults = ref({})
const clearBusy = ref(false)
const cacheStats = ref({ entries: 0, totalChars: 0, hits: 0 })

const config = computed(() => getWebSearchConfig(store))
const hasAnyKey = computed(() => WEB_SEARCH_PROVIDER_IDS.some((id) => !!config.value.apiKeys[id]))
// 实际生效的搜索 / 读取引擎（首个已填 Key 的）
const activeSearchProvider = computed(() => resolveWebSearchProviderOrder(config.value, 'search')[0] || '')
const activeScrapeProvider = computed(() => resolveWebSearchProviderOrder(config.value, 'scrape')[0] || '')
const cacheStatsLabel = computed(() => {
  const { entries, totalChars, hits } = cacheStats.value
  const kb = Math.max(0, Math.round(totalChars / 1024))
  return `已缓存 ${entries} 条 · 约 ${kb} KB · 已命中 ${hits} 次`
})

function updateConfig(patch) {
  store.toolCallingConfig = {
    ...store.toolCallingConfig,
    webSearch: normalizeWebSearchConfig({ ...config.value, ...patch })
  }
  scheduleSave()
}

function updateProviderField(field, providerId, value) {
  updateConfig({
    [field]: { ...config.value[field], [providerId]: String(value || '').trim() }
  })
  if (field === 'apiKeys') {
    testResults.value = { ...testResults.value, [providerId]: null }
  }
}

function providerRoleLabel(providerId) {
  const roles = []
  if (activeSearchProvider.value === providerId) roles.push('搜索')
  if (activeScrapeProvider.value === providerId) roles.push('读取')
  return roles.length > 0 ? `用于${roles.join('、')}` : ''
}

function formatHours(hours) {
  if (hours < 24) return `${hours} 小时`
  return `${Math.round(hours / 24)} 天`
}

async function refreshCacheStats() {
  try {
    cacheStats.value = await getWebSearchService().getCacheStats()
  } catch {
    // 统计失败不影响设置页
  }
}

async function handleTestProvider(providerId) {
  testBusy.value = { ...testBusy.value, [providerId]: true }
  try {
    // 只测这一家，不走缓存也不回退
    const result = await getWebSearchService().search(
      { ...config.value, provider: providerId, fallbackEnabled: false, cacheEnabled: false },
      { query: 'Vue.js', maxResults: 1 }
    )
    testResults.value = {
      ...testResults.value,
      [providerId]: { ok: true, message: `连接成功，返回 ${result.results.length} 条结果` }
    }
  } catch (err) {
    testResults.value = {
      ...testResults.value,
      [providerId]: { ok: false, message: err?.message || '测试失败' }
    }
  } finally {
    testBusy.value = { ...testBusy.value, [providerId]: false }
  }
}

async function handleClearCache() {
  clearBusy.value = true
  try {
    await getWebSearchService().clearCache()
    await refreshCacheStats()
    showToast('已清空联网搜索缓存', 2000)
  } finally {
    clearBusy.value = false
  }
}

watch(() => config.value.enabled, (enabled) => {
  if (enabled) void refreshCacheStats()
})

onMounted(() => {
  if (config.value.enabled) void refreshCacheStats()
})
</script>
