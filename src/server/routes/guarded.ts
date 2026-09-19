import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import fs from 'node:fs'
import { deleteCookie, getCookie } from 'hono/cookie'
import { authedToken, changePassword, SESSION_COOKIE } from '../auth/service.js'
import { configSchema } from '../config.js'
import type { ServerDeps } from '../types.js'

export type ConfigAdminStatus = 400 | 503

export class ConfigAdminError extends Error {
  constructor(
    public readonly status: ConfigAdminStatus,
    message: string,
  ) {
    super(message)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 挂在 /api/* 的鉴权守卫（注册于公开路由之后） */
export function authGuard(deps: ServerDeps): MiddlewareHandler {
  return async (c, next) => {
    if (!authedToken(deps.db, getCookie(c, SESSION_COOKIE))) {
      return c.json({ error: '未登录' }, 401)
    }
    await next()
  }
}

/** 守卫之后的 API：改密 + 模型阵容只读展示（key 永不出服务器，DESIGN §8） */
export function guardedRouter(deps: ServerDeps): Hono {
  const r = new Hono()

  r.onError((err, c) => {
    if (err instanceof ConfigAdminError) return c.json({ error: err.message }, err.status)
    console.error('[guarded]', err)
    return c.json({ error: '内部错误' }, 500)
  })

  r.post('/api/auth/password', async (c) => {
    const body = await c.req
      .json<{ currentPassword?: string; newPassword?: string }>()
      .catch(() => ({}) as { currentPassword?: string; newPassword?: string })
    const result = await changePassword(deps.db, body.currentPassword ?? '', body.newPassword ?? '')
    if (!result.ok) return c.json({ error: result.error }, 400)
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  r.get('/api/models', (c) => {
    const m = deps.config.models
    return c.json({
      roles: {
        primary: { ...m.primary },
        background: { ...m.background },
        vision: m.vision ? { ...m.vision } : null,
        embedding: { ...m.embedding },
      },
    })
  })

  // 阵容编辑（ADR 0007）：dry-run 校验 → 写 config.json → 自重启钩子
  r.patch('/api/config/models', async (c) => {
    if (!deps.configPath) throw new ConfigAdminError(503, 'config 路径未配置（测试环境）')
    const body = await c.req.json().catch(() => null)
    const patch = isPlainObject(body) ? body['models'] : null
    if (!isPlainObject(patch)) throw new ConfigAdminError(400, '缺少 models 对象')

    // 在当前生效配置上应用补丁（vision: null = 移除该档）
    const merged = structuredClone(deps.config)
    for (const [role, value] of Object.entries(patch)) {
      if (!(role in merged.models)) throw new ConfigAdminError(400, `未知模型档位: ${role}`)
      if (value === null) {
        if (role === 'primary' || role === 'background' || role === 'embedding') {
          throw new ConfigAdminError(400, `${role} 为必需档位，不可移除`)
        }
        delete merged.models[role as 'vision']
        continue
      }
      if (!isPlainObject(value)) throw new ConfigAdminError(400, `${role} 配置必须是对象`)
      const modelsRec = merged.models as Record<string, Record<string, unknown>>
      modelsRec[role] = { ...modelsRec[role], ...value }
    }

    // dry-run：整份配置重新过 schema（ADR 0007：校验不过不写盘不重启）
    const parsed = configSchema.safeParse(merged)
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('；')
      throw new ConfigAdminError(400, `配置校验失败：${msg}`)
    }
    fs.writeFileSync(deps.configPath, JSON.stringify(parsed.data, null, 2))
    deps.onConfigSave?.()
    return c.json({ ok: true, restarting: true })
  })

  return r
}
