<script setup lang="ts">
import { onMounted, ref } from 'vue'
import LoginView from './views/LoginView.vue'
import SettingsView from './views/SettingsView.vue'
import PlaceholderView from './views/PlaceholderView.vue'

type Authed = boolean | null

const authed = ref<Authed>(null)
const view = ref('chat')
const healthVersion = ref('')

const nav = [
  { key: 'chat', label: '对话', title: '对话', ticket: '工单 06' },
  { key: 'kb', label: '知识库', title: '知识库', ticket: '工单 03' },
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

  <div v-else-if="authed === true" class="flex h-full">
    <aside class="flex w-56 shrink-0 flex-col border-r border-edge bg-panel">
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

    <main class="flex-1 overflow-auto p-8">
      <SettingsView v-if="view === 'settings'" @changed="authed = false" />
      <PlaceholderView
        v-else
        :title="activeTitle().title"
        :ticket="activeTitle().ticket"
      />
    </main>
  </div>

  <div v-else class="grid h-full place-items-center text-ink-dim">连接中…</div>
</template>
