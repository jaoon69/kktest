<template>
  <div class="space-y-4">
    <div class="bg-[var(--card-bg)] rounded-[10px] overflow-hidden">
      <div class="px-4 py-3 flex justify-between items-center border-b border-[var(--border-color)] gap-3">
        <div class="flex flex-col flex-1 min-w-0">
          <span class="text-[17px] text-[var(--text-primary)]">模型工具调用</span>
          <span class="text-[12px] text-[var(--text-secondary)]">让 AI 主动调用工具（会增加输入 token），MCP 工具越多成本越高</span>
        </div>
        <IosToggle :model-value="store.allowToolCalling" class="shrink-0" @update:modelValue="handleAllowToolCallingChange" />
      </div>
      <template v-if="store.allowToolCalling">
        <div class="flex items-center px-4 py-3 border-b border-[var(--border-color)]">
          <span class="w-28 text-[16px] text-[var(--text-primary)] shrink-0">调用模式</span>
          <select
            :value="store.toolCallingMode || 'intent'"
            class="flex-1 text-[var(--primary-color)] bg-transparent outline-none text-right"
            @change="handleToolCallingModeChange($event.target.value)"
          >
            <option value="intent">按需（推荐，仅识别到意图时传工具）</option>
            <option value="always">始终（每轮都传全部工具，token 较高）</option>
          </select>
        </div>
        <div class="flex items-center px-4 py-3 border-b border-[var(--border-color)]">
          <span class="w-28 text-[16px] text-[var(--text-primary)] shrink-0">最多轮次</span>
          <select :value="store.toolCallingConfig.maxToolRounds" class="flex-1 text-[var(--primary-color)] bg-transparent outline-none text-right" @change="handleMaxToolRoundsChange($event.target.value)">
            <option v-for="count in TOOL_ROUND_OPTIONS" :key="`tool-round-${count}`" :value="count">{{ count }}</option>
          </select>
        </div>
        <div class="px-4 py-3 flex justify-between items-center border-b border-[var(--border-color)] gap-3">
          <div class="flex flex-col flex-1 min-w-0">
            <span class="text-[17px] text-[var(--text-primary)]">展示工具调用卡片</span>
            <span class="text-[12px] text-[var(--text-secondary)]">以紧凑状态行展示，点击可查看参数和结果</span>
          </div>
          <IosToggle :model-value="store.toolCallingConfig.showToolLog" class="shrink-0" @update:modelValue="handleShowToolLogChange" />
        </div>
        <SettingsWebSearch />
        <div class="px-4 py-3 flex justify-between items-center border-b border-[var(--border-color)] gap-3">
          <div class="flex flex-col flex-1 min-w-0">
            <span class="text-[17px] text-[var(--text-primary)]">本地桥接（高级）</span>
            <span class="text-[12px] text-[var(--text-secondary)]">用于连接 STDIO 或只能跑在本机的 MCP 服务；Notion 和云端直连无需开启</span>
          </div>
          <IosToggle :model-value="store.toolCallingConfig.mcpBridgeEnabled" class="shrink-0" @update:modelValue="handleMcpBridgeEnabledChange" />
        </div>
        <template v-if="store.toolCallingConfig.mcpBridgeEnabled">
          <div class="px-4 py-3 border-b border-[var(--border-color)] space-y-2">
            <div class="flex items-center">
              <span class="w-28 text-[16px] text-[var(--text-primary)] shrink-0">桥接地址</span>
              <input v-model="store.toolCallingConfig.mcpBridgeUrl" class="flex-1 min-w-0 text-[15px] outline-none text-right bg-transparent text-[var(--text-primary)]" placeholder="http://localhost:3099 或 https://bridge.example.com" @change="handleMcpBridgeUrlChange" />
            </div>
            <div class="pl-28 text-[12px] text-[var(--text-secondary)] leading-relaxed">
              仅在需要本机 STDIO/HTTP 服务时填写。云端 MCP 直连、Notion 授权不依赖这里。
            </div>
          </div>
          <div class="px-4 py-3 border-b border-[var(--border-color)] space-y-3">
            <div class="flex items-start justify-between gap-3">
              <div class="flex flex-col flex-1 min-w-0">
                <span class="text-[16px] text-[var(--text-primary)]">桥接状态</span>
                <span class="text-[12px] text-[var(--text-secondary)] leading-relaxed">{{ mcpBridgeStatusSummary }}</span>
              </div>
              <span class="shrink-0 text-[12px] font-medium" :class="mcpBridgeStatusClass">{{ mcpBridgeStatusLabel }}</span>
            </div>
            <div class="grid grid-cols-2 gap-2 text-[12px] text-[var(--text-secondary)]">
              <div class="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">配置服务器 {{ toolCallingServers.length }}</div>
              <div class="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">已连接 {{ mcpBridgeStatus.connectedCount }}</div>
              <div class="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">发现工具 {{ mcpBridgeStatus.toolsCount }}</div>
              <div class="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">最近检测 {{ mcpBridgeUpdatedLabel }}</div>
            </div>
            <div v-if="mcpBridgeStatus.lastError" class="text-[12px] text-red-500 break-all">{{ mcpBridgeStatus.lastError }}</div>
            <div class="flex gap-2">
              <button class="flex-1 rounded-xl border border-[var(--border-color)] px-3 py-2 text-[14px] text-[var(--primary-color)] disabled:opacity-60" :disabled="mcpBridgeBusy || mcpRefreshBusy" @click="handleTestMcpBridge">
                {{ mcpBridgeBusy ? '检测中...' : '测试连接' }}
              </button>
              <button class="flex-1 rounded-xl border border-[var(--border-color)] px-3 py-2 text-[14px] text-[var(--primary-color)] disabled:opacity-60" :disabled="mcpBridgeBusy || mcpRefreshBusy" @click="handleRefreshMcpBridgeTools">
                {{ mcpRefreshBusy ? '刷新中...' : '刷新工具' }}
              </button>
            </div>
          </div>
          <div class="px-4 py-3 border-b border-[var(--border-color)] space-y-3">
            <div class="flex flex-col gap-1">
              <span class="text-[16px] text-[var(--text-primary)]">本地桥接服务器</span>
              <span class="text-[12px] text-[var(--text-secondary)]">管理需要通过本地桥接启动或转发的 MCP 服务器</span>
            </div>
            <div v-if="toolCallingServers.length === 0" class="rounded-xl border border-dashed border-[var(--border-color)] px-3 py-3 text-[12px] text-[var(--text-secondary)]">
              还没有添加本地桥接服务器，点击下方按钮添加
            </div>
            <div v-for="server in toolCallingServers" :key="server.id" class="rounded-xl border border-[var(--border-color)] px-3 py-3 space-y-3">
              <div class="flex items-start justify-between gap-3">
                <div class="flex flex-col min-w-0">
                  <span class="text-[15px] text-[var(--text-primary)] truncate">{{ server.name || '未命名服务器' }}</span>
                  <span class="text-[12px] text-[var(--text-secondary)]">{{ server.transport === 'http' ? 'HTTP' : 'STDIO' }}</span>
                </div>
                <div class="flex items-center gap-3 shrink-0">
                  <IosToggle :model-value="server.enabled !== false" @update:modelValue="handleMcpServerToggle(server.id, $event)" />
                  <button class="text-[13px] text-red-500" @click="handleRemoveMcpServer(server.id)">删除</button>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <span class="w-16 text-[14px] text-[var(--text-secondary)] shrink-0">名称</span>
                <input :value="server.name" class="flex-1 min-w-0 text-[14px] outline-none bg-transparent text-[var(--text-primary)]" placeholder="例如 filesystem" @change="handleMcpServerFieldChange(server.id, 'name', $event.target.value)" />
              </div>
              <div class="flex items-center gap-3">
                <span class="w-16 text-[14px] text-[var(--text-secondary)] shrink-0">连接</span>
                <select :value="server.transport || 'stdio'" class="flex-1 text-[var(--primary-color)] bg-transparent outline-none text-right" @change="handleMcpServerTransportChange(server.id, $event.target.value)">
                  <option value="stdio">STDIO</option>
                  <option value="http">HTTP</option>
                </select>
              </div>
              <template v-if="server.transport === 'http'">
                <div class="flex items-center gap-3">
                  <span class="w-16 text-[14px] text-[var(--text-secondary)] shrink-0">URL</span>
                  <input :value="server.url || ''" class="flex-1 min-w-0 text-[14px] outline-none bg-transparent text-[var(--text-primary)]" placeholder="http://127.0.0.1:8080/mcp" @change="handleMcpServerFieldChange(server.id, 'url', $event.target.value)" />
                </div>
              </template>
              <template v-else>
                <div class="flex items-center gap-3">
                  <span class="w-16 text-[14px] text-[var(--text-secondary)] shrink-0">命令</span>
                  <input :value="server.command || ''" class="flex-1 min-w-0 text-[14px] outline-none bg-transparent text-[var(--text-primary)]" placeholder="npx" @change="handleMcpServerFieldChange(server.id, 'command', $event.target.value)" />
                </div>
                <div class="space-y-2">
                  <div class="flex items-center gap-3">
                    <span class="w-16 text-[14px] text-[var(--text-secondary)] shrink-0">参数</span>
                    <input :value="mcpArgsDrafts[server.id] ?? formatJsonInline(server.args || [])" class="flex-1 min-w-0 text-[14px] outline-none bg-transparent text-[var(--text-primary)]" placeholder='["-y","@modelcontextprotocol/server-filesystem","."]' @input="handleMcpArgsDraftInput(server.id, $event.target.value)" @blur="handleMcpServerArgsBlur(server.id)" />
                  </div>
                  <div v-if="mcpServerErrors[server.id]?.args" class="text-[12px] text-red-500 break-all">{{ mcpServerErrors[server.id].args }}</div>
                </div>
                <div class="space-y-2">
                  <div class="flex items-start gap-3">
                    <span class="w-16 text-[14px] text-[var(--text-secondary)] shrink-0 pt-1">环境</span>
                    <textarea :value="mcpEnvDrafts[server.id] ?? formatJsonBlock(server.env || {})" rows="4" class="flex-1 min-w-0 rounded-lg border border-[var(--border-color)] bg-transparent px-3 py-2 text-[13px] outline-none resize-none text-[var(--text-primary)]" placeholder='{"API_KEY":"xxx"}' @input="handleMcpEnvDraftInput(server.id, $event.target.value)" @blur="handleMcpServerEnvBlur(server.id)"></textarea>
                  </div>
                  <div v-if="mcpServerErrors[server.id]?.env" class="text-[12px] text-red-500 break-all">{{ mcpServerErrors[server.id].env }}</div>
                </div>
              </template>
            </div>
            <button class="w-full rounded-xl border border-[var(--border-color)] px-3 py-2.5 text-[14px] text-[var(--primary-color)]" @click="handleAddMcpServer">
              添加本地桥接服务器
            </button>
          </div>
        </template>
          <div class="px-4 py-3 border-b border-[var(--border-color)] space-y-3">
            <div class="flex items-start justify-between gap-3">
              <div class="flex flex-col gap-1 flex-1 min-w-0">
                <span class="text-[16px] text-[var(--text-primary)]">Notion</span>
                <span class="text-[12px] text-[var(--text-secondary)]">每个用户连接自己的 Notion，AI 会直接使用该用户授权的页面和数据库</span>
              </div>
              <IosToggle :model-value="store.toolCallingConfig?.notionEnabled === true" @update:modelValue="handleNotionEnabledChange" />
            </div>
            <div class="rounded-xl border border-[var(--border-color)] px-3 py-3 space-y-3">
              <div class="flex items-start justify-between gap-3">
                <div class="flex flex-col flex-1 min-w-0">
                  <span class="text-[15px] text-[var(--text-primary)] truncate">{{ notionConnectionTitle }}</span>
                  <span class="text-[12px] text-[var(--text-secondary)] leading-relaxed">{{ notionStatusSummary }}</span>
                </div>
                <span class="shrink-0 text-[12px] font-medium" :class="notionStatusClass">{{ notionStatusLabel }}</span>
              </div>
              <div v-if="notionStatus.connection?.lastError" class="text-[12px] text-red-500 break-all">{{ notionStatus.connection.lastError }}</div>
              <div class="grid grid-cols-2 gap-2 text-[12px] text-[var(--text-secondary)]">
                <div class="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">连接状态 {{ notionStatus.connected ? '已连接' : '未连接' }}</div>
                <div class="rounded-lg bg-[var(--bg-secondary)] px-3 py-2">发现工具 {{ notionToolsCount }}</div>
              </div>
              <div class="flex gap-2">
                <button class="flex-1 rounded-xl border border-[var(--border-color)] px-3 py-2 text-[14px] text-[var(--primary-color)] disabled:opacity-60" :disabled="notionBusy" @click="beginNotionConnect">
                  {{ notionBusy ? '处理中...' : (notionStatus.connected ? '重新授权' : '连接 Notion') }}
                </button>
                <button class="flex-1 rounded-xl border border-[var(--border-color)] px-3 py-2 text-[14px] text-[var(--primary-color)] disabled:opacity-60" :disabled="notionBusy || notionToolsBusy || !notionStatus.connected" @click="handleTestNotionTools">
                  {{ notionToolsBusy ? '检测中...' : '检测工具' }}
                </button>
              </div>
              <button v-if="notionStatus.connected" class="w-full rounded-xl border border-[var(--border-color)] px-3 py-2 text-[14px] text-red-500 disabled:opacity-60" :disabled="notionBusy" @click="handleDisconnectNotion">
                断开 Notion
              </button>
              <div v-if="notionToolNames.length > 0" class="flex flex-wrap gap-1.5">
                <span v-for="toolName in notionToolNames" :key="toolName" class="rounded-md bg-[var(--bg-secondary)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">{{ toolName }}</span>
              </div>
            </div>
          </div>
          <!-- MCP 直连服务器 -->
          <div class="px-4 py-3 border-b border-[var(--border-color)] space-y-3">
            <div class="flex items-start justify-between gap-3">
              <div class="flex flex-col gap-1">
                <span class="text-[16px] text-[var(--text-primary)]">MCP 直连</span>
                <span class="text-[12px] text-[var(--text-secondary)]">直接连接云端 MCP 服务，无需本地桥接</span>
              </div>
              <button class="shrink-0 rounded-xl border border-[var(--border-color)] px-3 py-1.5 text-[13px] text-[var(--primary-color)]" @click="handleAddDirectServer">+ 添加</button>
            </div>
            <div v-if="directServers.length === 0" class="rounded-xl border border-dashed border-[var(--border-color)] px-3 py-3 text-[12px] text-[var(--text-secondary)]">
              还没有添加直连服务，添加后填入地址并测试连接即可
            </div>
            <div v-for="srv in directServers" :key="srv.id" class="rounded-xl border border-[var(--border-color)] px-3 py-3 space-y-3">
              <div class="flex items-center justify-between gap-3">
                <span class="text-[15px] text-[var(--text-primary)] truncate flex-1 min-w-0">{{ srv.name || '未命名' }}</span>
                <div class="flex items-center gap-3 shrink-0">
                  <IosToggle :model-value="srv.enabled !== false" @update:modelValue="handleDirectServerToggle(srv.id, $event)" />
                  <button class="text-[13px] text-red-500" @click="handleRemoveDirectServer(srv.id)">删除</button>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <span class="w-16 text-[14px] text-[var(--text-secondary)] shrink-0">名称</span>
                <input :value="srv.name" class="flex-1 min-w-0 text-[14px] outline-none bg-transparent text-[var(--text-primary)]" placeholder="例如 Notion" @change="handleDirectServerFieldChange(srv.id, 'name', $event.target.value)" />
              </div>
              <div class="flex items-center gap-3">
                <span class="w-16 text-[14px] text-[var(--text-secondary)] shrink-0">URL</span>
                <input :value="srv.url" class="flex-1 min-w-0 text-[14px] outline-none bg-transparent text-[var(--text-primary)]" placeholder="https://mcp.composio.dev/notion/xxx" @change="handleDirectServerFieldChange(srv.id, 'url', $event.target.value)" />
              </div>
              <div class="flex items-center gap-3">
                <span class="w-16 text-[14px] text-[var(--text-secondary)] shrink-0">Auth</span>
                <input :value="srv.authHeader || ''" class="flex-1 min-w-0 text-[14px] outline-none bg-transparent text-[var(--text-primary)]" placeholder="可选，直接填写 Authorization 值，如 Bearer xxx" @change="handleDirectServerFieldChange(srv.id, 'authHeader', $event.target.value)" />
              </div>
              <div class="flex items-center gap-3">
                <span class="w-16 text-[14px] text-[var(--text-secondary)] shrink-0">API Key</span>
                <input :value="srv.apiKey || ''" type="password" class="flex-1 min-w-0 text-[14px] outline-none bg-transparent text-[var(--text-primary)]" placeholder="可选，未填写 Auth 时自动转成 Bearer Authorization" @change="handleDirectServerFieldChange(srv.id, 'apiKey', $event.target.value)" />
              </div>
              <div class="flex items-center justify-between gap-3">
                <div class="text-[12px] text-[var(--text-secondary)]">
                  <span v-if="srv.toolsError" class="text-red-500">{{ srv.toolsError }}</span>
                  <span v-else-if="srv.toolsCount > 0">已发现 {{ srv.toolsCount }} 个工具</span>
                  <span v-else>未测试</span>
                </div>
                <button class="rounded-xl border border-[var(--border-color)] px-3 py-1.5 text-[13px] text-[var(--primary-color)] disabled:opacity-60" :disabled="directServerBusy[srv.id]" @click="handleTestDirectServer(srv.id)">
                  {{ directServerBusy[srv.id] ? '检测中...' : '测试连接' }}
                </button>
              </div>
              <div v-if="srv.toolNames && srv.toolNames.length > 0" class="flex flex-wrap gap-1.5">
                <span v-for="toolName in srv.toolNames" :key="toolName" class="rounded-md bg-[var(--bg-secondary)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">{{ toolName }}</span>
              </div>
            </div>
          </div>
        <div class="px-4 py-3">
          <p class="text-[12px] text-[var(--text-secondary)] leading-relaxed">工具调用默认在后台工作；展示项会以 Agent 风格的紧凑状态行出现在聊天中，点击后可查看详细过程。</p>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { useSettingsStore } from '../../stores/settings'
