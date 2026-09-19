<script setup lang="ts">
import { onMounted, ref } from 'vue'
import LoginView from './views/LoginView.vue'
import SettingsView from './views/SettingsView.vue'
import PlaceholderView from './views/PlaceholderView.vue'
import KnowledgeView from './views/KnowledgeView.vue'
import ChatView from './views/ChatView.vue'
import BriefingView from './views/BriefingView.vue'

type Authed = boolean | null

const authed = ref<Authed>(null)
const view = ref('chat')
const healthVersion = ref('')

const nav = [
  { key: 'chat', label: '对话', title: '对话', ticket: '工单 06' },
  { key: 'kb', label: '知识库', title: '', ticket: '' },
  { key: 'briefing', label: '简报', title: '简报', ticket: '工单 07' },
  { key: 'settings', label: '设置', title: '设置', ticket: '' },
]

const activeTitle = () => nav.find((n) => n.key === view.value) ?? nav[0]!

onMounted(async () => {
  try {
    const [hRes, meRes] = await Promise.all([fetch('/healthz'), fetch('/api/auth/me')])
    healthVersion.value = hRes.ok ? ((await hRes.json()) as { version: string }).version : ''
    authed.value = meRes.ok
  } catch {
    authed.value = null
  }
})

async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' })
  authed.value = false
}
</script>

<template>
  <LoginView v-if="authed === false" @done="authed = true" />

  <div v-else-if="authed === true" class="flex h-full flex-col md:flex-row">
    <!-- 移动端顶栏 -->
    <header class="flex items-center justify-between border-b border-edge bg-panel px-4 py-3 md:hidden">
      <h1 class="text-base font-bold tracking-wide">
        Cortxt<span class="text-neon">OS</span>
      </h1>
      <button class="text-xs text-ink-dim transition hover:text-ink" @click="logout">登出</button>
    </header>
    <!-- 移动端横向导航 -->
    <nav class="flex gap-2 overflow-x-auto border-b border-edge bg-panel px-3 py-2 md:hidden">
      <button
        v-for="item in nav"
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
            v-for="item in nav"
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
          <button class="text-ink-dim transition hover:text-ink" @click="logout">登出</button>
        </div>
      </aside>

      <main class="min-w-0 flex-1 overflow-auto p-4 md:p-8">
        <ChatView v-if="view === 'chat'" />
        <SettingsView v-else-if="view === 'settings'" @changed="authed = false" />
        <KnowledgeView v-else-if="view === 'kb'" />
        <BriefingView v-else-if="view === 'briefing'" />
        <PlaceholderView v-else :title="activeTitle().title" :ticket="activeTitle().ticket" />
      </main>
    </div>
  </div>

  <div v-else class="grid h-full place-items-center text-ink-dim">连接中…</div>
</template>
