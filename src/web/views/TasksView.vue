<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { fmtDbTime } from '../format'
import { renderMarkdown } from '../markdown'

interface Job {
  id: number
  name: string
  title: string
  schedule: string
  prompt: string | null
  enabled: boolean
  builtin: boolean
  last_run_at: string | null
}
interface Run {
  id: number
  job_title: string
  status: 'running' | 'success' | 'failed'
  started_at: string
  finished_at: string | null
  output: string | null
  error: string | null
}

const jobs = ref<Job[]>([])
const runs = ref<Run[]>([])
const creating = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')
const detail = ref<Run | null>(null)
// 改时间：正在编辑的 job id + 新时间
const editingTime = ref<number | null>(null)
const editTimeValue = ref('')

// 新建表单
const form = ref({ title: '', schedule: '22:00', prompt: '', withKb: false })

const statusClass: Record<string, string> = {
  running: 'bg-neon/20 text-neon animate-pulse',
  success: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
}

function dur(r: Run): string {
  if (!r.finished_at) return '…'
  const s = (new Date(r.finished_at.replace(' ', 'T') + 'Z').getTime() - new Date(r.started_at.replace(' ', 'T') + 'Z').getTime()) / 1000
  return `${Math.max(1, Math.round(s))}s`
}

async function refresh() {
  const [j, r] = await Promise.all([fetch('/api/jobs'), fetch('/api/runs')])
  if (j.ok) jobs.value = ((await j.json()) as { jobs: Job[] }).jobs
  if (r.ok) runs.value = ((await r.json()) as { runs: Run[] }).runs
}
onMounted(refresh)

async function create() {
  error.value = ''
  busy.value = true
  try {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form.value),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new Error(data.error ?? `创建失败 (${res.status})`)
    creating.value = false
    form.value = { title: '', schedule: '22:00', prompt: '', withKb: false }
    notice.value = '任务已创建'
    await refresh()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function toggleEnabled(job: Job) {
  const res = await fetch(`/api/jobs/${job.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: !job.enabled }),
  })
  if (res.ok) await refresh()
}

async function saveTime(job: Job) {
  if (!editTimeValue.value) return
  const res = await fetch(`/api/jobs/${job.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ schedule: editTimeValue.value }),
  })
  editingTime.value = null
  if (res.ok) await refresh()
}

async function runNow(job: Job) {
  notice.value = ''
  error.value = ''
  const res = await fetch(`/api/jobs/${job.id}/run`, { method: 'POST' })
  if (res.ok) {
    notice.value = `「${job.title}」已运行完成`
    await refresh()
  } else {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    error.value = data.error ?? `触发失败 (${res.status})`
  }
}

async function remove(job: Job) {
  if (!confirm(`删除任务「${job.title}」？运行记录将一并删除。`)) return
  await fetch(`/api/jobs/${job.id}`, { method: 'DELETE' })
  await refresh()
}
</script>