import { useStorage } from '../../composables/useStorage'
import { useToast } from '../../composables/useToast'
import { useMcpBridge } from '../../composables/useMcpBridge'
import { useNotionConnection } from '../../composables/useNotionConnection'
import IosToggle from '../../components/common/IosToggle.vue'
import SettingsWebSearch from './SettingsWebSearch.vue'
import { makeId } from '../../utils/id'

const store = useSettingsStore()
const { scheduleSave } = useStorage()
const { showToast } = useToast()
const { getBridgeStatus, refreshMcpTools, testDirectServer, refreshDirectTools } = useMcpBridge({ settingsStore: store, showToast })
const {
  notionStatus,
  notionBusy,
  notionToolsBusy,
  notionToolsCount,
  notionToolNames,
  refreshNotionStatus,
  beginNotionConnect,
  disconnectNotion,
  testNotionTools
} = useNotionConnection({
  settingsStore: store,
  showToast,
  refreshDirectTools
})
const TOOL_ROUND_OPTIONS = [1, 2, 3, 4, 5]
const toolCallingServers = computed(() => (
  Array.isArray(store.toolCallingConfig?.mcpServers)
    ? store.toolCallingConfig.mcpServers
    : []
))
const mcpArgsDrafts = ref({})
const mcpEnvDrafts = ref({})
const mcpServerErrors = ref({})
const mcpBridgeBusy = ref(false)
const mcpRefreshBusy = ref(false)
const mcpBridgeStatus = ref(createInitialMcpBridgeStatus())
const directServerBusy = ref({})
const directServers = computed(() => (
  Array.isArray(store.toolCallingConfig?.mcpDirectServers)
    ? store.toolCallingConfig.mcpDirectServers
    : []
))
const notionConnectionTitle = computed(() => (
  notionStatus.value.connection?.workspaceName
  || notionStatus.value.connection?.ownerName
  || 'Notion'
))
const notionStatusLabel = computed(() => {
  if (notionStatus.value.requiresAuth) return '需登录'
  if (!notionStatus.value.supported) return '不可用'
  if (notionStatus.value.connected && store.toolCallingConfig?.notionEnabled === false) return '已停用'
  if (notionStatus.value.connected) return '已连接'
  return '未连接'
})
const notionStatusClass = computed(() => {
  if (notionStatus.value.requiresAuth) return 'text-[var(--text-secondary)]'
  if (!notionStatus.value.supported) return 'text-red-500'
  if (notionStatus.value.connected && store.toolCallingConfig?.notionEnabled === false) return 'text-[var(--text-secondary)]'
  if (notionStatus.value.connected) return 'text-green-500'
  return 'text-[var(--text-secondary)]'
})
const notionStatusSummary = computed(() => {
  if (!notionStatus.value.supported) {
    return notionStatus.value.requiresAuth
      ? '需要先通过当前账号登录，服务器才能为每个用户单独保存 Notion 授权。'
      : '当前环境还没有满足按用户连接 Notion 所需的服务端条件。'
  }
  if (notionStatus.value.connected) {
    const workspace = notionStatus.value.connection?.workspaceName || '已授权工作区'
    if (store.toolCallingConfig?.notionEnabled === false) {
      return `${workspace} 已连接，但当前不会把 Notion 工具提供给 AI。`
    }
    return `${workspace} 已连接。用户在 Notion 授权页里选择的页面和数据库，将可被 AI 读取或写入。`
  }
  if (notionStatus.value.needsReconnect) {
    return 'Notion 授权已失效，需要重新连接。'
  }
  return '每个用户连接自己的 Notion 后，AI 会直接使用该用户已授权的页面和数据库。'
})

