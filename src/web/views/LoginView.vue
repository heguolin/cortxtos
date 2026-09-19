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
    if (res.ok) {
      // 登录成功后回验一次会话，防止 Cookie 未存储导致的"假登录"卡壳
      const me = await fetch('/api/auth/me')
      if (me.ok) {
        emit('done')
      } else {
        error.value = '登录成功但浏览器未保存会话 Cookie，请允许 Cookie 后重试'
      }
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
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
  <div class="grid h-full place-items-center px-4">
    <form
      class="w-full max-w-sm rounded-2xl border border-edge bg-panel p-6 shadow-[0_0_40px_rgba(242,107,255,0.08)] sm:p-8"
      @submit.prevent="submit"
    >
      <div class="mb-4 select-none">
        <svg viewBox="0 0 64 64" class="mx-auto h-16 w-16 drop-shadow-[0_0_18px_rgba(242,107,255,0.4)]">
          <path
            d="M32 8c-12 0-20 9-20 21v21c0 3 3 4 5 2l4-4 5 5c2 2 4 2 6 0l5-5 4 4c2 2 5 1 5-2V29c0-12-8-21-20-21z"
            fill="rgba(242,107,255,.18)" stroke="#f26bff" stroke-width="2"
          />
          <circle cx="25" cy="30" r="2.6" fill="#f26bff" />
          <circle cx="39" cy="30" r="2.6" fill="#f26bff" />
          <path d="M27 38q5 4 10 0" stroke="#f26bff" stroke-width="2" fill="none" stroke-linecap="round" />
        </svg>
      </div>
      <h1 class="text-2xl font-bold tracking-wide">
        Cortxt<span class="text-neon">OS</span>
      </h1>
      <p class="mb-6 mt-2 text-xs text-ink-dim">你的大脑皮层，正在待机 ✦</p>

      <label class="mb-2 block text-sm text-ink-dim" for="pw">登录密码</label>
      <input
        id="pw"
        v-model="password"
        type="password"
        autocomplete="current-password"
        autocapitalize="off"
        autocorrect="off"
        spellcheck="false"
        enterkeyhint="go"
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
