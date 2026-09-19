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
import { setTags } from '../src/server/kb/service.js'
import {
  extractBareUrl,
  assertPublicUrl,
  WebCaptureError,
  buildCaptureMarkdown,
} from '../src/server/kb/webcapture.js'
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

const DEMO_HTML = `<!doctype html><html><head><title>Deep Agents 实战笔记</title></head>
<body><article><h1>Deep Agents 实战笔记</h1>
<p>这篇讲 agent harness 的骨架设计。</p>
<pre><code>const loop = runAgentLoop()</code></pre>
<p>结尾。</p></article></body></html>`

/** 目标页 mock：可配响应（html/json/403/重定向）；跑在回环上（测试放行内网） */
function startTarget(html: string, status = 200, headers: Record<string, string> = {}): Promise<{
  port: number
  close: () => void
  hits: () => number
}> {
  let hits = 0
  const server = http.createServer((req, res) => {
    hits++
    if (headers.location) {
      res.writeHead(status, headers)
      res.end()
      return
    }
    res.writeHead(status, { 'content-type': headers['content-type'] ?? 'text/html; charset=utf-8' })
    res.end(status === 200 ? html : 'blocked')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ port, close: () => server.close(), hits: () => hits })
    })
  })
}

async function setup() {
  const db = openDb(':memory:')
  migrate(db)
  ensureVecTable(db, DIM)
  process.env.APP_PASSWORD = PW
  await seedPasswordFromEnv(db)
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-webcap-'))
  const indexer = new Indexer(db, vaultDir, noiseEmbedder(), DIM)
  const app = createApp({
    db,
    config: FACTORY_CONFIG,
    rateLimiter: new LoginRateLimiter(),
    vaultDir,
    indexer,
    embedder: noiseEmbedder(),
  })
  const loginRes = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PW }),
  })
  const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { app, db, cookie, vaultDir, indexer }
}

afterEach(() => {
  delete process.env.CORTEXT_ALLOW_PRIVATE_FETCH
})

describe('裸 URL 判定', () => {
  it('裸 URL 识别；混文字/非 http 不算', () => {
    expect(extractBareUrl('  https://example.com/a?b=1  ')).toBe('https://example.com/a?b=1')
    expect(extractBareUrl('看这篇 https://example.com 写得好')).toBeNull()
    expect(extractBareUrl('ftp://example.com')).toBeNull()
    expect(extractBareUrl('not a url')).toBeNull()
  })
})

describe('SSRF 防护', () => {
  it('内网/环回/解析拦截', async () => {
    for (const url of [
      'http://localhost/x',
      'http://127.0.0.1/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/x',
      'http://10.0.0.5/x',
    ]) {
      await expect(assertPublicUrl(url), url).rejects.toThrow(WebCaptureError)
    }
    // 本地 DNS 劫持可能把任意域名解析到内网网关——无论哪种错误都属于拒绝
    await expect(assertPublicUrl('https://nonexistent.invalid.example/x')).rejects.toThrow(WebCaptureError)
  })
})