const mcpBridgeStatusSummary = computed(() => {
  const bridgeUrl = String(store.toolCallingConfig?.mcpBridgeUrl || '').trim()
  const status = mcpBridgeStatus.value

  if (!bridgeUrl) return '先填写桥接地址，再测试连接。'
  if (!status.updatedAt && !mcpBridgeBusy.value) return '可手动测试桥接服务，或在修改服务器后刷新工具。'
  if (mcpBridgeBusy.value && !status.updatedAt) return '正在检测桥接服务状态。'
  if (!status.reachable) return '桥接服务当前不可用。'

  return `已连接 ${status.connectedCount}/${status.serverCount} 个服务器，发现 ${status.toolsCount} 个工具。`
})

const mcpBridgeStatusLabel = computed(() => {
  if (mcpBridgeBusy.value) return '检测中'
  if (!mcpBridgeStatus.value.updatedAt) return '未检测'
  return mcpBridgeStatus.value.reachable ? '已连接' : '未连接'
})

const mcpBridgeStatusClass = computed(() => {
  if (mcpBridgeBusy.value) return 'text-[var(--primary-color)]'
  return mcpBridgeStatus.value.reachable ? 'text-emerald-500' : 'text-red-500'
})

const mcpBridgeUpdatedLabel = computed(() => {
  const updatedAt = Number(mcpBridgeStatus.value.updatedAt || 0)
  if (!updatedAt) return '未检测'
  try {
    return new Date(updatedAt).toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return '刚刚'
  }
})

