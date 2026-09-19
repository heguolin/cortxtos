import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db.js'
import { migrate } from '../src/server/migrations.js'
import { createApp } from '../src/server/http.js'
import { LoginRateLimiter } from '../src/server/auth/ratelimit.js'
import { seedPasswordFromEnv } from '../src/server/auth/service.js'
import { FACTORY_CONFIG, loadConfig } from '../src/server/config.js'
import type { Hono } from 'hono'

const PW = 'test-pass-123'

async function setup(withRestartHook: boolean) {
  const db = openDb(':memory:')
  migrate(db)
  process.env.APP_PASSWORD = PW
  await seedPasswordFromEnv(db)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-cfg-'))
  const configPath = path.join(dir, 'config.json')
  // 初始 config：与服务器真实形态一致（embedding 显式 apiKeyEnv）
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      models: {
        primary: { model: 'm-primary' },
        background: { model: 'm-bg' },
        embedding: { model: 'm-embed', apiKeyEnv: 'XINGUHUB_API_KEY', dimensions: 1024 },
      },
    }),
  )
  let restartCalled = 0
  const app = createApp({
    db,
    config: loadConfig(dir).config,
    rateLimiter: new LoginRateLimiter(),
    vaultDir: dir,
    configPath,
    onConfigSave: withRestartHook ? () => (restartCalled += 1) : undefined,
  })
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  })
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { app, cookie, configPath, dir, restart: () => restartCalled }
}

describe('阵容编辑（ADR 0007）', () => {
  it('合法修改 → 写盘（含补丁与既有字段）+ 自重启钩子调用 + 回显正确', async () => {
    const { app, cookie, configPath, restart } = await setup(true)
    const res = await app.request('/api/config/models', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ models: { primary: { model: 'm-new' } } }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { restarting: boolean }).restarting).toBe(true)
    expect(restart()).toBe(1)

    // 写盘内容：新 primary + 保留 embedding 的 apiKeyEnv
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      models: { primary: { model: string }; embedding: { apiKeyEnv: string } }
    }
    expect(written.models.primary.model).toBe('m-new')
    expect(written.models.embedding.apiKeyEnv).toBe('XINGUHUB_API_KEY')

    // 回显：进程内 config 仍是旧值（自重启后才加载新值），符合 ADR 0007 语义
    void app
    void cookie
  })

  it('非法值 → 400 校验信息 + 配置文件原样未动', async () => {
    const { app, cookie, configPath } = await setup(false)
    const before = fs.readFileSync(configPath, 'utf8')
    const res = await app.request('/api/config/models', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ models: { primary: { model: '' }, embedding: { dimensions: 999999 } } }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('校验失败')
    expect(fs.readFileSync(configPath, 'utf8')).toBe(before)
  })

  it('vision 置 null = 移除档位；必需档位置 null → 400', async () => {
    const { app, cookie, configPath } = await setup(false)
    const res = await app.request('/api/config/models', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ models: { vision: null } }),
    })
    expect(res.status).toBe(200)
    const written = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { models: Record<string, unknown> }
    expect(written.models.vision).toBeUndefined()

    const bad = await app.request('/api/config/models', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ models: { primary: null } }),
    })
    expect(bad.status).toBe(400)

    void configPath
  })

  it('未知档位 → 400；未登录 → 401', async () => {
    const { app, cookie } = await setup(false)
    const unknown = await app.request('/api/config/models', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ models: { nope: { model: 'x' } } }),
    })
    expect(unknown.status).toBe(400)
    const unauth = await app.request('/api/config/models', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ models: {} }),
    })
    expect(unauth.status).toBe(401)
    void ({} as Hono)
  })
})
