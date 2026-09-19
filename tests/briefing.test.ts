import { describe, expect, it, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { openDb, ensureVecTable } from '../src/server/db.js'
import { migrate } from '../src/server/migrations.js'
import { createApp } from '../src/server/http.js'
import { LoginRateLimiter } from '../src/server/auth/ratelimit.js'
import { seedPasswordFromEnv } from '../src/server/auth/service.js'
import { FACTORY_CONFIG } from '../src/server/config.js'
import { Scheduler } from '../src/server/scheduler.js'
import { runBriefing, runPromptTask } from '../src/server/briefing.js'
import { uploadDocument } from '../src/server/kb/service.js'
import { Indexer } from '../src/server/kb/indexer.js'
import { buildChatModel } from '../src/server/llm/chat.js'
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

/** 简报 mock：固定回简报文本，记录收到的 prompt */
function startMockBriefing(): Promise<{ port: number; close: () => void; lastBody: () => string }> {
  let lastBody = ''
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      lastBody = raw
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
      res.write(
        chunk({
          id: 'b1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'mock-brief',
          choices: [{ index: 0, delta: { role: 'assistant', content: '今日新增 1 篇：苹果笔记。' }, finish_reason: null }],
        }),
      )
      res.write(
        chunk({
          id: 'b1',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'mock-brief',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
        }),
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, close: () => server.close(), lastBody: () => lastBody })
    })
  })
}

async function setup(withDoc: boolean) {
  const mock = await startMockBriefing()
  const db = openDb(':memory:')
  migrate(db)
  ensureVecTable(db, DIM)
  process.env.APP_PASSWORD = PW
  await seedPasswordFromEnv(db)
  process.env.LLM_API_KEY = 'brief-key'

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-brief-'))
  if (withDoc) {
    const content = '# 苹果笔记\n\n苹果是红色的。'
    const { document } = uploadDocument(db, vaultDir, {
      name: 'apple.md',
      bytes: new TextEncoder().encode(content),
    })
    await new Indexer(db, vaultDir, noiseEmbedder(), DIM).processDocument(document.id)
  }

  const briefingModel = buildChatModel({ model: 'mock-brief', baseUrl: `http://127.0.0.1:${mock.port}/v1` })
  Scheduler.seedDailyBriefing(db, FACTORY_CONFIG.briefing.schedule)
  const scheduler = new Scheduler(db, (job) => {
    if (job.name === 'daily-briefing') {
      return runBriefing(db, briefingModel, process.env.LLM_API_KEY, FACTORY_CONFIG.briefing.promptTemplate)
    }
    return runPromptTask(db, briefingModel, process.env.LLM_API_KEY, (JSON.parse(job.spec) as { prompt?: string }).prompt ?? '')
  })

  const app = createApp({
    db,
    config: FACTORY_CONFIG,
    rateLimiter: new LoginRateLimiter(),
    vaultDir,
    scheduler,
  })
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  })
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { app, db, mock, scheduler, cookie }
}

afterEach(() => {
  delete process.env.LLM_API_KEY
})

describe('调度器 + 每日简报', () => {
  it('有文档：runJob → success，产物落库，prompt 带模板与文档标题，background 记账', async () => {
    const { db, mock, scheduler } = await setup(true)
    const runId = await scheduler.runJob('daily-briefing')
    const run = db.prepare('SELECT status, output FROM runs WHERE id = ?').get(runId) as { status: string; output: string }
    expect(run.status).toBe('success')
    expect(run.output).toContain('今日新增 1 篇')

    const body = mock.lastBody()
    expect(body).toContain('简明日报')
    expect(body).toContain('apple.md')
    expect(body).toContain('苹果是红色的')

    const usage = db.prepare("SELECT prompt_tokens, completion_tokens FROM usage_records WHERE purpose = 'background'").all() as { prompt_tokens: number; completion_tokens: number }[]
    expect(usage.length).toBe(1)
    expect(usage[0]!.prompt_tokens).toBe(30)
    expect(usage[0]!.completion_tokens).toBe(10)
  })

  it('无文档：不调 LLM，直接「今日无更新」', async () => {
    const { db, mock, scheduler } = await setup(false)
    const runId = await scheduler.runJob('daily-briefing')
    const run = db.prepare('SELECT status, output FROM runs WHERE id = ?').get(runId) as { status: string; output: string }
    expect(run.status).toBe('success')
    expect(run.output).toBe('今日无更新')
    expect(mock.lastBody()).toBe('')
    const usage = db.prepare("SELECT COUNT(*) AS n FROM usage_records WHERE purpose = 'background'").get() as { n: number }
    expect(usage.n).toBe(0)
  })

  it('重复触发同一天 → tickNow 幂等（当天只跑一次）', async () => {
    const { scheduler, db } = await setup(true)
    await scheduler.runJob('daily-briefing')
    const before = (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n
    await scheduler.tickNow()
    const after = (db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n
    expect(after).toBe(before)
  })

  it('手动触发路由 → 200 + 简报列表可读 + 详情可读', async () => {
    const { app, cookie } = await setup(true)
    const trigger = await app.request('/api/jobs/daily-briefing/run', { method: 'POST', headers: { cookie } })
    expect(trigger.status).toBe(200)

    const list = await app.request('/api/briefings', { headers: { cookie } })
    const { briefings } = (await list.json()) as { briefings: Array<{ id: number; status: string }> }
    expect(briefings.length).toBe(1)
    expect(briefings[0]!.status).toBe('success')

    const detail = await app.request(`/api/briefings/${briefings[0]!.id}`, { headers: { cookie } })
    const { briefing } = (await detail.json()) as { briefing: { output: string } }
    expect(briefing.output).toContain('今日新增')
  })

  it('未知任务 → 404；未登录 → 401', async () => {
    const { app, cookie } = await setup(true)
    const notFound = await app.request('/api/jobs/nope/run', { method: 'POST', headers: { cookie } })
    expect(notFound.status).toBe(404)
    const unauthorized = await app.request('/api/briefings')
    expect(unauthorized.status).toBe(401)
  })
})
