<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

const props = defineProps<{
  documentId: number
  title: string
  page: number | null
}>()

const emit = defineEmits<{ close: [] }>()

const isPdf = computed(() => props.title.toLowerCase().endsWith('.pdf'))
const html = ref('')
const loading = ref(!isPdf.value)
const loadError = ref('')

const rawUrl = computed(() => `/api/documents/${props.documentId}/raw`)
const pdfUrl = computed(() => `${rawUrl.value}#page=${props.page ?? 1}`)

onMounted(async () => {
  if (isPdf.value) return
  try {
    const res = await fetch(rawUrl.value)
    if (!res.ok) throw new Error(`加载失败 (${res.status})`)
    const md = await res.text()
    html.value = DOMPurify.sanitize(marked.parse(md, { async: false }))
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6"
    @click.self="emit('close')"
  >
    <div class="flex h-full w-full max-w-4xl flex-col rounded-2xl border border-edge bg-panel">
      <div class="flex items-center justify-between border-b border-edge px-6 py-4">
        <div>
          <h3 class="font-bold">{{ title }}</h3>
          <p v-if="isPdf && page" class="text-xs text-ink-dim">跳转到第 {{ page }} 页</p>
        </div>
        <button class="text-ink-dim transition hover:text-ink" @click="emit('close')">关闭</button>
      </div>

      <div v-if="isPdf" class="flex-1">
        <iframe :src="pdfUrl" class="h-full w-full rounded-b-2xl" title="PDF 预览"></iframe>
      </div>
      <div v-else class="flex-1 overflow-auto px-8 py-6">
        <p v-if="loading" class="text-sm text-ink-dim">加载中…</p>
        <p v-else-if="loadError" class="text-sm text-red-400">{{ loadError }}</p>
        <!-- 单用户自托管场景，内容来自用户自己的知识库且已经 DOMPurify 清洗 -->
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div v-else class="prose-invert max-w-none text-sm leading-7 [&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-lg [&_h1]:font-bold [&_h2]:mb-3 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-bold [&_li]:ml-4 [&_li]:list-disc [&_p]:mb-3 [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-void [&_pre]:p-3" v-html="html"></div>
      </div>
    </div>
  </div>
</template>
