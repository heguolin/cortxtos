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

/** 保守 mock：请求带 Authorization: Bearer bad → 500 错误流；否则回文本 */
function startSwitchableMock(): Promise<{
  port: number
  close: () => void
  setMode: (m: 'fail' | 'ok') => void
}> {
  let mode: 'fail' | 'ok' = 'fail'
  const server = http.createServer((req, res) => {
    if (mode === 'fail') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"upstream exploded"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`
    res.write(
      chunk({
        id: 'r1', object: 'chat.completion.chunk', created: 1, model: 'mock-bg',
        choices: [{ index: 0, delta: { role: 'assistant', content: '重试后成功了' }, finish_reason: null }],
      }),
    )
    res.write(
      chunk({
        id: 'r1', object: 'chat.completion.chunk', created: 1, model: 'mock-bg',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
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
        setMode: (m) => (mode = m),
      })
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
  const mock = await startSwitchableMock()
  const db = openDb(':memory:')
  migrate(db)
  ensureVecTable(db, DIM)
  process.env.APP_PASSWORD = PW
  await seedPasswordFromEnv(db)
  process.env.LLM_API_KEY = 'retry-key'
  // background 档指向同一个 mock；失败模式由 mock.setMode 控制
  process.env.LLM_BASE_URL = `http://127.0.0.1:${mock.port}/v1`

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-retry-'))
  const backgroundModel = buildChatModel({ model: 'mock-bg', baseUrl: `http://127.0.0.1:${mock.port}/v1` })
  const app = createApp({
    db,
    config: FACTORY_CONFIG,
    rateLimiter: new LoginRateLimiter(),
    vaultDir,
    embedder: noiseEmbedder(),
    chatModel: backgroundModel,
    backgroundModel,
    backgroundApiKeyEnv: 'LLM_API_KEY',
  })
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  })
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  const sid = (
    (await (
      await app.request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })
    ).json()) as { session: { id: number } }
  ).session.id
  return { app, db, mock, cookie, sid }
}

afterEach(() => {
  delete process.env.LLM_API_KEY
  delete process.env.LLM_BASE_URL
})

describe('会话级换档 + 重试生成', () => {
  it('失败 → 重试按钮语义：原位替换失败回复，用户气泡不重复，background 记账', async () => {
    const { app, db, mock, cookie, sid } = await setup()
    // 第一轮：mock 处于 fail → 生成失败落库
    const first = parseSse(
      await (
        await app.request(`/api/sessions/${sid}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ content: '讲个笑话' }),
        })
      ).text(),
    )
    const failed = first.find((e) => e.event === 'done')!.data.assistantMessage as { id: number; content: string }
    expect(failed.content).toContain('生成失败')

    // 切 ok 模式 → 重试
    mock.setMode('ok')
    const retry = parseSse(
      await (await app.request(`/api/sessions/${sid}/retry`, { method: 'POST', headers: { cookie } })).text(),
    )
    expect(retry.some((e) => e.event === 'delta')).toBe(true)
    const done = retry.find((e) => e.event === 'done')!
    const replaced = done.data.replacedMessage as { id: number; content: string; usage: { promptTokens: number } | null }
    expect(replaced.id).toBe(failed.id) // 原位替换：同一条消息
    expect(replaced.content).toContain('重试后成功了')

    // 用户气泡不重复：user 消息仍 1 条；assistant 仍 1 条（被替换）
    const counts = db
      .prepare('SELECT role, COUNT(*) AS n FROM messages WHERE session_id = ? GROUP BY role')
      .all(sid) as Array<{ role: string; n: number }>
    expect(counts.find((c) => c.role === 'user')!.n).toBe(1)
    expect(counts.find((c) => c.role === 'assistant')!.n).toBe(1)
    expect((db.prepare('SELECT content FROM messages WHERE id = ?').get(failed.id) as { content: string }).content).toContain('重试后成功了')
  })

  it('空会话重试 → 400', async () => {
    const { app, cookie } = await setup()
    const sid = (
      (await (
        await app.request('/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}' })
      ).json()) as { session: { id: number } }
    ).session.id
    const res = await app.request(`/api/sessions/${sid}/retry`, { method: 'POST', headers: { cookie } })
    expect(res.status).toBe(400)
  })
})
