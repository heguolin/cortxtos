import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, ensureVecTable } from '../src/server/db.js'
import { migrate } from '../src/server/migrations.js'
import { createApp } from '../src/server/http.js'
import { LoginRateLimiter } from '../src/server/auth/ratelimit.js'
import { seedPasswordFromEnv } from '../src/server/auth/service.js'
import { recordUsage } from '../src/server/llm/usage.js'
import { uploadDocument, setTags, normalizeTags, KbError } from '../src/server/kb/service.js'
import { FACTORY_CONFIG } from '../src/server/config.js'
import type { Hono } from 'hono'

const PW = 'test-pass-123'

async function setup() {
  const db = openDb(':memory:')
  migrate(db)
  ensureVecTable(db, 16)
  process.env.APP_PASSWORD = PW
  await seedPasswordFromEnv(db)
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-v23-'))
  const app = createApp({
    db,
    config: FACTORY_CONFIG,
    rateLimiter: new LoginRateLimiter(),
    vaultDir,
  })
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  })
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { app, db, cookie, vaultDir }
}

describe('迁移 0002 document_tags', () => {
  it('tags 列存在且默认 []，旧迁移记录不重跑', () => {
    const db = openDb(':memory:')
    migrate(db)
    const row = db.prepare('SELECT tags FROM documents LIMIT 0').get() // 列存在性
    expect(row).toBeUndefined()
    const applied = (db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n
    expect(applied).toBe(3)
  })
})

describe('标签 API', () => {
  it('打标签 → 列表带 tags → 按标签筛选 → 按标题搜索', async () => {
    const { app, db, cookie, vaultDir } = await setup()
    const enc = new TextEncoder()
    uploadDocument(db, vaultDir, { name: 'a.md', bytes: enc.encode('Apple document') })
    uploadDocument(db, vaultDir, { name: 'b.md', bytes: enc.encode('Banana document') })
    setTags(db, 1, ['水果', '面试'])

    const listText = await (await app.request('/api/documents', { headers: { cookie } })).text()
    const { documents } = JSON.parse(listText) as { documents: Array<{ title: string; tags: string[] }> }
    expect(documents.find((d) => d.title === 'a.md')!.tags).toEqual(['水果', '面试'])
    expect(documents.find((d) => d.title === 'b.md')!.tags).toEqual([])

    const byTagText = await (
      await app.request(`/api/documents?tag=${encodeURIComponent('水果')}`, { headers: { cookie } })
    ).text()
    const byTag = JSON.parse(byTagText) as { documents?: Array<{ title: string }> }
    expect((byTag.documents ?? []).map((d) => d.title)).toEqual(['a.md'])

    const byQText = await (await app.request('/api/documents?q=b', { headers: { cookie } })).text()
    const byQ = JSON.parse(byQText) as { documents?: Array<{ title: string }> }
    expect((byQ.documents ?? []).map((d) => d.title)).toEqual(['b.md'])

    const route = await app.request('/api/documents/2/tags', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ tags: ['水果', '水果', '  ', '进口'] }),
    })
    const { document } = (await route.json()) as { document: { tags: string[] } }
    expect(document.tags).toEqual(['水果', '进口']) // 去重去空
  })

  it('normalizeTags 校验：非数组/超 10 个 → 400', async () => {
    expect(() => normalizeTags('x')).toThrow(KbError)
    expect(() => normalizeTags(Array.from({ length: 11 }, (_, i) => `t${i}`))).toThrow(/最多 10 个/)
    expect(normalizeTags([' a ', '', 'a'])).toEqual(['a'])
  })
})

describe('用量聚合 API', () => {
  it('summary/daily/models/records 齐全且按天数过滤', async () => {
    const { app, db, cookie, vaultDir } = await setup()
    const day = (offset: number) => {
      const d = new Date(Date.now() - offset * 24 * 3600 * 1000)
      return d.toISOString().slice(0, 19).replace('T', ' ')
    }
    recordUsage(db, { model: 'm-chat', purpose: 'chat', promptTokens: 100, completionTokens: 50 })
    recordUsage(db, { model: 'm-embed', purpose: 'embed', promptTokens: 10 })
    db.prepare("UPDATE usage_records SET created_at = ? WHERE model = 'm-embed'").run(day(3))

    const res7 = await app.request('/api/usage?days=7', { headers: { cookie } })
    expect(res7.status).toBe(200)
    const data = (await res7.json()) as {
      summary: { total: number; chat: number; embed: number }
      models: Array<{ model: string; tokens: number }>
      daily: Array<{ day: string; chat: number; embed: number }>
      records: Array<{ model: string; tokens: number }>
    }
    expect(data.summary.total).toBe(160)
    expect(data.summary.chat).toBe(150)
    expect(data.summary.embed).toBe(10)
    expect(data.models[0]!.model).toBe('m-chat')
    expect(data.daily.length).toBe(7)
    expect(data.records.length).toBe(2)

    const res30 = await app.request('/api/usage?days=30', { headers: { cookie } })
    expect(((await res30.json()) as { daily: unknown[] }).daily.length).toBe(30)

    const bad = await app.request('/api/usage?days=9', { headers: { cookie } })
    expect(bad.status).toBe(400)
  })
})
