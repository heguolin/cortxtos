<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { fmtDbTime } from '../format'
import { renderMarkdown } from '../markdown'

interface BriefingItem {
  id: number
  status: 'running' | 'success' | 'failed'
  started_at: string
  preview: string
}
interface BriefingDetail extends BriefingItem {
  output: string | null
  error: string | null
  finished_at: string | null
}

const props = defineProps<{ readonly?: boolean }>()
const briefings = ref<BriefingItem[]>([])
const detail = ref<BriefingDetail | null>(null)
const generating = ref(false)
const error = ref('')

const statusClass: Record<string, string> = {
  running: 'bg-neon/20 text-neon animate-pulse',
  success: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
}

async function refresh() {
  const res = await fetch('/api/briefings')
  if (res.ok) briefings.value = ((await res.json()) as { briefings: BriefingItem[] }).briefings
}
onMounted(refresh)

async function open(item: BriefingItem) {
  const res = await fetch(`/api/briefings/${item.id}`)
  if (res.ok) detail.value = (await res.json()).briefing as BriefingDetail
}

async function generate() {
  generating.value = true
  error.value = ''
  try {
    const res = await fetch('/api/jobs/daily-briefing/run', { method: 'POST' })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new Error(data.error ?? `触发失败 (${res.status})`)
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    generating.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl space-y-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-lg font-bold">每日简报</h2>
        <p class="mt-1 text-xs text-ink-dim">每天定时扫描过去 24h 新增/变更文档，由 background 档模型生成</p>
      </div>
      <button
        v-if="!props.readonly"
        class="rounded-lg bg-neon/20 px-4 py-2 text-sm font-semibold text-neon transition hover:bg-neon/30 disabled:opacity-50"
        :disabled="generating"
        @click="generate"
      >
        {{ generating ? '生成中…' : '立即生成' }}
      </button>
    </div>

    <p v-if="error" class="text-sm text-red-400">{{ error }}</p>

    <div class="space-y-3">
      <div v-if="briefings.length === 0" class="rounded-2xl border border-edge bg-panel p-8 text-center text-sm text-ink-dim">
        还没有简报——点右上角「立即生成」试试
      </div>
      <button
        v-for="b in briefings"
        :key="b.id"
        class="block w-full rounded-2xl border border-edge bg-panel p-5 text-left transition hover:border-neon/50"
        @click="open(b)"
      >
        <div class="flex items-center justify-between">
          <span class="text-sm text-ink">简报 #{{ b.id }}</span>
          <div class="flex items-center gap-3">
            <span class="text-xs text-ink-dim">{{ fmtDbTime(b.started_at) }}</span>
            <span class="rounded-full px-2 py-0.5 text-xs" :class="statusClass[b.status]">{{ b.status }}</span>
          </div>
        </div>
        <p class="mt-2 truncate text-sm text-ink-dim">{{ b.preview || '（无内容）' }}</p>
      </button>
    </div>

    <div
      v-if="detail"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      @click.self="detail = null"
    >
      <div class="flex h-full max-h-[80vh] w-full max-w-3xl flex-col rounded-2xl border border-edge bg-panel">
        <div class="flex items-center justify-between border-b border-edge px-6 py-4">
          <h3 class="font-bold">简报 #{{ detail.id }} · {{ fmtDbTime(detail.started_at) }}</h3>
          <button class="text-ink-dim transition hover:text-ink" @click="detail = null">关闭</button>
        </div>
        <div class="flex-1 overflow-auto px-8 py-6">
          <p v-if="detail.status === 'failed'" class="text-sm text-red-400">{{ detail.error }}</p>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-else class="max-w-none text-sm leading-7 [&_h1]:mb-3 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-bold [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-3" v-html="renderMarkdown(detail.output ?? '')"></div>
        </div>
      </div>
    </div>
  </div>
</template>
