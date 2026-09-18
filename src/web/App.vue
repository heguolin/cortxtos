<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Health {
  ok: boolean
  version: string
}

const health = ref<Health | null>(null)
const healthError = ref(false)

const nav = [
  { key: 'chat', label: '对话', hint: '工单 06' },
  { key: 'kb', label: '知识库', hint: '工单 03' },
  { key: 'briefing', label: '简报', hint: '工单 07' },
  { key: 'settings', label: '设置', hint: '工单 02' },
]

onMounted(async () => {
  try {
    const res = await fetch('/healthz')
    health.value = res.ok ? ((await res.json()) as Health) : null
    healthError.value = !res.ok
  } catch {
    healthError.value = true
  }
})
</script>

<template>
  <div class="flex h-full">
    <aside class="flex w-56 shrink-0 flex-col border-r border-edge bg-panel">
      <div class="px-5 py-5">
        <h1 class="text-lg font-bold tracking-wide text-ink">
          Cortxt<span class="text-neon">OS</span>
        </h1>
        <p class="mt-1 text-xs text-ink-dim">自托管个人 AI 工作台</p>
      </div>
      <nav class="flex-1 space-y-1 px-3">
        <div
          v-for="item in nav"
          :key="item.key"
          class="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-ink-dim"
        >
          <span>{{ item.label }}</span>
          <span class="text-[10px] text-edge">{{ item.hint }}</span>
        </div>
      </nav>
      <div class="border-t border-edge px-5 py-4 text-xs">
        <span v-if="health" class="text-neon-soft">daemon v{{ health.version }} · 在线</span>
        <span v-else-if="healthError" class="text-red-400">daemon 未连接</span>
        <span v-else class="text-ink-dim">连接中…</span>
      </div>
    </aside>

    <main class="flex-1 overflow-auto p-8">
      <div class="mx-auto max-w-2xl rounded-2xl border border-edge bg-panel p-8">
        <h2 class="text-xl font-bold">骨架已就绪</h2>
        <p class="mt-3 text-sm leading-6 text-ink-dim">
          票 01 完成后，这里会依次长出：登录（02）→ 知识库（03/04）→
          检索问答（05/06）→ 每日简报（07）→ 深色霓虹主题定稿（08）。
        </p>
      </div>
    </main>
  </div>
</template>
