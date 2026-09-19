<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { fmtDbTime } from '../format'

interface DocumentRow {
  id: number
  title: string
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
// 快速捕获
const captureText = ref('')
const capturing = ref(false)
// 知识库组织：搜索 + 标签过滤 + 标签编辑
const searchQ = ref('')
const activeTag = ref('')
const editingTagsId = ref<number | null>(null)
const editingTagsValue = ref('')
const savingTags = ref(false)

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

async function refresh() {
  const params = new URLSearchParams()
  if (searchQ.value.trim()) params.set('q', searchQ.value.trim())
  if (activeTag.value) params.set('tag', activeTag.value)
  const qs = params.toString()
  const res = await fetch(`/api/documents${qs ? `?${qs}` : ''}`)
    if (res.ok) docs.value = ((await res.json()) as { documents: DocumentRow[] }).documents
}
onMounted(refresh)

let searchTimer: ReturnType<typeof setTimeout> | undefined
function onSearchInput() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => void refresh(), 300)
}

function setTag(tag: string) {
  activeTag.value = activeTag.value === tag ? '' : tag
  void refresh()
}

function startEditTags(doc: DocumentRow) {
  editingTagsId.value = doc.id
  editingTagsValue.value = tagsOf(doc).join(', ')
}

async function saveTags(doc: DocumentRow) {
  savingTags.value = true
  try {
    const tags = editingTagsValue.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean)
    const res = await fetch(`/api/documents/${doc.id}/tags`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags }),
    })
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) throw new Error(body.error ?? `保存失败 (${res.status})`)
    editingTagsId.value = null
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

// 在线编辑
const editing = ref<DocumentRow | null>(null)
const editContent = ref('')
const saving = ref(false)

const statusClass: Record<string, string> = {
  queued: 'bg-white/10 text-ink-dim',
  indexing: 'bg-neon/20 text-neon animate-pulse',
  ready: 'bg-emerald-500/15 text-emerald-300',
  failed: 'bg-red-500/15 text-red-300',
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

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
    const body = (await res.json().catch(() => ({}))) as { error?: string; duplicate?: boolean }
    if (!res.ok) throw new Error(body.error ?? `入库失败 (${res.status})`)
    noticeOk.value = true
    notice.value = body.duplicate ? '内容已存在（幂等）' : '已入库，正在自动索引'
    captureText.value = ''
    await refresh()
  } catch (e) {
    noticeOk.value = false
    notice.value = e instanceof Error ? e.message : String(e)
  } finally {
    capturing.value = false
  }
}

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
        document?: DocumentRow
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

async function remove(doc: DocumentRow) {
  if (!confirm(`删除「${doc.title}」？文件与索引将一并删除。`)) return
  await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' })
  await refresh()
}

async function openEditor(doc: DocumentRow) {
  const res = await fetch(`/api/documents/${doc.id}/raw`)
  if (!res.ok) return
  editContent.value = await res.text()
  editing.value = doc
}

