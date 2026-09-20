<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import LoginView from './views/LoginView.vue'
import SettingsView from './views/SettingsView.vue'
import KnowledgeView from './views/KnowledgeView.vue'
import ChatView from './views/ChatView.vue'
import BriefingView from './views/BriefingView.vue'
import DashboardView from './views/DashboardView.vue'
import TasksView from './views/TasksView.vue'
import UsageView from './views/UsageView.vue'

type Authed = boolean | null

const authed = ref<Authed>(null)
const showLogin = ref(false)
const view = ref('kb')
const healthVersion = ref('')

interface NavItem {
  key: string
  label: string
  title: string
  ticket: string
  public?: boolean
}

const nav: NavItem[] = [
  { key: 'dash', label: '✦ 今天', title: '', ticket: '', public: false },
  { key: 'chat', label: '◇ 对话', title: '对话', ticket: '', public: false },
  { key: 'kb', label: '◈ 知识库', title: '', ticket: '', public: true },
  { key: 'briefing', label: '▤ 简报', title: '简报', ticket: '', public: true },
  { key: 'tasks', label: '⚙ 任务', title: '', ticket: '', public: false },
  { key: 'usage', label: '⚡ 用量', title: '', ticket: '', public: false },
  { key: 'settings', label: '⚑ 设置', title: '设置', ticket: '', public: false },
]

const visibleNav = computed(() => (authed.value ? nav : nav.filter((n) => n.public)))

function activeTitle() {
  return nav.find((n) => n.key === view.value) ?? nav[0]!
}

onMounted(async () => {
  try {
    const [hRes, meRes] = await Promise.all([fetch('/healthz'), fetch('/api/auth/me')])
    healthVersion.value = hRes.ok ? ((await hRes.json()) as { version: string }).version : ''
    authed.value = meRes.ok
    if (!meRes.ok) view.value = 'kb' // 游客默认进知识库
  } catch {
    authed.value = null
  }
})

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' })
  authed.value = false
  showLogin.value = false
  view.value = 'kb'
}
</script>

<template>
  <LoginView v-if="authed === false && showLogin" @done="authed = true; showLogin = false" @guest="showLogin = false" />

  <div v-else-if="authed !== null" class="flex h-full flex-col md:flex-row">
    <!-- 移动端顶栏 -->
    <header class="flex items-center justify-between border-b border-edge bg-panel px-4 py-3 md:hidden">
      <h1 class="text-base font-bold tracking-wide">
        Cortxt<span class="text-neon">OS</span>
      </h1>
      <button v-if="authed" class="text-xs text-ink-dim transition hover:text-ink" @click="logout">登出</button>
      <button v-else class="text-xs text-neon" @click="showLogin = true">登录</button>
    </header>
    <!-- 移动端横向导航 -->
    <nav class="flex gap-2 overflow-x-auto border-b border-edge bg-panel px-3 py-2 md:hidden">
      <button
        v-for="item in visibleNav"
        :key="item.key"
        class="whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm transition"
        :class="view === item.key ? 'bg-neon/15 text-neon' : 'text-ink-dim'"
        @click="view = item.key"
      >
        {{ item.label }}
      </button>
    </nav>

    <div class="flex min-h-0 flex-1">
      <!-- 桌面侧边栏 -->
      <aside class="hidden w-56 shrink-0 flex-col border-r border-edge bg-panel md:flex">
        <div class="px-5 py-5">
          <h1 class="text-lg font-bold tracking-wide text-ink">
            Cortxt<span class="text-neon">OS</span>
          </h1>
          <p class="mt-1 text-xs text-ink-dim">自托管个人 AI 工作台</p>
        </div>
        <nav class="flex-1 space-y-1 px-3">
          <button
            v-for="item in visibleNav"
            :key="item.key"
            class="w-full rounded-lg px-3 py-2 text-left text-sm transition"
            :class="view === item.key ? 'bg-neon/15 text-neon' : 'text-ink-dim hover:text-ink'"
            @click="view = item.key"
          >
            {{ item.label }}
          </button>
        </nav>
        <div class="space-y-2 border-t border-edge px-5 py-4 text-xs">
          <div>
            <span v-if="healthVersion" class="text-neon-soft">daemon v{{ healthVersion }} · 在线</span>
            <span v-else class="text-red-400">daemon 未连接</span>
          </div>
          <button v-if="authed" class="text-ink-dim transition hover:text-ink" @click="logout">登出</button>
          <button v-else class="text-neon" @click="showLogin = true">登录</button>
        </div>
      </aside>

      <main class="min-w-0 flex-1 overflow-auto p-4 md:p-8">
        <DashboardView v-if="view === 'dash'" @navigate="view = $event" />
        <ChatView v-else-if="view === 'chat'" />
        <KnowledgeView v-else-if="view === 'kb'" :readonly="!authed" />
        <BriefingView v-else-if="view === 'briefing'" :readonly="!authed" />
        <TasksView v-else-if="view === 'tasks'" />
        <UsageView v-else-if="view === 'usage'" />
        <SettingsView v-else-if="view === 'settings'" @changed="authed = false" />
      </main>
    </div>
  </div>

  <div v-else class="grid h-full place-items-center text-ink-dim">连接中…</div>
</template>