<template>
  <div class="mx-auto max-w-5xl">
    <div class="mb-4 flex items-center justify-between">
      <h2 class="text-lg font-bold">⚙ 定时任务</h2>
      <button class="rounded-lg bg-neon/20 px-3.5 py-2 text-sm font-semibold text-neon transition hover:bg-neon/30" @click="creating = !creating">
        ＋ 新建任务
      </button>
    </div>

    <p v-if="notice" class="mb-3 text-sm text-neon-soft">{{ notice }}</p>
    <p v-if="error" class="mb-3 text-sm text-red-400">{{ error }}</p>

    <!-- 新建表单 -->
    <div v-if="creating" class="mb-4 rounded-2xl border border-dashed border-neon/40 bg-panel p-5">
      <h3 class="text-sm font-bold">新建定时任务</h3>
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_130px]">
        <div>
          <label class="mb-1 block text-xs text-ink-dim">任务名称</label>
          <input v-model="form.title" placeholder="如：晚间新增总结" class="w-full rounded-lg border border-edge bg-void px-3 py-2 text-sm outline-none focus:border-neon" />
        </div>
        <div>
          <label class="mb-1 block text-xs text-ink-dim">每天几点跑</label>
          <input v-model="form.schedule" type="time" class="w-full rounded-lg border border-edge bg-void px-3 py-2 text-sm outline-none focus:border-neon" />
        </div>
      </div>
      <div class="mt-3">
        <label class="mb-1 block text-xs text-ink-dim">提示词（到点交给后台模型执行）</label>
        <textarea v-model="form.prompt" rows="3" placeholder="如：总结今天新增的文档，用三句话告诉我今天学了什么" class="w-full resize-none rounded-lg border border-edge bg-void px-3 py-2 text-sm outline-none focus:border-neon"></textarea>
      </div>
      <label class="mt-3 flex cursor-pointer items-center gap-2 text-sm text-ink-dim">
        <input v-model="form.withKb" type="checkbox" class="h-4 w-4 accent-[#f26bff]" />
        携带知识库检索（用提示词当检索词，命中片段注入上下文）
      </label>
      <div class="mt-3 flex justify-end gap-3">
        <button class="rounded-lg px-4 py-2 text-sm text-ink-dim hover:text-ink" @click="creating = false">取消</button>
        <button class="rounded-lg bg-neon/20 px-4 py-2 text-sm font-semibold text-neon hover:bg-neon/30 disabled:opacity-50" :disabled="busy || !form.title || !form.prompt" @click="create">
          {{ busy ? '创建中…' : '创建任务' }}
        </button>
      </div>
    </div>

    <!-- 任务卡片 -->
    <div class="mb-5 grid grid-cols-1 gap-3.5 md:grid-cols-2">
      <div v-if="jobs.length === 0" class="col-span-full rounded-2xl border border-edge bg-panel p-8 text-center text-sm text-ink-dim">
        还没有任务 ✦ 点右上角「新建任务」
      </div>
      <div v-for="job in jobs" :key="job.id" class="rounded-2xl border border-edge bg-panel p-5 shadow-[0_0_24px_rgba(242,107,255,0.04)]">
        <div class="flex items-start gap-3">
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-bold">{{ job.title }}</p>
            <p class="mt-0.5 font-mono text-xs text-neon-soft">
              每天 {{ job.schedule }}
              <span v-if="job.builtin" class="ml-1 rounded bg-white/10 px-1.5 py-0.5 font-sans text-[10px] text-ink-dim">内置</span>
            </p>
          </div>
          <button
            class="relative h-5 w-9 shrink-0 rounded-full transition"
            :class="job.enabled ? 'bg-neon/40' : 'bg-edge'"
            :title="job.enabled ? '点击停用' : '点击启用'"
            @click="toggleEnabled(job)"
          >
            <span
              class="absolute top-0.5 h-4 w-4 rounded-full transition-all"
              :class="job.enabled ? 'left-[18px] bg-neon shadow-[0_0_8px_rgba(242,107,255,0.8)]' : 'left-0.5 bg-ink-dim'"
            ></span>
          </button>
        </div>
        <p class="mt-2 line-clamp-2 text-xs leading-6 text-ink-dim">
          {{ job.prompt ?? '扫描过去 24h 新增/变更文档，生成知识库日报' }}
        </p>
        <div class="mt-3 flex items-center gap-2">
          <template v-if="editingTime === job.id">
            <input v-model="editTimeValue" type="time" class="rounded-lg border border-edge bg-void px-2 py-1 text-xs" />
            <button class="rounded-lg bg-neon/20 px-2.5 py-1 text-xs text-neon" @click="saveTime(job)">保存</button>
            <button class="px-1 text-xs text-ink-dim" @click="editingTime = null">取消</button>
          </template>
          <template v-else>
            <button class="rounded-lg border border-edge px-2.5 py-1 text-xs text-ink-dim transition hover:text-ink" @click="editingTime = job.id; editTimeValue = job.schedule">
              改时间
            </button>
            <button class="rounded-lg bg-neon/20 px-2.5 py-1 text-xs font-semibold text-neon transition hover:bg-neon/30" @click="runNow(job)">
              立即运行
            </button>
            <button v-if="!job.builtin" class="ml-auto text-xs text-ink-dim transition hover:text-red-400" @click="remove(job)">删除</button>
            <span v-if="job.last_run_at" class="text-[11px] text-ink-dim">上次: {{ fmtDbTime(job.last_run_at) }}</span>
          </template>
        </div>
      </div>
    </div>

    <!-- 运行记录 -->
    <h3 class="mb-2.5 text-sm font-bold">运行记录</h3>
    <div class="overflow-x-auto rounded-2xl border border-edge bg-panel">
      <table class="w-full min-w-[560px] text-sm">
        <thead>
          <tr class="border-b border-edge text-left text-xs text-ink-dim">
            <th class="px-4 py-2.5">任务</th>
            <th class="px-3 py-2.5">状态</th>
            <th class="px-3 py-2.5">耗时</th>
            <th class="px-3 py-2.5">时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="runs.length === 0">
            <td colspan="4" class="px-4 py-6 text-center text-ink-dim">还没有运行记录</td>
          </tr>
          <tr v-for="r in runs" :key="r.id" class="cursor-pointer border-b border-edge/40 transition last:border-0 hover:bg-neon/5" @click="detail = r">
            <td class="px-4 py-2.5">{{ r.job_title }}</td>
            <td class="px-3 py-2.5"><span class="rounded-full px-2 py-0.5 text-xs" :class="statusClass[r.status]">{{ r.status }}</span></td>
            <td class="px-3 py-2.5 text-ink-dim">{{ dur(r) }}</td>
            <td class="px-3 py-2.5 text-xs text-ink-dim">{{ fmtDbTime(r.started_at) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 运行详情 -->
    <div v-if="detail" class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 md:p-6" @click.self="detail = null">
      <div class="flex h-full max-h-[80vh] w-full max-w-3xl flex-col rounded-2xl border border-edge bg-panel">
        <div class="flex items-center justify-between border-b border-edge px-6 py-4">
          <h3 class="font-bold">{{ detail.job_title }} · {{ fmtDbTime(detail.started_at) }}</h3>
          <button class="text-ink-dim hover:text-ink" @click="detail = null">关闭</button>
        </div>
        <div class="flex-1 overflow-auto px-7 py-6">
          <p v-if="detail.status === 'failed'" class="text-sm text-red-400">{{ detail.error }}</p>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-else class="max-w-none text-sm leading-7 [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-bold [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-3" v-html="renderMarkdown(detail.output ?? '')"></div>
        </div>
      </div>
    </div>
  </div>
</template>
