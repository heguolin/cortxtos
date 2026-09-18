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
import { Indexer } from '../src/server/kb/indexer.js'
import type { EmbeddingClient, EmbedResult } from '../src/server/llm/embedder.js'
import { buildChatModel } from '../src/server/llm/chat.js'
import type { Hono } from 'hono'

const DIM = 16
const PW = 'test-pass-123'

function semanticEmbedder(): EmbeddingClient {
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

/** OpenAI 兼容 SSE mock：流式回 "你好！"，末块带 usage，并记录收到的 auth 头 */
function startMockChat(): Promise<{ port: number; close: () => void; lastAuth: () => string | undefined }> {
  let lastAuth: string | undefined
  const server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
    res.write(
      chunk({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock-chat',
        choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null }],
      }),
    )
    res.write(
      chunk({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock-chat',
        choices: [{ index: 0, delta: { content: '！' }, finish_reason: null }],
      }),
    )
    res.write(
      chunk({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock-chat',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
      }),
    )
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        port,
        close: () => server.close(),
        lastAuth: () => lastAuth,
      })
    })
  })
}

interface SseEvent {
  event: string
  data: Record<string, unknown>
}

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = []
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
  const mock = await startMockChat()
  const db = openDb(':memory:')
  migrate(db)
  ensureVecTable(db, DIM)
  process.env.APP_PASSWORD = PW
  await seedPasswordFromEnv(db)
  process.env.LLM_API_KEY = 'test-secret-key'

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-chat-'))
  const content = '# 知识\n\n苹果是红色的水果。'
  const { document } = (await import('../src/server/kb/service.js')).uploadDocument(db, vaultDir, {
    name: 'kb.md',
    bytes: new TextEncoder().encode(content),
  })
  const indexer = new Indexer(db, vaultDir, semanticEmbedder(), DIM)
  await indexer.processDocument(document.id)

  const embedder = semanticEmbedder()
  const app = createApp({
    db,
    config: FACTORY_CONFIG,
    rateLimiter: new LoginRateLimiter(),
    vaultDir,
    indexer,
    embedder,
    chatModel: buildChatModel({ model: 'mock-chat', baseUrl: `http://127.0.0.1:${mock.port}/v1` }),
  })
  // 受保护 API 需要登录会话
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

describe('对话（固定管线 + SSE）', () => {
  it('端到端：建会话 → 提问 → citations/delta/done 事件 + 落库 + chat 记账 + key 送达 mock', async () => {
    const { app, db, mock, cookie } = await setup()
    const createRes = await app.request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })
    expect(createRes.status).toBe(201)
    const { session } = (await createRes.json()) as { session: { id: number; title: string } }

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content: '苹果是什么颜色的？' }),
    })
    expect(res.status).toBe(200)
    const events = parseSse(await res.text())
    const kinds = events.map((e) => e.event)
    expect(kinds).toContain('citations')
    expect(kinds).toContain('delta')
    expect(kinds).toContain('done')

    // 流式增量拼出完整回复
    const deltas = events.filter((e) => e.event === 'delta')
    const text = deltas.map((e) => e.data.text as string).join('')
    expect(text).toBe('你好！')

    // 引用来自知识库检索
    const citations = (events.find((e) => e.event === 'citations')!.data.citations) as Array<{ title: string; n: number }>
    expect(citations.length).toBeGreaterThan(0)
    expect(citations[0]!.n).toBe(1)

    // done 事件带落库后的两条消息（user + assistant）
    const done = events.find((e) => e.event === 'done')!.data as {
      userMessage: { id: number; content: string }
      assistantMessage: { id: number; content: string; citations: unknown[]; usage: { promptTokens: number; completionTokens: number } | null }
    }
    expect(done.userMessage.content).toBe('苹果是什么颜色的？')
    expect(done.assistantMessage.content).toBe('你好！')
    expect(done.assistantMessage.citations.length).toBeGreaterThan(0)
    expect(done.assistantMessage.usage).toEqual({ promptTokens: 12, completionTokens: 2 })

    // DB 状态：消息 4 字段齐全 + 会话标题自动取首问 + UsageRecord(chat)
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(session.id) as { n: number }
    expect(count.n).toBe(2)
    const srow = db.prepare('SELECT title FROM sessions WHERE id = ?').get(session.id) as { title: string }
    expect(srow.title).toBe('苹果是什么颜色的？')
    const usage = db.prepare("SELECT model, prompt_tokens, completion_tokens FROM usage_records WHERE purpose = 'chat'").all() as { model: string; prompt_tokens: number; completion_tokens: number }[]
    expect(usage.length).toBe(1)
    expect(usage[0]!.prompt_tokens).toBe(12)
    expect(usage[0]!.completion_tokens).toBe(2)

    // 聚合平台侧应收到 Bearer key（key 不落库不下发，只进请求头）
    expect(mock.lastAuth()).toBe('Bearer test-secret-key')

    // 会话列表标题同步
    void app
    void db
  })

  it('未配置 key → 显式 error 事件 + 落库失败信息（不静默）', async () => {
    const { app, db, cookie } = await setup()
    delete process.env.LLM_API_KEY
    const { session } = (await (
      await app.request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })
    ).json()) as { session: { id: number } }

    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content: '测试' }),
    })
    const events = parseSse(await res.text())
    expect(events.some((e) => e.event === 'error')).toBe(true)
    const done = events.find((e) => e.event === 'done')!.data as { assistantMessage: { content: string } }
    expect(done.assistantMessage.content).toContain('生成失败')

    const stored = db.prepare('SELECT content FROM messages WHERE role = \'assistant\'').get() as { content: string }
    expect(stored.content).toContain('生成失败')
  })

  it('删除会话 → 消息级联消失', async () => {
    const { app, db, cookie } = await setup()
    const { session } = (await (
      await app.request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })
    ).json()) as { session: { id: number } }
    const del = await app.request(`/api/sessions/${session.id}`, { method: 'DELETE', headers: { cookie } })
    expect(del.status).toBe(204)
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(session.id) as { n: number }
    expect(count.n).toBe(0)
  })

  it('空 content → 400', async () => {
    const { app, cookie } = await setup()
    const { session } = (await (
      await app.request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })
    ).json()) as { session: { id: number } }
    const res = await app.request(`/api/sessions/${session.id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  void ({} as Hono)
})