watch(
  () => store.toolCallingConfig?.mcpServers,
  (servers) => {
    const nextArgs = { ...mcpArgsDrafts.value }
    const nextEnv = { ...mcpEnvDrafts.value }
    const nextErrors = { ...mcpServerErrors.value }
    const validIds = new Set()

    ;(Array.isArray(servers) ? servers : []).forEach((server) => {
      const serverId = String(server?.id || '').trim()
      if (!serverId) return
      validIds.add(serverId)
      if (!Object.prototype.hasOwnProperty.call(nextArgs, serverId)) {
        nextArgs[serverId] = formatJsonInline(server.args || [])
      }
      if (!Object.prototype.hasOwnProperty.call(nextEnv, serverId)) {
        nextEnv[serverId] = formatJsonBlock(server.env || {})
      }
      if (!Object.prototype.hasOwnProperty.call(nextErrors, serverId)) {
        nextErrors[serverId] = {}
      }
    })

    Object.keys(nextArgs).forEach((serverId) => {
      if (!validIds.has(serverId)) delete nextArgs[serverId]
    })
    Object.keys(nextEnv).forEach((serverId) => {
      if (!validIds.has(serverId)) delete nextEnv[serverId]
    })
    Object.keys(nextErrors).forEach((serverId) => {
      if (!validIds.has(serverId)) delete nextErrors[serverId]
    })

    mcpArgsDrafts.value = nextArgs
    mcpEnvDrafts.value = nextEnv
    mcpServerErrors.value = nextErrors
  },
  { immediate: true, deep: true }
)

