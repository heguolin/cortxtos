<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{ done: [] }>()

const password = ref('')
const error = ref('')
const busy = ref(false)

async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: password.value }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (res.ok) {
      emit('done')
    } else {
      error.value = data.error ?? `登录失败 (${res.status})`
    }
  } catch {
    error.value = '网络错误：daemon 不可达'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="grid h-full place-items-center">
    <form
      class="w-90 rounded-2xl border border-edge bg-panel p-8 shadow-[0_0_40px_rgba(242,107,255,0.08)]"
      @submit.prevent="submit"
    >
      <h1 class="text-xl font-bold tracking-wide">
        Cortxt<span class="text-neon">OS</span>
      </h1>
      <p class="mt-1 mb-6 text-xs text-ink-dim">自托管个人 AI 工作台 · 单用户</p>

      <label class="mb-2 block text-sm text-ink-dim" for="pw">登录密码</label>
      <input
        id="pw"
        v-model="password"
        type="password"
        autocomplete="current-password"
        autofocus
        class="w-full rounded-lg border border-edge bg-void px-3 py-2 text-sm text-ink outline-none focus:border-neon"
        :disabled="busy"
        @keydown.enter="submit"
      />

      <p v-if="error" class="mt-3 text-sm text-red-400">{{ error }}</p>

      <button
        type="submit"
        class="mt-6 w-full rounded-lg bg-neon/20 py-2 text-sm font-semibold text-neon transition hover:bg-neon/30 disabled:opacity-50"
        :disabled="busy || !password"
      >
        {{ busy ? '验证中…' : '进入工作台' }}
      </button>
    </form>
  </div>
</template>
