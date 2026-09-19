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

/** 通用 LLM mock：把收到的最后一条 user 消息原样回显 */
function startMockLLM(): Promise<{ port: number; close: () => void; lastUser: () => string }> {
  let lastUser = ''
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> }
        lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      } catch {
        lastUser = ''
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
      const reply = `回显:${lastUser.slice(0, 40)}`
      res.write(
        chunk({
          id: 'm1', object: 'chat.completion.chunk', created: 1, model: 'mock',
          choices: [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }],
        }),
      )
      res.write(
        chunk({
          id: 'm1', object: 'chat.completion.chunk', created: 1, model: 'mock',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, close: () => server.close(), lastUser: () => lastUser })
    })
  })
}

async function setup() {
  const mock = await startMockLLM()
  const db = openDb(':memory:')
  migrate(db)
  ensureVecTable(db, DIM)
  process.env.APP_PASSWORD = PW
  await seedPasswordFromEnv(db)
  process.env.LLM_API_KEY = 'tasks-key'

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-tasks-'))
  const { document } = uploadDocument(db, vaultDir, {
    name: 't.md',
    bytes: new TextEncoder().encode('# 标题\n\n正文。'),
  })
  await new Indexer(db, vaultDir, noiseEmbedder(), DIM).processDocument(document.id)

  const model = buildChatModel({ model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` })
  Scheduler.seedDailyBriefing(db, FACTORY_CONFIG.briefing.schedule)
  const scheduler = new Scheduler(db, (job) => {
    if (job.name === 'daily-briefing') {
      return runBriefing(db, model, process.env.LLM_API_KEY, FACTORY_CONFIG.briefing.promptTemplate)
    }
    return runPromptTask(db, model, process.env.LLM_API_KEY, (JSON.parse(job.spec) as { prompt?: string }).prompt ?? '')
  })

  const app = createApp({ db, config: FACTORY_CONFIG, rateLimiter: new LoginRateLimiter(), vaultDir, scheduler })
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

describe('任务 CRUD + 自定义执行', () => {
  it('创建自定义任务 → 列表可见（含内置简报）→ 运行回显提示词 → 记录 success', async () => {
    const { app, db, mock, cookie } = await setup()
    const created = await app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: '晚间新增总结', schedule: '22:00', prompt: '总结今天新增的文档' }),
    })
    expect(created.status).toBe(201)
    const { job } = (await created.json()) as { job: { id: number; title: string; builtin: boolean; enabled: boolean } }
    expect(job.title).toBe('晚间新增总结')
    expect(job.builtin).toBe(false)
    expect(job.enabled).toBe(true)

    const list = await app.request('/api/jobs', { headers: { cookie } })
    const { jobs } = (await list.json()) as { jobs: Array<{ id: number; name: string; title: string }> }
    expect(jobs.map((j) => j.name)).toContain('daily-briefing')
    expect(jobs.find((j) => j.id === job.id)!.title).toBe('晚间新增总结')

    // id 触发运行
    const run = await app.request(`/api/jobs/${job.id}/run`, { method: 'POST', headers: { cookie } })
    expect(run.status).toBe(200)
    const runs = await app.request('/api/runs', { headers: { cookie } })
    const { runs: allRuns } = (await runs.json()) as { runs: Array<{ job_title: string; status: string; output: string }> }
    const mine = allRuns.find((r) => r.job_title === '晚间新增总结')!
    expect(mine.status).toBe('success')
    expect(mine.output).toContain('总结今天新增的文档')
    expect(mock.lastUser()).toContain('总结今天新增的文档')
    void db
  })

  it('PATCH 改时间/开关；停用后 tick 不再调度；内置任务禁删', async () => {
    const { app, cookie, scheduler, db } = await setup()
    const { job } = (await (
      await app.request('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ title: 't', schedule: '23:59', prompt: 'p' }),
      })
    ).json()) as { job: { id: number } }

    const patched = await app.request(`/api/jobs/${job.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ schedule: '00:05', enabled: false }),
    })
    const { job: after } = (await patched.json()) as { job: { schedule: string; enabled: boolean } }
    expect(after.schedule).toBe('00:05')
    expect(after.enabled).toBe(false)

    // 停用的自定义任务不会被 tick 触发（内置简报可能因当前时间≥08:00 补跑，不统计它）
    await scheduler.tickNow()
    const customRuns = (
      db
        .prepare('SELECT COUNT(*) AS n FROM runs WHERE job_id = ?')
        .get(job.id) as { n: number }
    ).n
    expect(customRuns).toBe(0)

    // 内置任务禁删
    const briefJob = (db.prepare("SELECT id FROM jobs WHERE name = 'daily-briefing'").get() as { id: number }).id
    const delBuiltin = await app.request(`/api/jobs/${briefJob}`, { method: 'DELETE', headers: { cookie } })
    expect(delBuiltin.status).toBe(400)

    // 自定义可删
    const del = await app.request(`/api/jobs/${job.id}`, { method: 'DELETE', headers: { cookie } })
    expect(del.status).toBe(204)
  })

  it('校验：非法时间/空提示词 → 400', async () => {
    const { app, cookie } = await setup()
    const bad = await app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'x', schedule: '25:00', prompt: 'p' }),
    })
    expect(bad.status).toBe(400)
    const bad2 = await app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 'x', schedule: '08:00', prompt: '  ' }),
    })
    expect(bad2.status).toBe(400)
  })
})

describe('仪表盘聚合', () => {
  it('统计/最近文档/最新简报/7 日用量一次拿齐', async () => {
    const { app, cookie } = await setup()
    // 先跑一次简报，制造 usage + briefing
    await app.request('/api/jobs/daily-briefing/run', { method: 'POST', headers: { cookie } })

    const res = await app.request('/api/dashboard', { headers: { cookie } })
    expect(res.status).toBe(200)
    const data = (await res.json()) as {
      stats: { docsTotal: number; docsToday: number; tokensToday: number; activeJobs: number }
      recentDocs: Array<{ title: string }>
      latestBriefing: { output: string } | null
      usage7d: Array<{ day: string; chat: number; embed: number; background: number }>
    }
    expect(data.stats.docsTotal).toBe(1)
    expect(data.stats.docsToday).toBe(1)
    expect(data.stats.tokensToday).toBeGreaterThan(0)
    expect(data.stats.activeJobs).toBe(1)
    expect(data.recentDocs[0]!.title).toBe('t.md')
    expect(data.latestBriefing).not.toBeNull()
    expect(data.usage7d.length).toBe(7)
    expect(data.usage7d[6]!.background).toBeGreaterThan(0)
    // 日期升序
    expect(data.usage7d[0]!.day <= data.usage7d[6]!.day).toBe(true)
  })
})
