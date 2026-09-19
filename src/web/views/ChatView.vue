<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import ViewerModal from './ViewerModal.vue'
import { bus } from '../store'

interface Session {
  id: number
  title: string
  updated_at: string
}
interface Citation {
  n: number
  documentId: number
  title: string
  page: number | null
  headingPath: string | null
}
interface ChatMessage {
  id?: number
  role: 'user' | 'assistant'
  content: string
  citations: Citation[]
}

const sessions = ref<Session[]>([])
const currentId = ref<number | null>(null)
const messages = ref<ChatMessage[]>([])
const input = ref('')
const streaming = ref(false)
const streamText = ref('')
const streamCitations = ref<Citation[]>([])
const streamTool = ref('')
const error = ref('')
const viewer = ref<{ documentId: number; title: string; page: number | null } | null>(null)
const scrollBox = ref<HTMLElement | null>(null)
const mobileSessions = ref(false)
// 贴图（vision 档当轮对话，不入库）
const imageFile = ref<File | null>(null)
const imagePreview = ref('')
const currentSessionTitle = () => sessions.value.find((s) => s.id === currentId.value)?.title ?? ''

let aborter: AbortController | null = null

const sessionList = ref<HTMLElement | null>(null)

function renderMd(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }))
}

function fmtSize(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`
}
void fmtSize

async function scrollBottom() {
  await nextTick()
  scrollBox.value?.scrollTo({ top: scrollBox.value.scrollHeight })
}

async function loadSessions() {
  const res = await fetch('/api/sessions')
  if (res.ok) sessions.value = ((await res.json()) as { sessions: Session[] }).sessions
}
onMounted(loadSessions)

// 仪表盘快捷提问：带问题进入对话页时自动发送（immediate：挂载时已带问题也要触发）
watch(
  () => bus.ask,
  (q) => {
    if (!q) return
    bus.ask = ''
    input.value = q
    void send()
  },
  { immediate: true },
)

async function newSession() {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) return
  await loadSessions()
  await openSession(((await res.clone().json()) as { session: Session }).session.id)
}

async function openSession(id: number) {
  if (streaming.value) return
  currentId.value = id
  error.value = ''
  const res = await fetch(`/api/sessions/${id}`)
  if (res.ok) {
    const data = (await res.json()) as { messages: ChatMessage[] }
    messages.value = data.messages
    await scrollBottom()
  }
}

async function removeSession(s: Session) {
  if (!confirm(`删除会话「${s.title}」？`)) return
  await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' })
  if (currentId.value === s.id) {
    currentId.value = null
    messages.value = []
  }
  await loadSessions()
}

function stopStream() {
  aborter?.abort()
}

function pickImage(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  if (!f) return
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) {
    error.value = '仅支持 jpg / png / webp 图片'
    return
  }
  if (f.size > 10 * 1024 * 1024) {
    error.value = '图片超过 10MB 上限'
    return
  }
  error.value = ''
  imageFile.value = f
  imagePreview.value = URL.createObjectURL(f)
  input.value = ''
}

function clearImage() {
  imageFile.value = null
  imagePreview.value = ''
}

async function send() {
  const question = input.value.trim()
  if ((!question && !imageFile.value) || streaming.value) return
  error.value = ''
  if (!currentId.value) {
    await newSession()
    if (!currentId.value) return
  }
  const sessionId = currentId.value
  const img = imageFile.value
  input.value = ''
  clearImage()
  messages.value.push({ role: 'user', content: img ? `${question || '[图片]'} 🖼` : question, citations: [] })
  streaming.value = true
  streamText.value = ''
  streamCitations.value = []
  streamTool.value = ''
  await scrollBottom()

  aborter = new AbortController()
  try {
    let res: Response
    if (img) {
      const fd = new FormData()
      fd.append('content', question)
      fd.append('image', img)
      res = await fetch(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: fd, signal: aborter.signal })
    } else {
      res = await fetch(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: question }),
        signal: aborter.signal,
      })
    }
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(data.error ?? `请求失败 (${res.status})`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const rawEvent = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        let eventName = 'message'
        let data = ''
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (!data) continue
        const payload = JSON.parse(data) as Record<string, unknown>
        if (eventName === 'citations') {
          streamCitations.value = payload.citations as Citation[]
        } else if (eventName === 'tool') {
          // 深挖工具调用提示
          streamTool.value = `${payload.name as string} ${payload.detail as string}`
        } else if (eventName === 'delta') {
          streamTool.value = ''
          streamText.value += payload.text as string
          void scrollBottom()
        } else if (eventName === 'error') {
          error.value = payload.message as string
        } else if (eventName === 'done') {
          const p = payload as { userMessage: ChatMessage; assistantMessage: ChatMessage }
          // 用户消息已在发送时乐观插入，这里只补服务端的回答（否则用户气泡会重复）
          const optimistic = [...messages.value].reverse().find((m) => m.role === 'user')
          if (optimistic) {
            optimistic.id = p.userMessage.id ?? optimistic.id
          } else {
            messages.value.push(p.userMessage)
          }
          messages.value.push(p.assistantMessage)
          streamText.value = ''
          streamCitations.value = []
          void scrollBottom()
        }
      }
    }
    await loadSessions()
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      error.value = ''
    } else {
      error.value = e instanceof Error ? e.message : String(e)
    }
    if (streamText.value) {
      // 保留已生成的部分
      messages.value.push({ role: 'assistant', content: streamText.value, citations: streamCitations.value })
      streamText.value = ''
    }
  } finally {
    streaming.value = false
    aborter = null
    await scrollBottom()
  }
}

function isFailedAssistant(m: ChatMessage): boolean {
  return m.role === 'assistant' && /^生成失败：|（生成中断：/.test(m.content)
}

async function retry(message: ChatMessage) {
  if (streaming.value || !currentId.value) return
  error.value = ''
  streaming.value = true
  streamText.value = ''
  streamCitations.value = []
  await scrollBottom()
  aborter = new AbortController()
  try {
    const res = await fetch(`/api/sessions/${currentId.value}/retry`, {
      method: 'POST',
      signal: aborter.signal,
    })
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      throw new Error(data.error ?? `重试失败 (${res.status})`)
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const rawEvent = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        let eventName = 'message'
        let data = ''
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim()
          else if (line.startsWith('data:')) data += line.slice(5).trim()
        }
        if (!data) continue
        const payload = JSON.parse(data) as Record<string, unknown>
        if (eventName === 'delta') {
          streamText.value += payload.text as string
          void scrollBottom()
        } else if (eventName === 'error') {
          error.value = payload.message as string
        } else if (eventName === 'done') {
          const p = payload as { replacedMessage: ChatMessage }
          // 原位替换失败的那条回复
          const at = messages.value.findIndex((m) => m.id === p.replacedMessage.id)
          if (at >= 0) messages.value[at] = p.replacedMessage
          else messages.value.push(p.replacedMessage)
          streamText.value = ''
          void scrollBottom()
        }
      }
    }
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'AbortError')) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  } finally {
    streaming.value = false
    aborter = null
    await scrollBottom()
  }
}

function onCitation(c: Citation) {
  viewer.value = { documentId: c.documentId, title: c.title, page: c.page }
}
</script>

<template>
  <div class="flex h-full gap-3 md:gap-6">
    <!-- 会话列表：桌面端常驻侧栏 -->
    <aside class="hidden w-56 shrink-0 flex-col rounded-2xl border border-edge bg-panel md:flex">
      <button
        class="m-3 rounded-lg bg-neon/20 py-2 text-sm font-semibold text-neon transition hover:bg-neon/30"
        @click="newSession"
      >
        + 新对话
      </button>
      <div ref="sessionList" class="flex-1 overflow-auto px-2 pb-3">
        <button
          v-for="s in sessions"
          :key="s.id"
          class="group mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition"
          :class="currentId === s.id ? 'bg-neon/15 text-neon' : 'text-ink-dim hover:text-ink'"
          @click="openSession(s.id)"
        >
          <span class="truncate">{{ s.title }}</span>
          <span
            class="ml-2 hidden text-xs text-ink-dim group-hover:inline"
            @click.stop="removeSession(s)"
            >删</span
          >
        </button>
      </div>
    </aside>

    <!-- 对话区 -->
    <div class="relative flex min-w-0 flex-1 flex-col rounded-2xl border border-edge bg-panel">
      <!-- 移动端会话工具条 -->
      <div class="flex items-center justify-between border-b border-edge px-4 py-2.5 md:hidden">
        <button
          class="rounded-lg bg-neon/15 px-3 py-1.5 text-xs text-neon"
          @click="mobileSessions = true"
        >
          ☰ 会话{{ currentSessionTitle() ? `：${currentSessionTitle()}` : '' }}
        </button>
        <button class="rounded-lg bg-neon/20 px-3 py-1.5 text-xs text-neon" @click="newSession">
          + 新对话
        </button>
      </div>

      <div ref="scrollBox" class="flex-1 space-y-4 overflow-auto p-4 md:p-6">
        <div v-if="messages.length === 0 && !streaming" class="mt-24 text-center">
          <p class="text-ink-dim">和你的知识库聊聊——回答会带出处引用</p>
          <p class="mt-2 text-xs text-ink-dim/60">先在「知识库」页上传文档，再回到这里提问</p>
        </div>

        <div v-for="(m, i) in messages" :key="i" class="flex" :class="m.role === 'user' ? 'justify-end' : 'justify-start'">
          <div
            class="max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-7"
            :class="m.role === 'user' ? 'bg-neon/15 text-ink' : 'border border-edge bg-void text-ink'"
          >
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-html="renderMd(m.content)"></div>
            <div v-if="m.citations.length" class="mt-3 flex flex-wrap gap-2 border-t border-edge/60 pt-2">
              <button
                v-for="c in m.citations"
                :key="c.n"
                class="rounded-full bg-neon/10 px-2 py-0.5 text-xs text-neon-soft transition hover:bg-neon/25"
                @click="onCitation(c)"
              >
                [{{ c.n }}] {{ c.title }}{{ c.page != null ? ` · p${c.page}` : '' }}
              </button>
            </div>
            <button
              v-if="isFailedAssistant(m)"
              class="mt-2.5 rounded-lg border border-neon/40 px-3 py-1.5 text-xs text-neon transition hover:bg-neon/10"
              @click="retry(m)"
            >
              ⚙ 切 background 档重试
            </button>
          </div>
        </div>

        <!-- 流式中的回复 -->
        <div v-if="streaming" class="flex justify-start">
          <div class="max-w-[80%] rounded-2xl border border-neon/40 bg-void px-4 py-3 text-sm leading-7">
            <p v-if="!streamText" class="text-ink-dim">
              {{ streamTool ? `🔧 ${streamTool}…` : '检索知识库中…' }}
            </p>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-else v-html="renderMd(streamText)"></div>
            <div v-if="streamCitations.length" class="mt-3 flex flex-wrap gap-2 border-t border-edge/60 pt-2">
              <span
                v-for="c in streamCitations"
                :key="c.n"
                class="rounded-full bg-neon/10 px-2 py-0.5 text-xs text-neon-soft"
              >
                [{{ c.n }}] {{ c.title }}{{ c.page != null ? ` · p${c.page}` : '' }}
              </span>
            </div>
          </div>
        </div>

        <p v-if="error" class="text-center text-sm text-red-400">{{ error }}</p>
      </div>

      <div class="border-t border-edge p-3 md:p-4">
        <!-- 深挖工具提示 -->
        <p v-if="streaming && streamTool" class="mb-2 truncate text-xs text-neon-soft">
          🔧 {{ streamTool }}…
        </p>
        <!-- 贴图预览 -->
        <div v-if="imagePreview" class="mb-2 flex items-center gap-2">
          <img :src="imagePreview" alt="预览" class="h-14 w-14 rounded-lg border border-edge object-cover" />
          <button class="text-xs text-ink-dim hover:text-red-400" @click="clearImage">移除</button>
        </div>
        <div class="flex items-end gap-2 md:gap-3">
          <label
            class="shrink-0 cursor-pointer rounded-xl border border-edge px-3 py-2.5 text-sm text-ink-dim transition hover:border-neon hover:text-neon md:py-3"
            title="贴图提问（vision）"
          >
            🖼
            <input type="file" accept="image/jpeg,image/png,image/webp" class="hidden" @change="pickImage" />
          </label>
          <textarea
            v-model="input"
            rows="2"
            placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
            class="min-w-0 flex-1 resize-none rounded-xl border border-edge bg-void px-3 py-2.5 text-sm outline-none focus:border-neon md:px-4 md:py-3"
            :disabled="streaming"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <button
            v-if="streaming"
            class="shrink-0 rounded-xl border border-red-400/50 px-3 py-2.5 text-sm text-red-300 transition hover:bg-red-400/10 md:px-5 md:py-3"
            @click="stopStream"
          >
            停止
          </button>
          <button
            v-else
            class="shrink-0 rounded-xl bg-neon/20 px-3 py-2.5 text-sm font-semibold text-neon transition hover:bg-neon/30 disabled:opacity-40 md:px-5 md:py-3"
            :disabled="!input.trim()"
            @click="send"
          >
            发送
          </button>
        </div>
      </div>
    </div>

    <!-- 移动端会话抽屉 -->
    <div
      v-if="mobileSessions"
      class="fixed inset-0 z-40 bg-black/60 md:hidden"
      @click.self="mobileSessions = false"
    >
      <div class="flex h-full w-72 flex-col border-r border-edge bg-panel p-3">
        <div class="mb-3 flex items-center justify-between px-1">
          <span class="text-sm font-bold">会话列表</span>
          <button class="text-ink-dim" @click="mobileSessions = false">关闭</button>
        </div>
        <button
          class="mb-3 rounded-lg bg-neon/20 py-2 text-sm font-semibold text-neon"
          @click="mobileSessions = false; newSession()"
        >
          + 新对话
        </button>
        <div class="flex-1 overflow-auto px-1">
          <button
            v-for="s in sessions"
            :key="s.id"
            class="group mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm"
            :class="currentId === s.id ? 'bg-neon/15 text-neon' : 'text-ink-dim'"
            @click="mobileSessions = false; openSession(s.id)"
          >
            <span class="truncate">{{ s.title }}</span>
            <span class="ml-2 text-xs text-ink-dim" @click.stop="removeSession(s)">删</span>
          </button>
          <p v-if="sessions.length === 0" class="px-3 py-4 text-xs text-ink-dim">还没有会话</p>
        </div>
      </div>
    </div>

    <ViewerModal
      v-if="viewer"
      :document-id="viewer.documentId"
      :title="viewer.title"
      :page="viewer.page"
      @close="viewer = null"
    />
  </div>
</template>
