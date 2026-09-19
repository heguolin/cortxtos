<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { bus } from '../store'

interface Stats {
  docsTotal: number
  docsToday: number
  sessions: number
  activeJobs: number
  tokensToday: number
  tokens24hChat: number
}
interface RecentDoc {
  id: number
  title: string
  status: string
  updated_at: string
}
interface DashData {
  stats: Stats
  recentDocs: RecentDoc[]
  latestBriefing: { id: number; started_at: string; output: string } | null
  usage7d: Array<{ day: string; chat: number; embed: number; background: number }>
}

const data = ref<DashData | null>(null)
const question = ref('')
const captureText = ref('')
const capturing = ref(false)
const captureMsg = ref('')
const captureOk = ref(false)
const emit = defineEmits<{ navigate: [page: string] }>()

const hour = new Date().getHours()
const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
const dateLine = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })

const briefingExcerpt = computed(() => {
  const raw = data.value?.latestBriefing?.output ?? ''
  if (!raw) return ''
  return DOMPurify.sanitize(marked.parse(raw.slice(0, 220), { async: false }))
})
const maxUsage = computed(() =>
  Math.max(1, ...(data.value?.usage7d ?? []).map((d) => d.chat + d.embed + d.background)),
)

function fmtTokens(n: number): string {
  return n >= 10000 ? `${(n / 10000).toFixed(1)}万` : String(n)
}
function barHeight(kind: 'chat' | 'embed' | 'background', d: DashData['usage7d'][number]): string {
  return `${Math.max(3, (d[kind] / maxUsage.value) * 100)}%`
}

async function refresh() {
  const res = await fetch('/api/dashboard')
  if (res.ok) data.value = (await res.json()) as DashData
}
onMounted(refresh)

function ask(q: string) {
  const text = q.trim()
  if (!text) return
  bus.ask = text
  emit('navigate', 'chat')
}

