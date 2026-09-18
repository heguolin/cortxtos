import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, ensureVecTable } from '../src/server/db.js'
import { migrate } from '../src/server/migrations.js'
import { uploadDocument } from '../src/server/kb/service.js'
import { Indexer } from '../src/server/kb/indexer.js'
import type { EmbeddingClient, EmbedResult } from '../src/server/llm/embedder.js'

const DIM = 8

function fakeVector(text: string): number[] {
  // 确定性伪向量：不同文本 → 不同向量
  const v = new Array<number>(DIM).fill(0)
  for (let i = 0; i < text.length; i++) v[i % DIM]! += text.charCodeAt(i) % 7
  return v.map((x) => x / 10)
}

function fakeEmbedder(model = 'fake-embed'): EmbeddingClient {
  return {
    model,
    async embed(texts: string[]): Promise<EmbedResult> {
      return { vectors: texts.map(fakeVector), promptTokens: texts.reduce((n, t) => n + t.length, 0) }
    },
  }
}

function failingEmbedder(message: string): EmbeddingClient {
  return {
    model: 'failing-embed',
    async embed() {
      throw new Error(message)
    },
  }
}

function makeVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-idx-'))
}

// 生成一个合法的最小 PDF（含正确 xref），供 unpdf 抽取
function makePdf(text: string): Buffer {
  const stream = `BT /F1 14 Tf 72 720 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${stream.length}>>stream\n${stream}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xrefPos = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF`
  return Buffer.from(out, 'latin1')
}

describe('Indexer', () => {
  it('中文 md → ready：chunks + FTS5 中文可命中 + 向量行齐全 + embed 记账', async () => {
    const db = openDb(':memory:')
    migrate(db)
    ensureVecTable(db, DIM)
    const vaultDir = makeVault()
    const content = '# 知识管理\n\n个人知识库是第二大脑，支持中文全文检索。'
    fs.writeFileSync(path.join(vaultDir, 'km.md'), content)
    uploadDocument(db, vaultDir, { name: 'km.md', bytes: new TextEncoder().encode(content) })

    const indexer = new Indexer(db, vaultDir, fakeEmbedder(), DIM)
    expect(await indexer.processDocument(1)).toBe('ready')

    const doc = db.prepare('SELECT status FROM documents WHERE id = 1').get() as { status: string }
    expect(doc.status).toBe('ready')

    const chunks = db.prepare('SELECT * FROM chunks WHERE document_id = 1').all() as {
      id: number
      heading_path: string | null
    }[]
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]!.heading_path).toBe('知识管理')

    // FTS5 中文检索（jieba 分词生效）
    const hits = db
      .prepare("SELECT chunk_id FROM chunks_fts WHERE chunks_fts MATCH '知识'")
      .all() as { chunk_id: number }[]
    expect(hits.length).toBeGreaterThan(0)

    // 向量行数 == chunks 行数
    const vecCount = db.prepare('SELECT COUNT(*) AS n FROM chunk_vec').get() as { n: number }
    expect(vecCount.n).toBe(chunks.length)

    // UsageRecord(embed) 强制归因
    const usage = db
      .prepare("SELECT model, purpose, prompt_tokens FROM usage_records WHERE purpose = 'embed'")
      .all() as { model: string; prompt_tokens: number }[]
    expect(usage.length).toBeGreaterThan(0)
    expect(usage[0]!.model).toBe('fake-embed')
    expect(usage[0]!.prompt_tokens).toBeGreaterThan(0)
  })

  it('嵌入失败 → failed + 错误可见；换好嵌入器重试 → ready', async () => {
    const db = openDb(':memory:')
    migrate(db)
    ensureVecTable(db, DIM)
    const vaultDir = makeVault()
    fs.writeFileSync(path.join(vaultDir, 'doc.md'), '正文内容，用于索引测试。')
    uploadDocument(db, vaultDir, {
      name: 'doc.md',
      bytes: new TextEncoder().encode('正文内容，用于索引测试。'),
    })

    expect(await new Indexer(db, vaultDir, failingEmbedder('模拟断网'), DIM).processDocument(1)).toBe('failed')
    const failed = db.prepare('SELECT status, error FROM documents WHERE id = 1').get() as {
      status: string
      error: string | null
    }
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('模拟断网')

    expect(await new Indexer(db, vaultDir, fakeEmbedder(), DIM).processDocument(1)).toBe('ready')
  })

  it('嵌入维度不匹配 → 显式报错（不静默）', async () => {
    const db = openDb(':memory:')
    migrate(db)
    ensureVecTable(db, DIM + 1)
    const vaultDir = makeVault()
    fs.writeFileSync(path.join(vaultDir, 'd.md'), '维度不匹配测试。')
    uploadDocument(db, vaultDir, { name: 'd.md', bytes: new TextEncoder().encode('维度不匹配测试。') })

    const wrongDim = new Indexer(db, vaultDir, fakeEmbedder(), DIM + 1)
    expect(await wrongDim.processDocument(1)).toBe('failed')
    const row = db.prepare('SELECT error FROM documents WHERE id = 1').get() as { error: string | null }
    expect(row.error).toContain('维度不匹配')
  })

  it('PDF → 逐页抽取保留页码并可索引', async () => {
    const db = openDb(':memory:')
    migrate(db)
    ensureVecTable(db, DIM)
    const vaultDir = makeVault()
    const pdf = makePdf('Hello PDF page one')
    fs.writeFileSync(path.join(vaultDir, 'report.pdf'), pdf)
    uploadDocument(db, vaultDir, { name: 'report.pdf', bytes: new Uint8Array(pdf) })

    expect(await new Indexer(db, vaultDir, fakeEmbedder(), DIM).processDocument(1)).toBe('ready')
    const chunk = db.prepare('SELECT text, page FROM chunks WHERE document_id = 1').get() as {
      text: string
      page: number | null
    }
    expect(chunk.page).toBe(1)
    expect(chunk.text).toContain('Hello PDF page one')
  })
})
