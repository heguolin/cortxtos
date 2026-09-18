import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, ensureVecTable, type DB } from '../src/server/db.js'
import { migrate } from '../src/server/migrations.js'
import { Indexer } from '../src/server/kb/indexer.js'
import { hybridSearch, rrfFuse } from '../src/server/kb/search.js'
import { reindexAll, uploadDocument } from '../src/server/kb/service.js'
import type { EmbeddingClient, EmbedResult } from '../src/server/llm/embedder.js'

const DIM = 16

/** 语义化假嵌入：含「苹果」→ A 向量；含「数据库」→ B 向量；否则基于字符的杂讯 */
function semanticEmbedder(): EmbeddingClient {
  const A = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const B = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  const noise = (t: string) => {
    const v = new Array<number>(DIM).fill(0.1)
    for (let i = 0; i < t.length; i++) v[i % DIM]! += (t.charCodeAt(i) % 5) * 0.01
    return v
  }
  const pick = (t: string) =>
    t.includes('苹果') ? A : t.includes('数据库') ? B : noise(t)
  return {
    model: 'semantic-fake',
    async embed(texts: string[]): Promise<EmbedResult> {
      return {
        vectors: texts.map(pick),
        promptTokens: texts.reduce((n, t) => n + t.length, 0),
      }
    },
  }
}

function setup(): { db: DB; vaultDir: string } {
  const db = openDb(':memory:')
  migrate(db)
  ensureVecTable(db, DIM)
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-search-'))
  return { db, vaultDir }
}

async function indexDoc(db: DB, vaultDir: string, name: string, content: string): Promise<void> {
  // uploadDocument 自己会把文件写进 Vault（真相源），这里不要预写（否则触发改名）
  const { document } = uploadDocument(db, vaultDir, {
    name,
    bytes: new TextEncoder().encode(content),
  })
  await new Indexer(db, vaultDir, semanticEmbedder(), DIM).processDocument(document.id)
}

describe('rrfFuse', () => {
  it('双路都命中的排最前，单路命中按名次衰减', () => {
    const fused = rrfFuse([
      [1, 2, 3],
      [2, 4, 5],
    ])
    expect(fused[0]).toBe(2) // 双路命中
    expect(fused).toContain(1)
    expect(fused).toContain(4)
    expect(fused.length).toBe(5)
  })
  it('空列表不抛异常', () => {
    expect(rrfFuse([[], []])).toEqual([])
  })
})

