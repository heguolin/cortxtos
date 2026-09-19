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
import { hybridSearch } from '../src/server/kb/search.js'
import { uploadDocument } from '../src/server/kb/service.js'
import { Indexer } from '../src/server/kb/indexer.js'
import { buildChatModel } from '../src/server/llm/chat.js'
import type { EmbeddingClient, EmbedResult } from '../src/server/llm/embedder.js'
import type { Hono } from 'hono'

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

/**
 * 有状态 mock：带 tools 的请求第 1 次回 tool_calls(kb_list)、第 2 次起回文本；
 * 不带 tools 的请求（vision/普通）直接回文本。记录原始 body 供断言。
 */
function startToolMock(): Promise<{ port: number; close: () => void; bodies: () => string[] }> {
  const bodies: string[] = []
  let toolCallSent = false
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      bodies.push(raw)
      let hasTools = false
      try {
        const parsed = JSON.parse(raw) as { tools?: unknown[] }
        hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0
      } catch {
        hasTools = false
      }
      const wantToolCall = hasTools && !toolCallSent
      if (wantToolCall) toolCallSent = true
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
      if (wantToolCall) {
        res.write(
          chunk({
            id: 't1', object: 'chat.completion.chunk', created: 1, model: 'mock',
            choices: [{
              index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'kb_list', arguments: '{}' } }] }, finish_reason: null,
            }],
          }),
        )
        res.write(
          chunk({
            id: 't1', object: 'chat.completion.chunk', created: 1, model: 'mock',
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          }),
        )
      } else {
        res.write(
          chunk({
            id: `t${bodies.length}`, object: 'chat.completion.chunk', created: 1, model: 'mock',
            choices: [{ index: 0, delta: { role: 'assistant', content: '知识库里有 demo.md' }, finish_reason: null }],
          }),
        )
        res.write(
          chunk({
            id: `t${bodies.length}`, object: 'chat.completion.chunk', created: 1, model: 'mock',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
          }),
        )
      }
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, close: () => server.close(), bodies: () => bodies })
    })
  })
}

function parseSse(text: string): Array<{ event: string; data: Record<string, unknown> }> {
  const events: Array<{ event: string; data: Record<string, unknown> }> = []
  for (const block of text.split('\n\n')) {
    let event = 'message'
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (data) events.push({ event, data: JSON.parse(data) as Record<string, unknown> })
  }
  return events
}

async function setup() {
  const mock = await startToolMock()
  const db = openDb(':memory:')
  migrate(db)
  ensureVecTable(db, DIM)
  process.env.APP_PASSWORD = PW
  await seedPasswordFromEnv(db)
  process.env.LLM_API_KEY = 'v2-key'

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-v2-'))
  const content = '# 标题\n\n苹果是红色的水果。'
  const { document } = uploadDocument(db, vaultDir, { name: 'demo.md', bytes: new TextEncoder().encode(content) })
  await new Indexer(db, vaultDir, noiseEmbedder(), DIM).processDocument(document.id)

  const model = buildChatModel({ model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` })
  Scheduler.seedDailyBriefing(db, FACTORY_CONFIG.briefing.schedule)
  const scheduler = new Scheduler(db, (job) => {
    if (job.name === 'daily-briefing') {
      return runBriefing(db, model, process.env.LLM_API_KEY, FACTORY_CONFIG.briefing.promptTemplate)
    }
    return runPromptTask(db, model, process.env.LLM_API_KEY, (JSON.parse(job.spec) as { prompt?: string }).prompt ?? '', {
      withKb: (JSON.parse(job.spec) as { withKb?: boolean }).withKb,
      retrieve: (query) => hybridSearch(db, noiseEmbedder(), query, { limit: 6 }),
    })
  })
  const app = createApp({
    db,
    config: FACTORY_CONFIG,
    rateLimiter: new LoginRateLimiter(),
    vaultDir,
    indexer: new Indexer(db, vaultDir, noiseEmbedder(), DIM),
    embedder: noiseEmbedder(),
    chatModel: model,
    visionModel: buildChatModel({ model: 'mock', baseUrl: `http://127.0.0.1:${mock.port}/v1` }, { supportsImages: true }),
    visionApiKeyEnv: 'LLM_API_KEY',
    scheduler,
  })
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  })
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { app, db, mock, cookie }
}

afterEach(() => {
  delete process.env.LLM_API_KEY
})

