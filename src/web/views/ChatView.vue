<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import ViewerModal from './ViewerModal.vue'

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
const error = ref('')
const viewer = ref<{ documentId: number; title: string; page: number | null } | null>(null)
const scrollBox = ref<HTMLElement | null>(null)

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

async function send() {
  const question = input.value.trim()
  if (!question || streaming.value) return
  error.value = ''
  if (!currentId.value) {
    await newSession()
    if (!currentId.value) return
  }
  const sessionId = currentId.value
  input.value = ''
  messages.value.push({ role: 'user', content: question, citations: [] })
  streaming.value = true
  streamText.value = ''
  streamCitations.value = []
  await scrollBottom()

  aborter = new AbortController()
  try {
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: question }),
      signal: aborter.signal,
    })
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
        } else if (eventName === 'delta') {
          streamText.value += payload.text as string
          void scrollBottom()
        } else if (eventName === 'error') {
          error.value = payload.message as string
        } else if (eventName === 'done') {
          const p = payload as { userMessage: ChatMessage; assistantMessage: ChatMessage }
          messages.value.push(p.userMessage, p.assistantMessage)
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

function onCitation(c: Citation) {
  viewer.value = { documentId: c.documentId, title: c.title, page: c.page }
}
</script>

<template>
  <div class="flex h-full gap-6">
    <!-- 会话列表 -->
    <aside class="flex w-56 shrink-0 flex-col rounded-2xl border border-edge bg-panel">
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
    <div class="flex min-w-0 flex-1 flex-col rounded-2xl border border-edge bg-panel">
      <div ref="scrollBox" class="flex-1 space-y-4 overflow-auto p-6">
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
          </div>
        </div>

        <!-- 流式中的回复 -->
        <div v-if="streaming" class="flex justify-start">
          <div class="max-w-[80%] rounded-2xl border border-neon/40 bg-void px-4 py-3 text-sm leading-7">
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-if="streamText" v-html="renderMd(streamText)"></div>
            <span v-else class="text-ink-dim">检索知识库中…</span>
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

      <div class="border-t border-edge p-4">
        <div class="flex items-end gap-3">
          <textarea
            v-model="input"
            rows="2"
            placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
            class="flex-1 resize-none rounded-xl border border-edge bg-void px-4 py-3 text-sm outline-none focus:border-neon"
            :disabled="streaming"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <button
            v-if="streaming"
            class="rounded-xl border border-red-400/50 px-5 py-3 text-sm text-red-300 transition hover:bg-red-400/10"
            @click="stopStream"
          >
            停止
          </button>
          <button
            v-else
            class="rounded-xl bg-neon/20 px-5 py-3 text-sm font-semibold text-neon transition hover:bg-neon/30 disabled:opacity-40"
            :disabled="!input.trim()"
            @click="send"
          >
            发送
          </button>
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