watch(
  () => JSON.stringify({
    allowToolCalling: store.allowToolCalling,
    notionEnabled: store.toolCallingConfig?.notionEnabled
  }),
  () => {
    if (store.allowToolCalling) {
      void refreshNotionStatus({ silent: true })
    }
  },
  { immediate: true }
)

watch(
  () => JSON.stringify({
    allowToolCalling: store.allowToolCalling,
    mcpBridgeEnabled: store.toolCallingConfig?.mcpBridgeEnabled,
    mcpBridgeUrl: store.toolCallingConfig?.mcpBridgeUrl || '',
    mcpServers: toolCallingServers.value
  }),
  () => {
    if (store.allowToolCalling && store.toolCallingConfig?.mcpBridgeEnabled && String(store.toolCallingConfig?.mcpBridgeUrl || '').trim()) {
      void refreshBridgeStatus({ force: true, silent: true })
      return
    }
    mcpBridgeStatus.value = createInitialMcpBridgeStatus()
  },
  { immediate: true }
)

function formatJsonInline(value) {
  try {
    return JSON.stringify(value ?? [])
  } catch {
    return '[]'
  }
}

function formatJsonBlock(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2)
  } catch {
    return '{}'
  }
}

function createInitialMcpBridgeStatus() {
  return {
    reachable: false,
    bridgeName: '',
    serverCount: 0,
    connectedCount: 0,
    toolsCount: 0,
    servers: [],
    lastError: '',
    updatedAt: 0
  }
}

