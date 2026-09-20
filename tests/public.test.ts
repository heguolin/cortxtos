import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, ensureVecTable } from '../src/server/db.js'
import { migrate } from '../src/server/migrations.js'
import { createApp } from '../src/server/http.js'
import { LoginRateLimiter } from '../src/server/auth/ratelimit.js'
import { seedPasswordFromEnv } from '../src/server/auth/service.js'
import { uploadDocument } from '../src/server/kb/service.js'
import { FACTORY_CONFIG } from '../src/server/config.js'
import type { EmbeddingClient, EmbedResult } from '../src/server/llm/embedder.js'

const DIM = 16
const PW = 'test-pass-123'

function noiseEmbedder(): EmbeddingClient {
  const noise = (t: string) => {
    const v = new Array<number>(DIM).fill(0.1)
    for (let i = 0; i < t.length; i++) v[i % DIM]! += (t.charCodeAt(i) % 5) * 0.01
    return v
  }
  return {
    model: 'semantic-fake',
    async embed(texts: string[]): Promise<EmbedResult> {
      return { vectors: texts.map(noise), promptTokens: texts.reduce((n, t) => n + t.length, 0) }
    },
  }
}

async function setup() {
  const db = openDb(':memory:')
  migrate(db)
  ensureVecTable(db, DIM)
  process.env.APP_PASSWORD = PW
  await seedPasswordFromEnv(db)
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-pub-'))
  const content = '# 苹果\n\n苹果是红色的水果。'
  uploadDocument(db, vaultDir, { name: 'apple.md', bytes: new TextEncoder().encode(content) })
  const app = createApp({
    db,
    config: FACTORY_CONFIG,
    rateLimiter: new LoginRateLimiter(),
    vaultDir,
    embedder: noiseEmbedder(),
  })
  return { app, db }
}

describe('公开只读模式（游客可浏览）', () => {
  it('游客：文档列表/元信息/raw/检索 全部 200', async () => {
    const { app } = await setup()
    const list = await app.request('/api/documents')
    expect(list.status).toBe(200)
    const docs = ((await list.json()) as { documents: Array<{ id: number; tags: string[] }> }).documents
    expect(docs.length).toBe(1)

    expect((await app.request(`/api/documents/${docs[0]!.id}`)).status).toBe(200)
    const raw = await app.request(`/api/documents/${docs[0]!.id}/raw`)
    expect(raw.status).toBe(200)
    expect(await raw.text()).toContain('苹果是红色的水果')
    const search = await app.request(`/api/search?q=${encodeURIComponent('苹果')}`)
    expect(search.status).toBe(200)
  })

  it('游客：写操作全部 401（捕获/上传/删除/对话）', async () => {
    const { app } = await setup()
    const capture = await app.request('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x' }),
    })
    expect(capture.status).toBe(401)
    const upload = await app.request('/api/documents', { method: 'POST' })
    expect(upload.status).toBe(401)
    const del = await app.request('/api/documents/1', { method: 'DELETE' })
    expect(del.status).toBe(401)
    const session = await app.request('/api/sessions', { method: 'POST' })
    expect(session.status).toBe(401)
    const usage = await app.request('/api/usage')
    expect(usage.status).toBe(401)
  })

  it('游客：简报可读（200），任务管理 401', async () => {
    const { app } = await setup()
    expect((await app.request('/api/briefings')).status).toBe(200)
    expect((await app.request('/api/jobs')).status).toBe(401)
  })
})
