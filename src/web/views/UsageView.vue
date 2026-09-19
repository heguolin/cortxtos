<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

interface UsageData {
  days: number
  summary: { total: number; chat: number; background: number; embed: number; vision: number }
  models: Array<{ model: string; tokens: number }>
  daily: Array<{ day: string; chat: number; background: number; embed: number; vision: number }>
  records: Array<{ model: string; purpose: string; tokens: number; created_at: string }>
}

const data = ref<UsageData | null>(null)
const days = ref<7 | 30>(7)
const purposeFilter = ref<'all' | 'chat' | 'background' | 'embed' | 'vision'>('all')
const loading = ref(false)

const maxDaily = computed(() =>
  Math.max(1, ...(data.value?.daily ?? []).map((d) => d.chat + d.background + d.embed + d.vision)),
)
const records = computed(() =>
  (data.value?.records ?? []).filter((r) => purposeFilter.value === 'all' || r.purpose === purposeFilter.value),
)

function fmtTokens(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n)
}
function fmtDbTime(v: string): string {
  const d = new Date(v.replace(' ', 'T') + 'Z')
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function barHeight(kind: keyof UsageData['daily'][number], d: UsageData['daily'][number]): string {
  if (kind === 'day') return '0'
  return `${Math.max(2, ((d[kind] as number) / maxDaily.value) * 100)}%`
}

async function refresh() {
  loading.value = true
  try {
    const res = await fetch(`/api/usage?days=${days.value}`)
    if (res.ok) data.value = (await res.json()) as UsageData
  } finally {
    loading.value = false
  }
}
onMounted(refresh)

function setDays(d: 7 | 30) {
  days.value = d
  void refresh()
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <div class="mb-4 flex items-center justify-between">
      <h2 class="text-lg font-bold">⚡ 用量</h2>
      <div class="flex gap-1 rounded-xl border border-edge p-1">
        <button
          class="rounded-lg px-3 py-1 text-xs transition"
          :class="days === 7 ? 'bg-neon/15 text-neon' : 'text-ink-dim'"
          @click="setDays(7)"
        >
          近 7 天
        </button>
        <button
          class="rounded-lg px-3 py-1 text-xs transition"
          :class="days === 30 ? 'bg-neon/15 text-neon' : 'text-ink-dim'"
          @click="setDays(30)"
        >
          近 30 天
        </button>
      </div>
    </div>

    <!-- 汇总卡 -->
    <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
      <div class="rounded-2xl border border-neon/40 bg-panel p-4">
        <p class="text-xs text-ink-dim">总 Token</p>
        <p class="mt-1 text-xl font-bold text-neon">{{ data ? fmtTokens(data.summary.total) : '—' }}</p>
      </div>
      <div class="rounded-2xl border border-edge bg-panel p-4">
        <p class="text-xs text-ink-dim">💬 对话</p>
        <p class="mt-1 text-xl font-bold">{{ data ? fmtTokens(data.summary.chat) : '—' }}</p>
      </div>
      <div class="rounded-2xl border border-edge bg-panel p-4">
        <p class="text-xs text-ink-dim">⚙ 后台</p>
        <p class="mt-1 text-xl font-bold">{{ data ? fmtTokens(data.summary.background) : '—' }}</p>
      </div>
      <div class="rounded-2xl border border-edge bg-panel p-4">
        <p class="text-xs text-ink-dim">🧩 嵌入</p>
        <p class="mt-1 text-xl font-bold">{{ data ? fmtTokens(data.summary.embed) : '—' }}</p>
      </div>
      <div class="hidden rounded-2xl border border-edge bg-panel p-4 md:block">
        <p class="text-xs text-ink-dim">🖼 视觉</p>
        <p class="mt-1 text-xl font-bold">{{ data ? fmtTokens(data.summary.vision) : '—' }}</p>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <!-- 每日柱状 -->
      <div class="rounded-2xl border border-edge bg-panel p-5 lg:col-span-3">
        <h3 class="text-sm font-bold">每日趋势</h3>
        <div class="mt-3 flex h-44 items-end gap-1.5">
          <div v-for="d in data?.daily ?? []" :key="d.day" class="flex h-full flex-1 flex-col justify-end gap-0.5">
            <i class="block rounded-t bg-gradient-to-b from-neon to-neon/30" :style="{ height: barHeight('chat', d) }"></i>
            <i class="block rounded-t bg-neon-soft/50" :style="{ height: barHeight('vision', d) }"></i>
            <i class="block rounded-t bg-neon-soft/35" :style="{ height: barHeight('background', d) }"></i>
            <i class="block rounded-t bg-neon-soft/20" :style="{ height: barHeight('embed', d) }"></i>
            <em class="not-italic text-center text-[9px] text-ink-dim">{{ d.day.slice(3) }}</em>
          </div>
        </div>
        <p class="mt-2 text-[11px] text-ink-dim">
          <span class="text-neon">▮</span>对话 <span class="text-neon-soft">▮</span>视觉 <span class="text-neon-soft/70">▮</span>后台 <span class="text-neon-soft/50">▮</span>嵌入
        </p>
      </div>

      <!-- 按模型 -->
      <div class="rounded-2xl border border-edge bg-panel p-5 lg:col-span-2">
        <h3 class="text-sm font-bold">按模型 Top10</h3>
        <ul class="mt-3 space-y-2">
          <li v-for="m in data?.models ?? []" :key="m.model">
            <div class="flex items-center justify-between text-xs">
              <span class="min-w-0 truncate font-mono text-neon-soft">{{ m.model }}</span>
              <span class="text-ink-dim">{{ fmtTokens(m.tokens) }}</span>
            </div>
            <div class="mt-1 h-1.5 rounded-full bg-edge/50">
              <div
                class="h-full rounded-full bg-gradient-to-r from-neon to-neon-soft"
                :style="{ width: `${Math.max(3, (m.tokens / (data!.models[0]!.tokens || 1)) * 100)}%` }"
              ></div>
            </div>
          </li>
          <li v-if="data && data.models.length === 0" class="py-4 text-center text-xs text-ink-dim">
            这个周期还没有调用
          </li>
        </ul>
      </div>
    </div>

    <!-- 明细表 -->
    <div class="mt-4 rounded-2xl border border-edge bg-panel">
      <div class="flex items-center gap-2 border-b border-edge px-4 py-3">
        <h3 class="text-sm font-bold">调用明细</h3>
        <div class="ml-auto flex gap-1">
          <button
            v-for="p in ['all', 'chat', 'background', 'embed', 'vision'] as const"
            :key="p"
            class="rounded-full px-2.5 py-1 text-[11px] transition"
            :class="purposeFilter === p ? 'bg-neon/15 text-neon' : 'text-ink-dim hover:text-ink'"
            @click="purposeFilter = p"
          >
            {{ p === 'all' ? '全部' : p }}
          </button>
        </div>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[520px] text-sm">
          <thead>
            <tr class="border-b border-edge text-left text-xs text-ink-dim">
              <th class="px-4 py-2.5">模型</th>
              <th class="px-3 py-2.5">用途</th>
              <th class="px-3 py-2.5">Token</th>
              <th class="px-4 py-2.5">时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="records.length === 0">
              <td colspan="4" class="px-4 py-6 text-center text-ink-dim">没有调用记录</td>
            </tr>
            <tr v-for="(r, i) in records" :key="i" class="border-b border-edge/40 last:border-0">
              <td class="px-4 py-2.5 font-mono text-xs text-neon-soft">{{ r.model }}</td>
              <td class="px-3 py-2.5"><span class="rounded-full bg-white/8 px-2 py-0.5 text-[11px] text-ink-dim">{{ r.purpose }}</span></td>
              <td class="px-3 py-2.5">{{ r.tokens }}</td>
              <td class="px-4 py-2.5 text-xs text-ink-dim">{{ fmtDbTime(r.created_at) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
