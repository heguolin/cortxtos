<script setup lang="ts">
import { onMounted, ref } from 'vue'

const emit = defineEmits<{ changed: [] }>()

interface RoleFields {
  model: string
  baseUrl?: string
  apiKeyEnv?: string
  dimensions?: number
}
type Role = 'primary' | 'background' | 'vision' | 'embedding'
type Roles = Record<Role, RoleFields | null>

const roles = ref<Roles | null>(null)
const saving = ref(false)
const restarting = ref(false)
const msg = ref('')
const msgOk = ref(false)

// 密码表单
const current = ref('')
const next = ref('')
const confirmPw = ref('')
const pwMsg = ref('')
const pwOk = ref(false)
const pwBusy = ref(false)

const roleLabels: Record<Role, string> = {
  primary: 'primary · 主力对话',
  background: 'background · 后台任务',
  vision: 'vision · 图片问答',
  embedding: 'embedding · 嵌入',
}

async function loadModels() {
  const res = await fetch('/api/models')
  if (res.ok) {
    const data = (await res.json()) as { roles: Roles }
    roles.value = data.roles
  }
}
onMounted(loadModels)

function emptyIfNull(v: string | undefined): string {
  return v ?? ''
}

async function saveModels() {
  if (!roles.value) return
  msg.value = ''
  saving.value = true
  try {
    const models: Record<string, unknown> = {}
    for (const role of ['primary', 'background', 'vision', 'embedding'] as Role[]) {
      const r = roles.value[role]
      if (!r) {
        models[role] = null
        continue
      }
      const entry: Record<string, unknown> = { model: r.model.trim() }
      if (r.baseUrl?.trim()) entry.baseUrl = r.baseUrl.trim()
      else entry.baseUrl = undefined
      if (r.apiKeyEnv?.trim()) entry.apiKeyEnv = r.apiKeyEnv.trim()
      if (role === 'embedding') entry.dimensions = r.dimensions ?? 1024
      models[role] = entry
    }
    // baseUrl undefined 会被 strictObject 视为未提供——序列化时剔除
    const payload = JSON.parse(JSON.stringify({ models }))
    const res = await fetch('/api/config/models', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) {
      msgOk.value = false
      msg.value = data.error ?? `保存失败 (${res.status})`
      return
    }
    // ADR 0007：daemon 即将自重启，轮询恢复
    restarting.value = true
    msgOk.value = true
    msg.value = '已保存，daemon 正在重启（约 5 秒）…'
    const deadline = Date.now() + 30_000
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000))
      try {
        const h = await fetch('/healthz')
        if (h.ok) {
          restarting.value = false
          msgOk.value = true
          msg.value = '✦ 已生效'
          await loadModels()
          return
        }
      } catch {
        /* 还没起来，继续轮询 */
      }
      if (Date.now() > deadline) {
        restarting.value = false
        msgOk.value = false
        msg.value = '重启超时——请上服务器查看 docker compose logs app，或手动修 data/config.json'
        return
      }
    }
  } catch (e) {
    msgOk.value = false
    msg.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function changePassword() {
  pwMsg.value = ''
  if (next.value !== confirmPw.value) {
    pwOk.value = false
    pwMsg.value = '两次输入的新密码不一致'
    return
  }
  pwBusy.value = true
  try {
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: current.value, newPassword: next.value }),
    })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    pwOk.value = res.ok
    pwMsg.value = res.ok ? '密码已更新，请用新密码重新登录' : (data.error ?? `失败 (${res.status})`)
    if (res.ok) {
      current.value = ''
      next.value = ''
      confirmPw.value = ''
      setTimeout(() => emit('changed'), 800)
    }
  } catch {
    pwOk.value = false
    pwMsg.value = '网络错误'
  } finally {
    pwBusy.value = false
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
        <p v-if="pwMsg" :class="pwOk ? 'text-neon-soft' : 'text-red-400'" class="text-sm">
          {{ pwMsg }}
        </p>
        <button
          type="submit"
          class="rounded-lg bg-neon/20 px-4 py-2 text-sm font-semibold text-neon transition hover:bg-neon/30 disabled:opacity-50"
          :disabled="pwBusy || !current || !next"
        >
          {{ pwBusy ? '提交中…' : '更新密码' }}
        </button>
      </form>
    </div>

    <div class="rounded-2xl border border-edge bg-panel p-8">
      <h2 class="text-lg font-bold">模型阵容</h2>
      <p class="mt-1 text-xs text-ink-dim">
        保存写入服务器 config.json 并自动重启生效（约 5 秒）。API key 本体只存 .env，这里只配"读哪个环境变量"。
      </p>

      <div v-if="roles" class="mt-4 space-y-4">
        <div v-for="roleKey in (Object.keys(roles) as Role[])" :key="roleKey" class="rounded-xl border border-edge/70 bg-void/40 p-4">
          <p class="mb-2.5 text-xs font-semibold text-neon-soft">{{ roleLabels[roleKey] }}</p>
          <div v-if="roles[roleKey]" class="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
            <div>
              <label class="mb-1 block text-[10px] text-ink-dim">模型名</label>
              <input
                v-model="(roles[roleKey] as RoleFields)!.model"
                class="w-full rounded-lg border border-edge bg-void px-2.5 py-1.5 font-mono text-xs outline-none focus:border-neon"
              />
            </div>
            <div>
              <label class="mb-1 block text-[10px] text-ink-dim">baseUrl（可选，默认全局）</label>
              <input
                v-model="(roles[roleKey] as RoleFields)!.baseUrl"
                class="w-full rounded-lg border border-edge bg-void px-2.5 py-1.5 font-mono text-xs outline-none focus:border-neon"
              />
            </div>
            <div>
              <label class="mb-1 block text-[10px] text-ink-dim">key 环境变量名</label>
              <input
                v-model="(roles[roleKey] as RoleFields)!.apiKeyEnv"
                class="w-full rounded-lg border border-edge bg-void px-2.5 py-1.5 font-mono text-xs outline-none focus:border-neon"
              />
            </div>
            <div v-if="roleKey === 'embedding'">
              <label class="mb-1 block text-[10px] text-ink-dim">维度（改动将全量重建索引）</label>
              <input
                v-model.number="(roles[roleKey] as RoleFields)!.dimensions"
                type="number"
                class="w-full rounded-lg border border-edge bg-void px-2.5 py-1.5 font-mono text-xs outline-none focus:border-neon"
              />
            </div>
          </div>
          <p v-else class="text-xs text-ink-dim">未配置（如需图片问答，填写后保存启用）</p>
        </div>
      </div>
      <p v-else class="mt-4 text-sm text-ink-dim">加载中…</p>

      <p v-if="msg" :class="msgOk ? 'text-neon-soft' : 'text-red-400'" class="mt-4 text-sm">
        {{ msg }}<span v-if="restarting" class="ml-1 animate-pulse">✦</span>
      </p>
      <button
        class="mt-4 rounded-lg bg-neon/20 px-4 py-2 text-sm font-semibold text-neon transition hover:bg-neon/30 disabled:opacity-50"
        :disabled="saving || restarting || !roles"
        @click="saveModels"
      >
        {{ restarting ? '重启中…' : saving ? '保存中…' : '保存并生效' }}
      </button>
    </div>
  </div>
</template>
