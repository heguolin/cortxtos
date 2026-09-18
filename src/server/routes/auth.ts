import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { authedToken, login, logout, SESSION_COOKIE } from '../auth/service.js'
import type { ServerDeps } from '../types.js'

/** 公开路由：login / logout / me（注册于鉴权守卫之前，故不被守卫拦截） */
export function publicAuthRouter(deps: ServerDeps): Hono {
  const r = new Hono()

  r.post('/api/auth/login', async (c) => {
    const gate = deps.rateLimiter.check()
    if (!gate.ok) {
      return c.json(
        { error: `尝试过于频繁，请 ${Math.max(1, Math.ceil(gate.retryAfterSec / 60))} 分钟后再试` },
        429,
      )
    }
    const body = await c.req
      .json<{ password?: string }>()
      .catch(() => ({}) as { password?: string })
    const result = await login(deps.db, (body.password ?? '').toString())
    if (!result.ok) {
      deps.rateLimiter.onFailure()
      return c.json({ error: result.error }, 401)
    }
    deps.rateLimiter.onSuccess()
    // Caddy 反代会带 x-forwarded-proto；只有真 HTTPS 才下 Secure Cookie
    const secure = c.req.header('x-forwarded-proto') === 'https'
    setCookie(c, SESSION_COOKIE, result.token, {
      httpOnly: true,
      secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: result.maxAgeSec,
    })
    return c.json({ ok: true })
  })

  r.post('/api/auth/logout', (c) => {
    logout(deps.db, getCookie(c, SESSION_COOKIE))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.json({ ok: true })
  })

  r.get('/api/auth/me', (c) => {
    if (!authedToken(deps.db, getCookie(c, SESSION_COOKIE))) {
      return c.json({ error: '未登录' }, 401)
    }
    return c.json({ ok: true })
  })

  return r
}