function updateToolCallingConfig(patch) {
  store.toolCallingConfig = {
    ...store.toolCallingConfig,
    ...patch
  }
  scheduleSave()
}

function updateDirectServers(nextServers) {
  updateToolCallingConfig({ mcpDirectServers: nextServers })
}

function handleAddDirectServer() {
  updateDirectServers([
    ...directServers.value,
    { id: makeId('mcpd'), name: '', url: '', authHeader: '', apiKey: '', enabled: true, toolsCount: 0, toolsError: '' }
  ])
}

function handleRemoveDirectServer(serverId) {
  updateDirectServers(directServers.value.filter((s) => s.id !== serverId))
}

function handleDirectServerToggle(serverId, nextValue) {
  updateDirectServers(directServers.value.map((s) => s.id !== serverId ? s : { ...s, enabled: !!nextValue }))
}

function handleDirectServerFieldChange(serverId, key, nextValue) {
  updateDirectServers(directServers.value.map((s) => s.id !== serverId ? s : { ...s, [key]: String(nextValue || '').trim() }))
}

async function handleTestDirectServer(serverId) {
  directServerBusy.value = { ...directServerBusy.value, [serverId]: true }
  try {
    const result = await testDirectServer(serverId)
    updateDirectServers(directServers.value.map((s) =>
      s.id !== serverId ? s : { ...s, toolsCount: result.toolsCount, toolsError: result.error || '', toolNames: result.toolNames || [] }
    ))
    if (result.error) {
      showToast(result.error, 2800)
    } else {
      showToast(`连接成功，发现 ${result.toolsCount} 个工具`, 2200)
    }
  } finally {
    directServerBusy.value = { ...directServerBusy.value, [serverId]: false }
  }
}