async function capture() {
  const text = captureText.value.trim()
  if (!text) return
  capturing.value = true
  captureMsg.value = ''
  try {
    const res = await fetch('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    const body = (await res.json().catch(() => ({}))) as { error?: string; duplicate?: boolean }
    if (!res.ok) throw new Error(body.error ?? `入库失败 (${res.status})`)
    captureOk.value = true
    captureMsg.value = body.duplicate ? '内容已存在（幂等），未重复入库' : '已入库，正在自动索引 ✦'
    captureText.value = ''
    void refresh()
  } catch (e) {
    captureOk.value = false
    captureMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    capturing.value = false
  }
}
</script>

<template>
  <div class="relative mx-auto max-w-5xl">
    <span class="pointer-events-none absolute right-[10%] -top-2 animate-pulse text-neon">✦</span>
    <span class="pointer-events-none absolute right-[3%] top-8 text-xs text-neon-soft">✦</span>

    <!-- 问候 -->
    <div class="mb-5">
      <h2 class="text-2xl font-bold">{{ greeting }}，<em class="not-italic text-neon">主人</em> ✦</h2>
      <p class="mt-2 text-sm text-ink-dim">
        {{ dateLine }} · 知识库近 24h 有 <b class="text-ink">{{ data?.stats.docsToday ?? '…' }}</b> 篇更新<template v-if="data?.latestBriefing"> · 简报已生成</template>
      </p>
    </div>

    <!-- 统计卡 -->
    <div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 md:gap-4">
      <div class="rounded-2xl border border-edge bg-panel p-4 shadow-[0_0_24px_rgba(242,107,255,0.05)]">
        <p class="text-xs text-ink-dim">📚 知识库文档</p>
        <p class="mt-1 text-2xl font-bold">{{ data?.stats.docsTotal ?? '—' }} <span class="text-xs font-normal text-ink-dim">篇</span></p>
      </div>
      <div class="rounded-2xl border border-edge bg-panel p-4 shadow-[0_0_24px_rgba(242,107,255,0.05)]">
        <p class="text-xs text-ink-dim">⚡ 24h Token</p>
        <p class="mt-1 text-2xl font-bold">{{ data ? fmtTokens(data.stats.tokensToday) : '—' }}</p>
      </div>
      <div class="rounded-2xl border border-edge bg-panel p-4 shadow-[0_0_24px_rgba(242,107,255,0.05)]">
        <p class="text-xs text-ink-dim">⏰ 活跃任务</p>
        <p class="mt-1 text-2xl font-bold">{{ data?.stats.activeJobs ?? '—' }} <span class="text-xs font-normal text-ink-dim">个</span></p>
      </div>
      <div class="rounded-2xl border border-edge bg-panel p-4 shadow-[0_0_24px_rgba(242,107,255,0.05)]">
        <p class="text-xs text-ink-dim">💬 对话会话</p>
        <p class="mt-1 text-2xl font-bold">{{ data?.stats.sessions ?? '—' }} <span class="text-xs font-normal text-ink-dim">个</span></p>
      </div>
    </div>

    <div class="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <div class="space-y-4 lg:col-span-3">
        <!-- 今日简报 -->
        <div class="relative overflow-hidden rounded-2xl border border-edge bg-panel p-5 shadow-[0_0_30px_rgba(242,107,255,0.06)]">
          <div class="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full bg-[radial-gradient(closest-side,rgba(242,107,255,0.16),transparent)]"></div>
          <div class="flex items-center gap-2.5">
            <h3 class="text-sm font-bold">📰 今日简报</h3>
            <span v-if="data?.latestBriefing" class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-300">已生成</span>
            <button class="ml-auto text-xs text-neon-soft hover:text-neon" @click="emit('navigate', 'briefing')">查看全部 →</button>
          </div>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div v-if="briefingExcerpt" class="prose-invert mt-3 text-[13px] leading-7 text-ink-dim [&_b]:text-ink" v-html="briefingExcerpt"></div>
          <p v-else class="mt-3 text-[13px] text-ink-dim">
            还没有简报——去「任务」页开启每日简报，或现在
            <button class="text-neon-soft underline" @click="emit('navigate', 'briefing')">立即生成</button>
          </p>
          <button
            v-if="data?.latestBriefing"
            class="mt-3 rounded-lg bg-neon/20 px-3.5 py-1.5 text-xs font-semibold text-neon transition hover:bg-neon/30"
            @click="emit('navigate', 'briefing')"
          >
            阅读全文
          </button>
        </div>

        <!-- 快速捕获 -->
        <div class="rounded-2xl border border-edge bg-panel p-5">
          <h3 class="text-sm font-bold">✍️ 快速捕获</h3>
          <textarea
            v-model="captureText"
            rows="2"
            placeholder="随手记一段，首行自动当标题，保存即入知识库…"
            class="mt-3 w-full resize-none rounded-xl border border-edge bg-void px-4 py-2.5 text-sm outline-none focus:border-neon"
          ></textarea>
          <div class="mt-2 flex items-center justify-between">
            <p v-if="captureMsg" :class="captureOk ? 'text-neon-soft' : 'text-red-400'" class="text-xs">{{ captureMsg }}</p>
            <span v-else class="text-[11px] text-ink-dim">支持 Markdown 或贴网页链接（自动抓正文入库），上限 5 万字</span>
            <button
              class="rounded-lg bg-neon/20 px-3.5 py-1.5 text-xs font-semibold text-neon transition hover:bg-neon/30 disabled:opacity-40"
              :disabled="capturing || !captureText.trim()"
              @click="capture"
            >
              {{ capturing ? '入库中…' : '保存入库' }}
            </button>
          </div>
        </div>

        <!-- 快捷提问 -->
        <div class="rounded-2xl border border-edge bg-panel p-5">
          <h3 class="text-sm font-bold">💬 快捷提问</h3>
          <div class="mt-3 flex gap-2.5">
            <input
              v-model="question"
              placeholder="问点什么，回车直达对话…"
              class="min-w-0 flex-1 rounded-xl border border-edge bg-void px-4 py-2.5 text-sm outline-none focus:border-neon focus:shadow-[0_0_0_3px_rgba(242,107,255,0.12)]"
              @keydown.enter="ask(question)"
            />
            <button class="rounded-xl bg-neon/20 px-4 py-2 text-sm font-semibold text-neon transition hover:bg-neon/30" @click="ask(question)">
              发送
            </button>
          </div>
          <div class="mt-2.5 flex flex-wrap gap-2">
            <button class="rounded-full bg-neon-soft/12 px-2.5 py-1 text-[11.5px] text-neon-soft transition hover:bg-neon-soft/25" @click="ask('总结最近新增的文档内容')">
              总结最近新增的文档
            </button>
            <button class="rounded-full bg-neon-soft/12 px-2.5 py-1 text-[11.5px] text-neon-soft transition hover:bg-neon-soft/25" @click="ask('我的知识库里有哪些主题？')">
              知识库有哪些主题？
            </button>
          </div>
        </div>
      </div>

      <div class="space-y-4 lg:col-span-2">
        <!-- 最近文档 -->
        <div class="rounded-2xl border border-edge bg-panel p-5">
          <div class="flex items-center">
            <h3 class="text-sm font-bold">🕒 最近文档</h3>
            <button class="ml-auto text-xs text-neon-soft hover:text-neon" @click="emit('navigate', 'kb')">全部 →</button>
          </div>
          <ul>
            <li v-for="doc in data?.recentDocs ?? []" :key="doc.id" class="flex items-center gap-2 border-b border-edge/50 py-2 last:border-0">
              <span class="min-w-0 flex-1 truncate text-[13px]">{{ doc.title }}</span>
              <span
                class="rounded-full px-1.5 py-0.5 text-[10px]"
                :class="doc.status === 'ready' ? 'bg-emerald-500/15 text-emerald-300' : doc.status === 'failed' ? 'bg-red-500/15 text-red-300' : 'bg-white/10 text-ink-dim'"
              >{{ doc.status }}</span>
            </li>
            <li v-if="data && data.recentDocs.length === 0" class="py-3 text-center text-xs text-ink-dim">
              知识库空空如也 ✦ 去<a class="text-neon-soft" @click="emit('navigate', 'kb')" href="javascript:void 0">上传文档</a>
            </li>
          </ul>
        </div>

        <!-- 用量 -->
        <div class="rounded-2xl border border-edge bg-panel p-5">
          <h3 class="text-sm font-bold">⚡ 近 7 日用量</h3>
          <div class="mt-2 flex h-24 items-end gap-2">
            <div v-for="d in data?.usage7d ?? []" :key="d.day" class="flex h-full flex-1 flex-col justify-end gap-0.5">
              <i class="block rounded-t bg-gradient-to-b from-neon to-neon/30" :style="{ height: d.chat ? barHeight('chat', d) : '0' }"></i>
              <i class="block rounded-t bg-neon-soft/40" :style="{ height: d.background ? barHeight('background', d) : '0' }"></i>
              <i class="block rounded-t bg-neon-soft/25" :style="{ height: d.embed ? barHeight('embed', d) : '0' }"></i>
              <em class="not-italic text-center text-[10px] text-ink-dim">{{ d.day.slice(3) }}</em>
            </div>
          </div>
          <p class="mt-2 text-[11px] text-ink-dim"><span class="text-neon">▮</span> 对话 <span class="text-neon-soft">▮</span> 后台 <span class="text-neon-soft/60">▮</span> 嵌入</p>
        </div>
      </div>
    </div>
  </div>
</template>