describe('hybridSearch', () => {
  it('样例库 10 文档 5 组中文问题：期望文档进 top6 且引用字段完整', async () => {
    const { db, vaultDir } = setup()
    await indexDoc(db, vaultDir, '水果笔记.md', '# 水果\n\n苹果是一种常见水果，富含维生素，红色的苹果最甜。\n\n香蕉是黄色的水果。')
    await indexDoc(db, vaultDir, '技术笔记.md', '# 技术\n\n数据库索引能加速查询，SQLite 的 FTS5 支持全文检索。')
    await indexDoc(db, vaultDir, '日常随笔.md', '# 随笔\n\n今天天气不错，出门散步，顺便买了咖啡。')
    await indexDoc(db, vaultDir, '工作记录.md', '# 工作\n\n完成了项目周报，和团队对齐了下个迭代的目标。')
    await indexDoc(db, vaultDir, '烹饪手册.md', '# 烹饪\n\n苹果派的做法：苹果切片，裹上肉桂和糖，进烤箱 200 度 25 分钟。')
    await indexDoc(db, vaultDir, '旅行清单.md', '# 旅行\n\n下次旅行想去云南，看洱海和玉龙雪山，行程五天。')
    await indexDoc(db, vaultDir, '健身计划.md', '# 健身\n\n每周三次力量训练，配合有氧，目标是年底深蹲 120 公斤。')
    await indexDoc(db, vaultDir, '读书摘录.md', '# 读书\n\n《失控》讲的是去中心化系统的智慧，机器正在逐步获得生命。')
    await indexDoc(db, vaultDir, '菜谱速查.md', '# 菜谱\n\n红烧肉的关键是炒糖色，五花肉焯水后小火炖四十分钟。')
    await indexDoc(db, vaultDir, '观影记录.md', '# 观影\n\n最近看了星际穿越，五维空间和父女情的处理非常动人。')

    const cases: Array<{ q: string; expectTitle: string }> = [
      { q: '苹果的营养', expectTitle: '水果笔记.md' },
      { q: '数据库全文检索', expectTitle: '技术笔记.md' },
      { q: '苹果派怎么做', expectTitle: '烹饪手册.md' },
      { q: '散步买咖啡', expectTitle: '日常随笔.md' },
      { q: '项目周报迭代目标', expectTitle: '工作记录.md' },
    ]
    const embedder = semanticEmbedder()
    for (const c of cases) {
      const hits = await hybridSearch(db, embedder, c.q, { recordQueryUsage: false })
      expect(hits.length, `问题「${c.q}」应有限流内命中`).toBeGreaterThan(0)
      expect(hits.length).toBeLessThanOrEqual(6)
      expect(
        hits.slice(0, 2).some((h) => h.title === c.expectTitle),
        `问题「${c.q}」期望前 2 名含 ${c.expectTitle}，实际: ${hits.map((h) => h.title).join(', ')}`,
      ).toBe(true)
      const hit = hits[0]!
      expect(hit.documentId).toBeGreaterThan(0)
      expect(hit.source).toBeTruthy()
      expect(hit.text).toBeTruthy()
    }
  })

  it('向量腿独立可用：精确同文本查询 distance=0 排第一', async () => {
    const { db, vaultDir } = setup()
    await indexDoc(db, vaultDir, 'a.md', '数据库索引加速查询。')
    const hits = await hybridSearch(db, semanticEmbedder(), '数据库索引加速查询。', { recordQueryUsage: false })
    expect(hits[0]!.title).toBe('a.md')
    expect(hits[0]!.legs).toContain('vector')
  })

  it('空库/无命中 → 返回空数组不抛异常', async () => {
    const { db } = setup()
    const hits = await hybridSearch(db, semanticEmbedder(), '任何问题', { recordQueryUsage: false })
    expect(hits).toEqual([])
  })

  it('查询嵌入默认落 UsageRecord(embed)', async () => {
    const { db, vaultDir } = setup()
    await indexDoc(db, vaultDir, 'x.md', '内容。')
    await hybridSearch(db, semanticEmbedder(), '内容', { recordQueryUsage: true })
    const usage = db
      .prepare("SELECT COUNT(*) AS n FROM usage_records WHERE purpose = 'embed' AND model = 'semantic-fake'")
      .get() as { n: number }
    expect(usage.n).toBeGreaterThanOrEqual(1)
  })
})

describe('reindexAll', () => {
  it('收编孤儿文件 + 全部回 queued，重建后检索结果一致', async () => {
    const { db, vaultDir } = setup()
    await indexDoc(db, vaultDir, 'k1.md', '知识库重建测试。')
    // 制造孤儿：直接往 Vault 扔文件
    fs.writeFileSync(path.join(vaultDir, 'orphan.md'), '孤儿文件也要进库。')

    const queued = reindexAll(db, vaultDir)
    expect(queued).toBe(2)
    const statuses = db.prepare('SELECT status FROM documents ORDER BY id').all() as { status: string }[]
    expect(statuses.every((s) => s.status === 'queued')).toBe(true)

    // 入队跑完后检索两个主题都命中
    const indexer = new Indexer(db, vaultDir, semanticEmbedder(), DIM)
    await indexer.processDocument(1)
    await indexer.processDocument(2)
    const hits = await hybridSearch(db, semanticEmbedder(), '孤儿文件', { recordQueryUsage: false })
    expect(hits[0]!.title).toBe('orphan.md')
  })
})
