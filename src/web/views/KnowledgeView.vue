<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { renderMarkdown } from '../markdown'
import { fmtDbTime } from '../format'

interface DocumentRow {
  id: number
  title: string
  source: string
  mime: string
  size: number
  status: 'queued' | 'indexing' | 'ready' | 'failed'
  error: string | null
  tags: string | string[]
  updated_at: string
}

const docs = ref<DocumentRow[]>([])
const dragging = ref(false)
const uploading = ref(false)
const notice = ref('')
const noticeOk = ref(false)
// 快速捕获（文本 / 裸 URL 均走此入口）
const captureText = ref('')
const capturing = ref(false)
// 知识库组织：搜索 + 标签过滤
const searchQ = ref('')
const activeTag = ref('')
// 主-详：选中文档 + 详情内容
const selectedId = ref<number | null>(null)
const detailHtml = ref('')
const detailLoading = ref(false)
// 标签行内编辑（详情头部）
const editingTags = ref(false)
const editingTagsValue = ref('')
const savingTags = ref(false)
// 编辑弹窗
const editorOpen = ref(false)
const editorContent = ref('')
const saving = ref(false)

const selected = computed(() => docs.value.find((d) => d.id === selectedId.value) ?? null)
const isPdf = computed(() => selected.value?.mime === 'application/pdf')
const isMd = computed(() => selected.value?.mime === 'text/markdown')

function tagsOf(doc: DocumentRow): string[] {
  if (Array.isArray(doc.tags)) return doc.tags
  try {
    return JSON.parse(doc.tags || '[]') as string[]
  } catch {
    return []
  }
}

const allTags = computed(() => {
  const set = new Set<string>()
  for (const d of docs.value) for (const t of tagsOf(d)) set.add(t)
  return [...set].sort()
})

const statusClass: Record<string, string> = {
  queued: 'bg-white/10 text-ink-dim',
  indexing: 'bg-neon/20 text-neon animate-pulse',
  ready: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
}
const statusDot: Record<string, string> = {
  queued: 'bg-ink-dim',
  indexing: 'bg-neon shadow-[0_0_6px_rgba(242,107,255,0.8)]',
  ready: 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.7)]',
  failed: 'bg-red-400',
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

async function refresh(keepSelection = true) {
  const params = new URLSearchParams()
  if (searchQ.value.trim()) params.set('q', searchQ.value.trim())
  if (activeTag.value) params.set('tag', activeTag.value)
  const qs = params.toString()
  const res = await fetch(`/api/documents${qs ? `?${qs}` : ''}`)
  if (res.ok) docs.value = ((await res.json()) as { documents: DocumentRow[] }).documents
  if (!keepSelection) selectedId.value = null
}

let searchTimer: ReturnType<typeof setTimeout> | undefined
function onSearchInput() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void refresh(), 300)
}

function setTag(tag: string) {
  activeTag.value = activeTag.value === tag ? '' : tag
  void refresh()
}

onMounted(() => void refresh())

// ===== 详情 =====
async function select(id: number) {
  selectedId.value = id
  detailHtml.value = ''
  detailLoading.value = false
  const doc = selected.value
  if (!doc) return
  if (isPdf.value) return // iframe 直接引 raw
  detailLoading.value = true
  try {
    const res = await fetch(`/api/documents/${id}/raw`)
    if (!res.ok) throw new Error(`加载失败 (${res.status})`)
    detailHtml.value = renderMarkdown(await res.text())
  } catch (e) {
    detailHtml.value = ''
    noticeOk.value = false
    notice.value = e instanceof Error ? e.message : String(e)
  } finally {
    detailLoading.value = false
  }
}
function closeDetail() {
  selectedId.value = null
}

// ===== 上传 =====
async function upload(files: FileList | File[]) {
  uploading.value = true
  notice.value = ''
  try {
    for (const f of Array.from(files)) {
      const fd = new FormData()
      fd.append('file', f)
      const res = await fetch('/api/documents', { method: 'POST', body: fd })
      const data = (await res.json().catch(() => ({}))) as {
        duplicate?: boolean
        error?: string
      }
      if (!res.ok) {
        noticeOk.value = false
        notice.value = `「${f.name}」上传失败：${data.error ?? res.status}`
        break
      }
      if (data.duplicate) {
        noticeOk.value = true
        notice.value = `「${f.name}」内容已存在（sha256 幂等），未重复入库`
      }
    }
    await refresh()
  } catch {
    noticeOk.value = false
    notice.value = '网络错误：上传失败'
  } finally {
    uploading.value = false
  }
}
function onDrop(e: DragEvent) {
  dragging.value = false
  if (e.dataTransfer?.files.length) void upload(e.dataTransfer.files)
}
function onFilePick(e: Event) {
  const input = e.target as HTMLInputElement
  if (input.files?.length) void upload(input.files)
  input.value = ''
}

