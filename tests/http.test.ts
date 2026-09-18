import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db.js'
import { migrate } from '../src/server/migrations.js'
import { createApp } from '../src/server/http.js'
import { LoginRateLimiter } from '../src/server/auth/ratelimit.js'
import { FACTORY_CONFIG } from '../src/server/config.js'
import type { Hono } from 'hono'

function makeApp(): Hono {
  const db = openDb(':memory:')
  migrate(db)
  return createApp({
    db,
    config: FACTORY_CONFIG,
    rateLimiter: new LoginRateLimiter(),
    vaultDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-vault-')),
  })
}

describe('http 骨架', () => {
  it('GET /healthz → 200 {ok:true}', async () => {
    const res = await makeApp().request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('未知 /api/* → JSON 401（被鉴权守卫拦截）', async () => {
    const res = await makeApp().request('/api/nope')
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: '未登录' })
  })

  it('未知非 API 路径 → SPA 兜底或构建提示', async () => {
    const res = await makeApp().request('/whatever')
    expect([200, 404]).toContain(res.status)
  })
})