describe('网页捕获端到端', () => {
  it('mock 页面 → 入库 ready：元信息头 + 正文 markdown + 可检索', async () => {
    process.env.CORTEXT_ALLOW_PRIVATE_FETCH = '1'
    const { app, cookie, db, vaultDir } = await setup()
    const target = await startTarget(DEMO_HTML)

    const res = await app.request('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: `http://127.0.0.1:${target.port}/post/1` }),
    })
    expect(res.status).toBe(201)
    const { document, captured } = (await res.json()) as { document: { id: number; title: string }; captured: boolean }
    expect(captured).toBe(true)
    expect(document.title).toContain('Deep Agents 实战笔记')

    // Vault 文件：元信息头 + 代码块保留
    const raw = fs.readFileSync(path.join(vaultDir, document.title), 'utf8')
    expect(raw).toContain('来源：')
    expect(raw).toContain('抓取于')
    expect(raw).toContain('```')
    expect(raw).toContain('agent harness')

    // 自动索引完成 + FTS 可命中
    await new Promise((r) => setTimeout(r, 300))
    const status = db.prepare('SELECT status FROM documents WHERE id = ?').get(document.id) as { status: string }
    expect(status.status).toBe('ready')
    const hits = db.prepare("SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH '\"harness\"'").all()
    expect(hits.length).toBeGreaterThan(0)
    target.close()
  })

  it('403 防爬 → 显式报错；重定向跟随且逐跳校验', async () => {
    process.env.CORTEXT_ALLOW_PRIVATE_FETCH = '1'
    const { app, cookie } = await setup()
    const forbidden = await startTarget('blocked', 403)
    const res1 = await app.request('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: `http://127.0.0.1:${forbidden.port}/x` }),
    })
    expect(res1.status).toBe(422)
    expect(((await res1.json()) as { error: string }).error).toContain('拒绝访问')

    // 重定向到正常页 → 跟随后抓取成功
    const okTarget = await startTarget(DEMO_HTML)
    const redirector = await startTarget('', 302, { location: `http://127.0.0.1:${okTarget.port}/real` })
    const res2 = await app.request('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: `http://127.0.0.1:${redirector.port}/jump` }),
    })
    expect(res2.status).toBe(201)
    forbidden.close()
    redirector.close()
    okTarget.close()
  })

  it('重定向到内网地址 → 拒绝；非 HTML → 415', async () => {
    process.env.CORTEXT_ALLOW_PRIVATE_FETCH = '1'
    const { app, cookie } = await setup()
    // 允许内网模式下无法测"重定向到内网被拒"——单独关掉开关测
    delete process.env.CORTEXT_ALLOW_PRIVATE_FETCH
    const inner = await startTarget(DEMO_HTML)
    const redirector = await startTarget('', 302, { location: `http://127.0.0.1:${inner.port}/x` })
    const res = await app.request('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: `http://127.0.0.1:${redirector.port}/jump` }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('内网')

    const jsonTarget = await startTarget('{"a":1}', 200, { 'content-type': 'application/json' })
    process.env.CORTEXT_ALLOW_PRIVATE_FETCH = '1'
    const res2 = await app.request('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: `http://127.0.0.1:${jsonTarget.port}/api` }),
    })
    expect(res2.status).toBe(415)
    inner.close()
    redirector.close()
    jsonTarget.close()
  })

  it('混文字输入走纯文本捕获（不受影响）', async () => {
    const { app, cookie } = await setup()
    const res = await app.request('/api/documents/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: '看这篇 https://example.com/a 写得好' }),
    })
    expect(res.status).toBe(201)
    const { document, captured } = (await res.json()) as { document: { title: string }; captured?: boolean }
    expect(captured).toBeUndefined()
    expect(document.title).toBe('看这篇 https   example.com a 写得好.md') // 标题消毒替换 : / 字符
  })

  it('ADR 0005：同 URL 重抓内容不同 → 覆盖原文档且标签保留；内容相同 → 幂等', async () => {
    process.env.CORTEXT_ALLOW_PRIVATE_FETCH = '1'
    const { app, cookie, db, vaultDir } = await setup()
    // 可数 mock：第 1 次请求返回 v1 正文，第 2 次起返回 v2
    let hits = 0
    const server = http.createServer((_req, res) => {
      hits++
      const v = hits === 1 ? '第一版正文，用于首轮抓取验证的完整内容。' : '第二版正文，内容更新了，并且补充了更多细节描述。'
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>版本文章</title></head><body><article><p>${v}</p></article></body></html>`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const { port } = server.address() as AddressInfo
    const url = `http://127.0.0.1:${port}/post/1`

    const r1 = await app.request('/api/documents/capture', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: url }),
    })
    expect(r1.status).toBe(201)
    const first = (await r1.json()) as { document: { id: number; source: string } }
    setTags(db, first.document.id, ['踩坑'])

    // URL 身份落库
    const row = db.prepare('SELECT url FROM documents WHERE id = ?').get(first.document.id) as { url: string }
    expect(row.url).toBe(url)

    // 重抓（内容变化）→ 覆盖：仍是 1 份文档、标签保留
    const r2 = await app.request('/api/documents/capture', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: url }),
    })
    expect(r2.status).toBe(200)
    const second = (await r2.json()) as { overwritten: boolean; document: { id: number } }
    expect(second.overwritten).toBe(true)
    const count = (db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n
    expect(count).toBe(1)
    const tagsAfter = db.prepare('SELECT tags FROM documents WHERE id = ?').get(second.document.id) as { tags: string }
    expect(JSON.parse(tagsAfter.tags)).toEqual(['踩坑'])

    // 第三次抓取（内容不再变化）→ 幂等
    const r3 = await app.request('/api/documents/capture', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: url }),
    })
    expect(r3.status).toBe(200)
    expect(((await r3.json()) as { duplicate: boolean }).duplicate).toBe(true)

    server.close()
  })

  it('元信息头构造', () => {
    const md = buildCaptureMarkdown({
      url: 'https://example.com/a',
      siteName: 'Example',
      title: 'T',
      markdown: '正文',
    })
    expect(md).toContain('[Example](https://example.com/a)')
    expect(md).toContain('抓取于')
    expect(md).toContain('正文')
  })

  void ({} as Hono)
})