function handleAllowToolCallingChange(nextValue) {
  store.allowToolCalling = !!nextValue
  scheduleSave()
}

function handleToolCallingModeChange(nextValue) {
  store.toolCallingMode = nextValue === 'always' ? 'always' : 'intent'
  scheduleSave()
}

function handleMaxToolRoundsChange(nextValue) {
  const rounds = Number(nextValue)
  updateToolCallingConfig({
    maxToolRounds: Number.isFinite(rounds) ? Math.max(1, Math.min(8, Math.round(rounds))) : 3
  })
}

function handleShowToolLogChange(nextValue) {
  updateToolCallingConfig({
    showToolLog: !!nextValue
  })
}

function handleNotionEnabledChange(nextValue) {
  updateToolCallingConfig({
    notionEnabled: !!nextValue
  })
}

async function handleDisconnectNotion() {
  await disconnectNotion()
}

async function handleTestNotionTools() {
  await testNotionTools()
}

function handleMcpBridgeEnabledChange(nextValue) {
  updateToolCallingConfig({
    mcpBridgeEnabled: !!nextValue
  })
}

function handleMcpBridgeUrlChange() {
  updateToolCallingConfig({
    mcpBridgeUrl: String(store.toolCallingConfig?.mcpBridgeUrl || '').trim()
  })
}

async function refreshBridgeStatus({ force = false, silent = false } = {}) {
  const bridgeUrl = String(store.toolCallingConfig?.mcpBridgeUrl || '').trim()
  if (!bridgeUrl) {
    mcpBridgeStatus.value = createInitialMcpBridgeStatus()
    if (!silent) {
      showToast('请先填写 MCP 桥接地址', 2200)
    }
    return mcpBridgeStatus.value
  }

  mcpBridgeBusy.value = true
  try {
    const status = await getBridgeStatus({ force })
    mcpBridgeStatus.value = status

    if (!silent) {
      if (status.reachable) {
        showToast(`桥接可用，已发现 ${status.toolsCount} 个工具`, 2200)
      } else if (status.lastError) {
        showToast(status.lastError, 2600)
      }
    }

    return status
  } finally {
    mcpBridgeBusy.value = false
  }
}

