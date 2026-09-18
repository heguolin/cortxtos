<script setup lang="ts">
import { onMounted, ref } from 'vue'

const emit = defineEmits<{ changed: [] }>()

interface RoleInfo {
  model: string
  baseUrl: string | null
}
interface ModelsPayload {
  roles: {
    primary: RoleInfo
    background: RoleInfo
    vision: RoleInfo | null
    embedding: RoleInfo & { dimensions: number }
  }
}

const models = ref<ModelsPayload | null>(null)
const current = ref('')
const next = ref('')
const confirmPw = ref('')
const msg = ref('')
const msgOk = ref(false)
const busy = ref(false)

const roleLabels: Record<string, string> = {
  primary: 'primary · 主力对话',
  background: 'background · 后台杂活',
  vision: 'vision · 视觉（M2）',
  embedding: 'embedding · 嵌入',
}

onMounted(async () => {
  const res = await fetch('/api/models')
  if (res.ok) models.value = (await res.json()) as ModelsPayload
})

async function changePassword() {
  msg.value = ''
  if (next.value !== confirmPw.value) {
    msgOk.value = false
    msg.value = '两次输入的新密码不一致'
    return
  }
  busy.value = true
  try {
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: current.value, newPassword: next.value }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    msgOk.value = res.ok
    msg.value = res.ok ? '密码已更新，请用新密码重新登录' : (data.error ?? `失败 (${res.status})`)
    if (res.ok) {
      current.value = ''
      next.value = ''
      confirmPw.value = ''
      // 密码轮换会踢掉所有会话，前端回到登录页
      setTimeout(() => emit('changed'), 800)
    }
  } catch {
    msgOk.value = false
    msg.value = '网络错误'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto max-w-2xl space-y-6">
    <div class="rounded-2xl border border-edge bg-panel p-8">
      <h2 class="text-lg font-bold">修改密码</h2>
      <form class="mt-4 space-y-4" @submit.prevent="changePassword">
        <div>
          <label class="mb-1 block text-xs text-ink-dim" for="cur">当前密码</label>
          <input
            id="cur"
            v-model="current"
            type="password"
            autocomplete="current-password"
            class="w-full rounded-lg border border-edge bg-void px-3 py-2 text-sm outline-none focus:border-neon"
          />
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-xs text-ink-dim" for="n1">新密码（≥8 位）</label>
            <input
              id="n1"
              v-model="next"
              type="password"
              autocomplete="new-password"
              class="w-full rounded-lg border border-edge bg-void px-3 py-2 text-sm outline-none focus:border-neon"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs text-ink-dim" for="n2">确认新密码</label>
            <input
              id="n2"
              v-model="confirmPw"
              type="password"
              autocomplete="new-password"
              class="w-full rounded-lg border border-edge bg-void px-3 py-2 text-sm outline-none focus:border-neon"
            />
          </div>
        </div>
        <p v-if="msg" :class="msgOk ? 'text-neon-soft' : 'text-red-400'" class="text-sm">
          {{ msg }}
        </p>
        <button
          type="submit"
          class="rounded-lg bg-neon/20 px-4 py-2 text-sm font-semibold text-neon transition hover:bg-neon/30 disabled:opacity-50"
          :disabled="busy || !current || !next"
        >
          {{ busy ? '提交中…' : '更新密码' }}
        </button>
      </form>
    </div>

    <div class="rounded-2xl border border-edge bg-panel p-8">
      <h2 class="text-lg font-bold">模型阵容</h2>
      <p class="mt-1 text-xs text-ink-dim">
        只读展示；编辑与手动换档在 M2 开放。API key 只存服务器 .env，永不回显。
      </p>
      <table v-if="models" class="mt-4 w-full text-sm">
        <tbody>
          <tr v-for="(role, key) in models.roles" :key="key" class="border-t border-edge/50">
            <td class="py-2 pr-4 text-ink-dim">{{ roleLabels[key] ?? key }}</td>
            <td class="py-2 font-mono text-neon-soft">
              {{ role ? role.model : '未配置（M2 接入）' }}
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else class="mt-4 text-sm text-ink-dim">加载中…</p>
    </div>
  </div>
</template>
