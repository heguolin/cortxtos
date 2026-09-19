import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db.js'
import { migrate } from '../src/server/migrations.js'
import { createApp } from '../src/server/http.js'
import { LoginRateLimiter } from '../src/server/auth/ratelimit.js'
import { seedPasswordFromEnv } from '../src/server/auth/service.js'
import { FACTORY_CONFIG } from '../src/server/config.js'
import type { Hono } from 'hono'

const PW = 'test-pass-123'

async function setup(): Promise<{ app: Hono }> {
  const db = openDb(':memory:')
  migrate(db)
  process.env.APP_PASSWORD = PW
  await seedPasswordFromEnv(db)
  const app = createApp({
    db,
    config: FACTORY_CONFIG,
    rateLimiter: new LoginRateLimiter(),
    vaultDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-vault-')),
  })
  return { app }
}

const loginReq = (app: Hono, pw: string) =>
  app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: pw }),
  })

function cookieOf(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

describe('认证与会话', () => {
  it('未登录访问受保护 API → 401', async () => {
    const { app } = await setup()
    const res = await app.request('/api/models')
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: '未登录' })
  })

  it('登录成功 → Set-Cookie + me 200；登出后失效', async () => {
    const { app } = await setup()
    const res = await loginReq(app, PW)
    expect(res.status).toBe(200)
    const cookie = cookieOf(res)
    expect(cookie).toContain('cortxt_session=')
    expect((await app.request('/api/auth/me', { headers: { cookie } })).status).toBe(200)
    await app.request('/api/auth/logout', { method: 'POST', headers: { cookie } })
    expect((await app.request('/api/auth/me', { headers: { cookie } })).status).toBe(401)
  })

  it('密码错误 5 次 → 第 6 次即使密码正确也限速 429', async () => {
    const { app } = await setup()
    for (let i = 0; i < 5; i++) {
      expect((await loginReq(app, 'wrong-pass')).status).toBe(401)
    }
    expect((await loginReq(app, PW)).status).toBe(429)
  })

  it('改密后：旧密码 401、新密码可登录、旧会话被踢', async () => {
    const { app } = await setup()
    const cookie = cookieOf(await loginReq(app, PW))
    const ch = await app.request('/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ currentPassword: PW, newPassword: 'new-pass-456' }),
    })
    expect(ch.status).toBe(200)
    expect((await loginReq(app, PW)).status).toBe(401)
    expect((await loginReq(app, 'new-pass-456')).status).toBe(200)
    expect((await app.request('/api/auth/me', { headers: { cookie } })).status).toBe(401)
  })

  it('改密拒绝弱密码（<8 位）', async () => {
    const { app } = await setup()
    const cookie = cookieOf(await loginReq(app, PW))
    const ch = await app.request('/api/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ currentPassword: PW, newPassword: 'short' }),
    })
    expect(ch.status).toBe(400)
  })

  it('DB 已有密码时，.env 改动被忽略（DB 为准）', async () => {
    const db = openDb(':memory:')
    migrate(db)
    process.env.APP_PASSWORD = PW
    expect(await seedPasswordFromEnv(db)).toBe('seeded')
    process.env.APP_PASSWORD = 'other-env-pass'
    expect(await seedPasswordFromEnv(db)).toBe('already')
    const app = createApp({
      db,
      config: FACTORY_CONFIG,
      rateLimiter: new LoginRateLimiter(),
      vaultDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-vault-')),
    })
    expect((await loginReq(app, 'other-env-pass')).status).toBe(401)
    expect((await loginReq(app, PW)).status).toBe(200)
  })

  it('模型阵容接口：模型名与 key 环境变量名可见，但 key 本体不泄露', async () => {
    const { app } = await setup()
    process.env.LLM_API_KEY = 'sk-secret-never-leak'
    const cookie = cookieOf(await loginReq(app, PW))
    const res = await app.request('/api/models', { headers: { cookie } })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('deepseek-v4-pro-0813')
    expect(text).toContain('apiKeyEnv') // 环境变量名可回显（非机密）
    expect(text).not.toContain('sk-secret-never-leak') // key 本体绝不出现
    delete process.env.LLM_API_KEY
  })
})