describe('快速捕获', () => {
  it('文本入库：首行作标题、落 Vault、自动索引、重复幂等', async () => {
    const { app, cookie, db } = await setup()
    const res = await app.request('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: '# 会议纪要\n\n今天讨论了下一版功能。' }),
    })
    expect(res.status).toBe(201)
    const { document } = (await res.json()) as { document: { id: number; title: string; status: string } }
    expect(document.title).toBe('会议纪要.md')

    // 等串行队列跑完（同进程直接查状态）
    await new Promise((r) => setTimeout(r, 300))
    const doc = db.prepare('SELECT status FROM documents WHERE id = ?').get(document.id) as { status: string }
    expect(doc.status).toBe('ready')

    // 同内容再捕获 → sha 幂等
    const again = await app.request('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: '# 会议纪要\n\n今天讨论了下一版功能。' }),
    })
    expect(again.status).toBe(200)
  })

  it('空内容 400；无标题行用时间戳兜底', async () => {
    const { app, cookie } = await setup()
    const empty = await app.request('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: '   ' }),
    })
    expect(empty.status).toBe(400)
    const noTitle = await app.request('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: '只有正文没有标题' }),
    })
    expect(noTitle.status).toBe(201)
    const { document } = (await noTitle.json()) as { document: { title: string } }
    expect(document.title).toBe('只有正文没有标题.md')
  })
})

describe('自定义任务携带知识库检索', () => {
  it('withKb 任务执行时 prompt 里出现检索片段', async () => {
    const { app, cookie, mock } = await setup()
    const created = await app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 't', schedule: '22:00', prompt: '苹果是什么颜色', withKb: true }),
    })
    expect(created.status).toBe(201)
    const { job } = (await created.json()) as { job: { id: number; withKb: boolean } }
    expect(job.withKb).toBe(true)

    const run = await app.request(`/api/jobs/${job.id}/run`, { method: 'POST', headers: { cookie } })
    expect(run.status).toBe(200)
    // mock 回显最后一条 user 消息，其中应包含检索到的片段（苹果是红色的水果）
    const body = mock.bodies()[0] ?? ''
    expect(body).toContain('苹果是红色的水果')
    void cookie
    void ({} as Hono)
  })

  it('不带 withKb 的任务 prompt 不含片段', async () => {
    const { app, cookie, mock } = await setup()
    await app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ title: 't2', schedule: '22:00', prompt: '苹果是什么颜色', withKb: false }),
    })
    const jobs = (await (await app.request('/api/jobs', { headers: { cookie } })).json()) as {
      jobs: Array<{ id: number; withKb: boolean }>
    }
    const target = jobs.jobs.find((j) => j.id !== 1)!
    await app.request(`/api/jobs/${target.id}/run`, { method: 'POST', headers: { cookie } })
    expect(mock.bodies()[mock.bodies().length - 1]).not.toContain('苹果是红色的水果')
  })
})

describe('图片问答（vision）', () => {
  it('multipart 贴图 → 请求带 image_url → vision 记账', async () => {
    const { app, cookie, mock, db } = await setup()
    const sid = (
      (await (await app.request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })).json()) as {
        session: { id: number }
      }
    ).session.id
    // 1x1 红色 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const form = new FormData()
    form.append('content', '这张图是什么颜色？')
    form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'red.png')

    const res = await app.request(`/api/sessions/${sid}/messages`, { method: 'POST', headers: { cookie }, body: form })
    expect(res.status).toBe(200)
    const events = parseSse(await res.text())
    const done = events.find((e) => e.event === 'done')
    expect(done).toBeTruthy()
    expect((done!.data.assistantMessage as { content: string }).content).toContain('demo.md') // mock 回显逻辑

    const sent = mock.bodies().join('')
    expect(sent).toContain('image_url')
    const usage = db.prepare("SELECT purpose FROM usage_records WHERE purpose = 'vision'").all()
    expect(usage.length).toBe(1)
  })
})

describe('对话工具深挖（agent loop）', () => {
  it('第一轮模型调 kb_list → 工具结果进第二轮 → 最终文本落库 + tool 事件可见', async () => {
    const { app, cookie, mock } = await setup()
    const sid = (
      (await (await app.request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })).json()) as {
        session: { id: number }
      }
    ).session.id

    const res = await app.request(`/api/sessions/${sid}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content: '知识库里有什么？' }),
    })
    expect(res.status).toBe(200)
    const events = parseSse(await res.text())
    expect(events.some((e) => e.event === 'tool' && (e.data.name as string) === 'kb_list')).toBe(true)

    const done = events.find((e) => e.event === 'done')!
    expect((done.data.assistantMessage as { content: string }).content).toContain('知识库里有 demo.md')

    // 第二轮请求的上下文里应包含工具结果（demo.md）
    const bodies = mock.bodies()
    expect(bodies.length).toBe(2)
    expect(bodies[1]).toContain('demo.md')
  })
})