// ===== 快速捕获 =====
async function capture() {
  const text = captureText.value.trim()
  if (!text) return
  capturing.value = true
  notice.value = ''
  try {
    const res = await fetch('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    const body = (await res.json().catch(() => ({}))) as {
      error?: string
      duplicate?: boolean
      captured?: boolean
      overwritten?: boolean
    }
    if (!res.ok) throw new Error(body.error ?? `入库失败 (${res.status})`)
    noticeOk.value = true
    notice.value = body.overwritten
      ? '已覆盖旧版（同 URL），正在重新索引'
      : body.duplicate
        ? '内容已存在（幂等），未重复入库'
        : body.captured
          ? '网页已入库，正在自动索引 ✦'
          : '已入库，正在自动索引 ✦'
    captureText.value = ''
    await refresh()
  } catch (e) {
    noticeOk.value = false
    notice.value = e instanceof Error ? e.message : String(e)
  } finally {
    capturing.value = false
  }
}

// ===== 详情头操作 =====
async function openEditor() {
  if (!selected.value) return
  const res = await fetch(`/api/documents/${selected.value.id}/raw`)
  if (!res.ok) return
  editorContent.value = await res.text()
  editorOpen.value = true
}
async function saveEdit() {
  if (!selected.value) return
  saving.value = true
  try {
    const res = await fetch(`/api/documents/${selected.value.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: editorContent.value }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (res.ok) {
      editorOpen.value = false
      noticeOk.value = true
      notice.value = '已保存，等待重新索引'
      await refresh()
      await select(selected.value.id)
    } else {
      noticeOk.value = false
      notice.value = data.error ?? `保存失败 (${res.status})`
    }
  } finally {
    saving.value = false
  }
}

function startEditTags() {
  if (!selected.value) return
  editingTags.value = true
  editingTagsValue.value = tagsOf(selected.value).join(', ')
}
async function saveTags() {
  if (!selected.value) return
  savingTags.value = true
  try {
    const tags = editingTagsValue.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
    const res = await fetch(`/api/documents/${selected.value.id}/tags`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags }),
    })
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new Error(body.error ?? `保存失败 (${res.status})`)
    editingTags.value = false
    noticeOk.value = true
    notice.value = '标签已更新'
    await refresh()
  } catch (e) {
    noticeOk.value = false
    notice.value = e instanceof Error ? e.message : String(e)
  } finally {
    savingTags.value = false
  }
}

async function removeSelected() {
  if (!selected.value) return
  if (!confirm(`删除「${selected.value.title}」？文件与索引将一并删除。`)) return
  await fetch(`/api/documents/${selected.value.id}`, { method: 'DELETE' })
  closeDetail()
  noticeOk.value = true
  notice.value = '已删除'
  await refresh()
}
</script>

<template>
  <!-- 整页拖拽上传（拖到列表/详情任意处均可） -->
  <div
    class="flex h-full gap-4"
    :class="{ 'm-detail-on': selectedId }"
    @dragover.prevent="dragging = true"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <!-- 左：文档窄列 -->
    <aside
      class="w-72 shrink-0 flex-col rounded-2xl border bg-panel/80"
      :class="[dragging ? 'border-neon' : 'border-edge', selectedId ? 'hidden md:flex' : 'flex']"
    >
      <!-- 快速捕获（文本 / 裸 URL） -->
      <div class="border-b border-edge p-3">
        <div class="flex items-center gap-1.5">
          <input
            v-model="captureText"
            placeholder="贴文字 / 网页链接…"
            class="min-w-0 flex-1 rounded-lg border border-edge bg-void px-2.5 py-1.5 text-xs outline-none focus:border-neon"
            :disabled="capturing"
            @keydown.enter="capture"
          />
          <button
            class="shrink-0 rounded-lg bg-neon/20 px-2.5 py-1.5 text-xs font-semibold text-neon transition hover:bg-neon/30 disabled:opacity-40"
            :disabled="capturing || !captureText.trim()"
            @click="capture"
          >
            {{ capturing ? '入库中…' : '入库' }}
          </button>
        </div>
        <label
          class="mt-2 flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-dashed px-2 py-1.5 text-xs transition"
          :class="dragging ? 'border-neon text-neon' : 'border-edge text-ink-dim hover:border-neon hover:text-neon'"
        >
          ⬆ 拖拽或点击上传（md / txt / pdf ≤ 50MB）
          <input type="file" multiple accept=".md,.txt,.pdf" class="hidden" :disabled="uploading" @change="onFilePick" />
        </label>
      </div>

      <!-- 搜索 + 标签 -->
      <div class="space-y-2 border-b border-edge p-3">
        <input
          v-model="searchQ"
          placeholder="🔍 搜文档标题…"
          class="w-full rounded-lg border border-edge bg-void px-3 py-1.5 text-xs outline-none focus:border-neon"
          @input="onSearchInput"
        />
        <div class="flex flex-wrap gap-1.5">
          <button
            class="rounded-full px-2 py-0.5 text-[11px] transition"
            :class="!activeTag ? 'bg-neon/15 text-neon' : 'bg-white/6 text-ink-dim hover:text-ink'"
            @click="setTag('')"
          >
            全部
          </button>
          <button
            v-for="tag in allTags"
            :key="tag"
            class="rounded-full px-2 py-0.5 text-[11px] transition"
            :class="activeTag === tag ? 'bg-neon/15 text-neon' : 'bg-white/6 text-ink-dim hover:text-ink'"
            @click="setTag(tag)"
          >
            #{{ tag }}
          </button>
        </div>
      </div>

      <!-- 文档卡片列表 -->
      <div class="flex-1 space-y-1 overflow-auto p-2">
        <p v-if="docs.length === 0" class="px-3 py-6 text-center text-xs text-ink-dim">
          {{ searchQ || activeTag ? '没有匹配的文档' : '知识库还是空的——拖文件或贴链接进来' }}
        </p>
        <button
          v-for="doc in docs"
          :key="doc.id"
          class="w-full rounded-xl border px-3 py-2.5 text-left transition"
          :class="selectedId === doc.id ? 'border-neon/35 bg-neon/12' : 'border-transparent hover:bg-neon/5'"
          @click="select(doc.id)"
        >
          <p class="truncate text-[13px] font-semibold" :title="doc.title">{{ doc.title }}</p>
          <div class="mt-1.5 flex items-center gap-1.5">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="statusDot[doc.status]" :title="doc.status"></span>
            <span class="min-w-0 flex-1 truncate text-[10px] text-neon-soft">
              {{ tagsOf(doc).map((t) => '#' + t).join(' ') || '\u00A0' }}
            </span>
            <span class="text-[10px] text-ink-dim">{{ fmtSize(doc.size) }}</span>
          </div>
        </button>
      </div>

      <p v-if="notice" :class="noticeOk ? 'text-neon-soft' : 'text-red-400'" class="border-t border-edge px-3 py-2 text-[11px]">
        {{ notice }}
      </p>
    </aside>

    <!-- 右：详情面板 -->
    <section
      class="min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border bg-panel/80"
      :class="selectedId ? 'flex' : 'hidden md:flex'"
    >
      <!-- 占位 -->
      <div v-if="!selected" class="grid flex-1 place-items-center">
        <div class="text-center">
          <p class="text-4xl">📄</p>
          <p class="mt-3 text-sm text-ink-dim">从左侧选择文档阅读 ✦</p>
          <p class="mt-1 text-xs text-ink-dim/60">Markdown 渲染 · PDF 原生预览 · 操作都在头顶</p>
        </div>
      </div>

      <template v-else>
        <!-- 头部 -->
        <div class="border-b border-edge px-5 py-3.5">
          <button
            class="mb-1 flex items-center gap-1 text-xs text-neon md:hidden"
            @click="closeDetail"
          >
            ← 返回列表
          </button>
          <h2 class="truncate text-base font-bold" :title="selected.title">{{ selected.title }}</h2>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-ink-dim">
            <span class="rounded-full px-2 py-0.5 text-[10px]" :class="statusClass[selected.status]">{{ selected.status }}</span>
            <span>{{ fmtSize(selected.size) }}</span>
            <span>·</span>
            <span>{{ fmtDbTime(selected.updated_at) }}</span>
            <span
              v-for="tag in tagsOf(selected)"
              :key="tag"
              class="rounded-full bg-neon-soft/12 px-1.5 py-0.5 text-[10px] text-neon-soft"
            >#{{ tag }}</span>
          </div>
          <p v-if="selected.error" class="mt-1.5 text-xs text-red-400">{{ selected.error }}</p>
          <div class="mt-2.5 flex flex-wrap items-center gap-2">
            <template v-if="editingTags">
              <input
                v-model="editingTagsValue"
                placeholder="逗号分隔，如: agent, 面试"
                class="w-52 rounded-lg border border-edge bg-void px-2.5 py-1 text-xs outline-none focus:border-neon"
                @keydown.enter.prevent="saveTags"
              />
              <button class="rounded-lg bg-neon/20 px-2.5 py-1 text-xs text-neon" :disabled="savingTags" @click="saveTags">保存</button>
              <button class="text-xs text-ink-dim" @click="editingTags = false">取消</button>
            </template>
            <template v-else>
              <button v-if="isMd" class="rounded-lg bg-neon/20 px-3 py-1.5 text-xs font-semibold text-neon transition hover:bg-neon/30" @click="openEditor">
                ✏️ 编辑
              </button>
              <button class="rounded-lg border border-edge px-3 py-1.5 text-xs text-ink-dim transition hover:text-ink" @click="startEditTags">
                🏷 标签
              </button>
              <a
                :href="`/api/documents/${selected.id}/raw`"
                target="_blank"
                class="rounded-lg border border-edge px-3 py-1.5 text-xs text-ink-dim transition hover:text-ink"
              >
                ↗ 新窗口打开
              </a>
              <button class="ml-auto text-xs text-ink-dim transition hover:text-red-400" @click="removeSelected">删除</button>
            </template>
          </div>
        </div>

        <!-- 正文 -->
        <div class="flex-1 overflow-auto">
          <div v-if="isPdf" class="h-full">
            <iframe
              :src="`/api/documents/${selected.id}/raw#page=1`"
              class="h-full w-full"
              :title="selected.title"
            ></iframe>
          </div>
          <div v-else class="px-6 py-5 md:px-8">
            <p v-if="detailLoading" class="text-sm text-ink-dim">加载中…</p>
            <!-- 单用户自托管场景，内容来自用户自己的知识库且已经 renderMarkdown 消毒 -->
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div
              v-else-if="detailHtml"
              class="prose-invert max-w-none text-sm leading-7 [&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-base [&_h2]:font-bold [&_h3]:mt-4 [&_h3]:font-bold [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-3 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-void [&_pre]:p-3 [&_pre]:text-xs [&_blockquote]:border-l-2 [&_blockquote]:border-neon/50 [&_blockquote]:pl-3 [&_blockquote]:text-ink-dim"
              v-html="detailHtml"
            ></div>
            <p v-else class="mt-10 text-center text-sm text-ink-dim">此文档暂无内容 ✦</p>
          </div>
        </div>
      </template>
    </section>

    <!-- 在线 Markdown 编辑（保留弹窗形态） -->
    <div
      v-if="editorOpen"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 md:p-6"
      @click.self="editorOpen = false"
    >
      <div class="flex h-full max-h-[85vh] w-full max-w-3xl flex-col rounded-2xl border border-edge bg-panel p-6">
        <div class="flex items-center justify-between">
          <h3 class="font-bold">编辑：{{ selected?.title }}</h3>
          <button class="text-ink-dim hover:text-ink" @click="editorOpen = false">关闭</button>
        </div>
        <textarea
          v-model="editorContent"
          class="mt-4 flex-1 resize-none rounded-lg border border-edge bg-void p-4 font-mono text-sm outline-none focus:border-neon"
          spellcheck="false"
        ></textarea>
        <div class="mt-4 flex justify-end gap-3">
          <button class="rounded-lg px-4 py-2 text-sm text-ink-dim hover:text-ink" @click="editorOpen = false">取消</button>
          <button
            class="rounded-lg bg-neon/20 px-4 py-2 text-sm font-semibold text-neon hover:bg-neon/30 disabled:opacity-50"
            :disabled="saving"
            @click="saveEdit"
          >
            {{ saving ? '保存中…' : '保存（重建索引）' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