async function saveEdit() {
  if (!editing.value) return
  saving.value = true
  try {
    const res = await fetch(`/api/documents/${editing.value.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: editContent.value }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (res.ok) {
      editing.value = null
      noticeOk.value = true
      notice.value = '已保存，等待重新索引'
      await refresh()
    } else {
      noticeOk.value = false
      notice.value = data.error ?? `保存失败 (${res.status})`
    }
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-4xl space-y-6">
    <!-- 快速捕获条 -->
    <div class="flex items-end gap-2.5 rounded-2xl border border-edge bg-panel p-4">
      <textarea
        v-model="captureText"
        rows="1"
        placeholder="快速捕获：贴一段文字（首行当标题）或贴网页链接（自动抓正文入库）…"
        class="min-w-0 flex-1 resize-none rounded-xl border border-edge bg-void px-3.5 py-2.5 text-sm outline-none focus:border-neon"
        @keydown.enter.exact.prevent="capture"
      ></textarea>
      <button
        class="shrink-0 rounded-xl bg-neon/20 px-4 py-2.5 text-sm font-semibold text-neon transition hover:bg-neon/30 disabled:opacity-40"
        :disabled="capturing || !captureText.trim()"
        @click="capture"
      >
        {{ capturing ? '入库中…' : '保存入库' }}
      </button>
    </div>

    <div
      class="rounded-2xl border-2 border-dashed p-8 text-center transition"
      :class="dragging ? 'border-neon bg-neon/10' : 'border-edge bg-panel'"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <p class="text-sm text-ink">拖拽文件到这里，或</p>
      <label
        class="mt-3 inline-block cursor-pointer rounded-lg bg-neon/20 px-4 py-2 text-sm font-semibold text-neon transition hover:bg-neon/30"
      >
        {{ uploading ? '上传中…' : '选择文件' }}
        <input
          type="file"
          multiple
          accept=".md,.txt,.pdf"
          class="hidden"
          :disabled="uploading"
          @change="onFilePick"
        />
      </label>
      <p class="mt-3 text-xs text-ink-dim">支持 .md / .txt / .pdf，单文件 ≤ 50MB；重复内容自动幂等</p>
      <p v-if="notice" :class="noticeOk ? 'text-neon-soft' : 'text-red-400'" class="mt-3 text-sm">
        {{ notice }}
      </p>
    </div>

    <!-- 搜索 + 标签过滤 -->
    <div class="flex flex-wrap items-center gap-2 rounded-2xl border border-edge bg-panel p-3.5">
      <input
        v-model="searchQ"
        placeholder="🔍 搜文档标题…"
        class="w-52 rounded-xl border border-edge bg-void px-3.5 py-2 text-sm outline-none focus:border-neon"
        @input="onSearchInput"
      />
      <div class="flex flex-wrap gap-1.5">
        <button
          class="rounded-full px-2.5 py-1 text-xs transition"
          :class="!activeTag ? 'bg-neon/15 text-neon' : 'bg-white/6 text-ink-dim hover:text-ink'"
          @click="setTag('')"
        >
          全部
        </button>
        <button
          v-for="tag in allTags"
          :key="tag"
          class="rounded-full px-2.5 py-1 text-xs transition"
          :class="activeTag === tag ? 'bg-neon/15 text-neon' : 'bg-white/6 text-ink-dim hover:text-ink'"
          @click="setTag(tag)"
        >
          #{{ tag }}
        </button>
      </div>
    </div>

    <div class="overflow-x-auto rounded-2xl border border-edge bg-panel">
      <table class="w-full min-w-[640px] text-sm">
        <thead>
          <tr class="border-b border-edge text-left text-xs text-ink-dim">
            <th class="px-5 py-3">文档</th>
            <th class="px-3 py-3">标签</th>
            <th class="px-3 py-3">大小</th>
            <th class="px-3 py-3">状态</th>
            <th class="px-3 py-3">更新时间</th>
            <th class="px-5 py-3 text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="docs.length === 0">
            <td colspan="6" class="px-5 py-8 text-center text-ink-dim">
              {{ searchQ || activeTag ? '没有匹配的文档' : '知识库还是空的——先扔几个文档进来' }}
            </td>
          </tr>
          <tr v-for="doc in docs" :key="doc.id" class="border-b border-edge/40 last:border-0">
            <td class="px-5 py-3">
              <a
                :href="`/api/documents/${doc.id}/raw`"
                target="_blank"
                class="text-ink transition hover:text-neon"
                :title="doc.title"
                >{{ doc.title }}</a
              >
              <p v-if="doc.error" class="mt-1 text-xs text-red-400">{{ doc.error }}</p>
            </td>
            <td class="px-3 py-3">
              <template v-if="editingTagsId === doc.id">
                <div class="flex items-center gap-1.5">
                  <input
                    v-model="editingTagsValue"
                    placeholder="逗号分隔，如: agent, 面试"
                    class="w-44 rounded-lg border border-edge bg-void px-2 py-1 text-xs outline-none focus:border-neon"
                    @keydown.enter.prevent="saveTags(doc)"
                  />
                  <button class="rounded-lg bg-neon/20 px-2 py-1 text-xs text-neon" :disabled="savingTags" @click="saveTags(doc)">
                    存
                  </button>
                  <button class="text-xs text-ink-dim" @click="editingTagsId = null">取消</button>
                </div>
              </template>
              <template v-else>
                <button
                  class="flex flex-wrap items-center gap-1 text-left"
                  title="点击编辑标签"
                  @click="startEditTags(doc)"
                >
                  <span
                    v-for="tag in tagsOf(doc)"
                    :key="tag"
                    class="rounded-full bg-neon-soft/12 px-2 py-0.5 text-[10.5px] text-neon-soft"
                    >#{{ tag }}</span
                  >
                  <span v-if="tagsOf(doc).length === 0" class="text-xs text-ink-dim/60">＋标签</span>
                </button>
              </template>
            </td>
            <td class="px-3 py-3 text-ink-dim">{{ fmtSize(doc.size) }}</td>
            <td class="px-3 py-3">
              <span class="rounded-full px-2 py-0.5 text-xs" :class="statusClass[doc.status]">
                {{ doc.status }}
              </span>
            </td>
            <td class="px-3 py-3 text-xs text-ink-dim">{{ fmtDbTime(doc.updated_at) }}</td>
            <td class="px-5 py-3 text-right">
              <button
                v-if="doc.title.endsWith('.md')"
                class="mr-3 text-xs text-ink-dim transition hover:text-neon"
                @click="openEditor(doc)"
              >
                编辑
              </button>
              <button
                class="text-xs text-ink-dim transition hover:text-red-400"
                @click="remove(doc)"
              >
                删除
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 在线 Markdown 编辑 -->
    <div
      v-if="editing"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 md:p-6"
      @click.self="editing = null"
    >
      <div class="flex h-full w-full max-w-3xl flex-col rounded-2xl border border-edge bg-panel p-6">
        <div class="flex items-center justify-between">
          <h3 class="font-bold">编辑：{{ editing.title }}</h3>
          <button class="text-ink-dim transition hover:text-ink" @click="editing = null">关闭</button>
        </div>
        <textarea
          v-model="editContent"
          class="mt-4 flex-1 resize-none rounded-lg border border-edge bg-void p-4 font-mono text-sm outline-none focus:border-neon"
          spellcheck="false"
        ></textarea>
        <div class="mt-4 flex justify-end gap-3">
          <button class="rounded-lg px-4 py-2 text-sm text-ink-dim hover:text-ink" @click="editing = null">
            取消
          </button>
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
