import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import { authedToken, changePassword, SESSION_COOKIE } from '../auth/service.js'
import type { ServerDeps } from '../types.js'

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
        primary: { model: m.primary.model, baseUrl: m.primary.baseUrl ?? null },
        background: { model: m.background.model, baseUrl: m.background.baseUrl ?? null },
        vision: m.vision
          ? { model: m.vision.model, baseUrl: m.vision.baseUrl ?? null }
          : null,
        embedding: {
          model: m.embedding.model,
          dimensions: m.embedding.dimensions,
          baseUrl: m.embedding.baseUrl ?? null,
        },
      },
    })
  })

  return r
}