async function handleTestMcpBridge() {
  await refreshBridgeStatus({ force: true })
}

async function handleRefreshMcpBridgeTools() {
  const bridgeUrl = String(store.toolCallingConfig?.mcpBridgeUrl || '').trim()
  if (!bridgeUrl) {
    showToast('请先填写 MCP 桥接地址', 2200)
    return
  }

  mcpRefreshBusy.value = true
  try {
    const discovery = await refreshMcpTools()
    const status = await refreshBridgeStatus({ force: true, silent: true })
    const toolCount = Array.isArray(discovery?.tools) ? discovery.tools.length : status.toolsCount

    mcpBridgeStatus.value = {
      ...status,
      toolsCount: toolCount
    }

    if (status.reachable) {
      showToast(`已刷新 ${toolCount} 个 MCP 工具`, 2200)
    }
  } finally {
    mcpRefreshBusy.value = false
  }
}

function createDefaultMcpServer() {
  return {
    id: makeId('mcp'),
    name: '',
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    url: '',
    enabled: true
  }
}

function updateMcpServers(nextServers) {
  updateToolCallingConfig({
    mcpServers: nextServers
  })
}

function updateSingleMcpServer(serverId, updater) {
  updateMcpServers(
    toolCallingServers.value.map((server) => {
      if (server.id !== serverId) return server
      const next = typeof updater === 'function' ? updater(server) : updater
      return { ...server, ...next }
    })
  )
}

function setMcpServerError(serverId, key, message = '') {
  mcpServerErrors.value = {
    ...mcpServerErrors.value,
    [serverId]: {
      ...(mcpServerErrors.value[serverId] || {}),
      [key]: message
    }
  }
}

function handleAddMcpServer() {
  updateMcpServers([
    ...toolCallingServers.value,
    createDefaultMcpServer()
  ])
}

function handleRemoveMcpServer(serverId) {
  updateMcpServers(toolCallingServers.value.filter((server) => server.id !== serverId))
}

function handleMcpServerToggle(serverId, nextValue) {
  updateSingleMcpServer(serverId, { enabled: !!nextValue })
}

function handleMcpServerTransportChange(serverId, nextValue) {
  updateSingleMcpServer(serverId, {
    transport: nextValue === 'http' ? 'http' : 'stdio'
  })
}

function handleMcpServerFieldChange(serverId, key, nextValue) {
  updateSingleMcpServer(serverId, {
    [key]: String(nextValue || '').trim()
  })
}

function handleMcpArgsDraftInput(serverId, value) {
  mcpArgsDrafts.value = {
    ...mcpArgsDrafts.value,
    [serverId]: value
  }
}

function handleMcpEnvDraftInput(serverId, value) {
  mcpEnvDrafts.value = {
    ...mcpEnvDrafts.value,
    [serverId]: value
  }
}

function handleMcpServerArgsBlur(serverId) {
  try {
    const raw = String(mcpArgsDrafts.value[serverId] || '').trim()
    const parsed = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) {
      throw new Error('参数必须是 JSON 数组')
    }
    setMcpServerError(serverId, 'args', '')
    updateSingleMcpServer(serverId, {
      args: parsed.map((item) => String(item ?? '').trim()).filter(Boolean)
    })
    mcpArgsDrafts.value = {
      ...mcpArgsDrafts.value,
      [serverId]: formatJsonInline(parsed)
    }
  } catch (error) {
    const message = error?.message || '参数必须是 JSON 数组'
    setMcpServerError(serverId, 'args', message)
    showToast(message, 2800)
  }
}

function handleMcpServerEnvBlur(serverId) {
  try {
    const raw = String(mcpEnvDrafts.value[serverId] || '').trim()
    const parsed = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('环境变量必须是 JSON 对象')
    }
    setMcpServerError(serverId, 'env', '')
    const nextEnv = Object.fromEntries(
      Object.entries(parsed)
        .map(([key, value]) => [String(key || '').trim(), String(value ?? '').trim()])
        .filter(([key]) => !!key)
    )
    updateSingleMcpServer(serverId, { env: nextEnv })
    mcpEnvDrafts.value = {
      ...mcpEnvDrafts.value,
      [serverId]: formatJsonBlock(nextEnv)
    }
  } catch (error) {
    const message = error?.message || '环境变量必须是 JSON 对象'
    setMcpServerError(serverId, 'env', message)
    showToast(message, 2800)
  }
}
</script>
