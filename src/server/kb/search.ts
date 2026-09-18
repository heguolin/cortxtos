import { tokenizeForFts } from './tokenize.js'
import { recordUsage } from '../llm/usage.js'
import type { EmbeddingClient } from '../llm/embedder.js'
import type { DB } from '../db.js'

export interface Hit {
  chunkId: number
  documentId: number
  title: string
  source: string
  page: number | null
  headingPath: string | null
  text: string
  score: number
  /** 命中来源：fts / vector / both */
  legs: string
}

const RRF_K = 60

/**
 * Reciprocal Rank Fusion：按名次融合多路召回（DESIGN §4.1 检索管线）。
 * 返回按融合得分降序的 chunk id 列表。
 */
export function rrfFuse(rankedLists: number[][], k = RRF_K): number[] {
  const scores = new Map<number, number>()
  for (const list of rankedLists) {
    list.forEach((id, idx) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1))
    })
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

interface LegRow {
  chunkId: number
  documentId: number
  title: string
  source: string
  page: number | null
  headingPath: string | null
  text: string
}

const SELECT_COLUMNS = `
  c.id AS chunkId,
  d.id AS documentId,
  d.title AS title,
  d.source AS source,
  c.page AS page,
  c.heading_path AS headingPath,
  c.text AS text
`

export interface SearchOptions {
  /** 最终返回条数（DESIGN: top6 注入 prompt） */
  limit?: number
  /** 每路召回条数 */
  k?: number
  /** 记录查询嵌入的 UsageRecord（默认 true） */
  recordQueryUsage?: boolean
}

export async function hybridSearch(
  db: DB,
  embedder: EmbeddingClient,
  query: string,
  opts: SearchOptions = {},
): Promise<Hit[]> {
  const limit = opts.limit ?? 6
  const k = opts.k ?? 20

  // 第一路：FTS5 关键词（jieba 分词，ADR 0004）
  const ftsRows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS}
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.chunk_id
       JOIN documents d ON d.id = c.document_id
       WHERE chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(tokenizeForFts(query), k) as LegRow[]

  // 第二路：向量相似（查询嵌入）。vec0 KNN 在 JOIN 下约束检测失效，按官方推荐走 CTE + k 约束
  const { vectors, promptTokens } = await embedder.embed([query])
  const queryVector = vectors[0]
  if (!queryVector) throw new Error('嵌入 API 返回空向量')
  const f32 = new Float32Array(queryVector)
  const vecRows = db
    .prepare(
      `WITH knn AS (
         SELECT rowid, distance
         FROM chunk_vec
         WHERE embedding MATCH ? AND k = ${Math.max(1, Math.floor(k))}
       )
       SELECT ${SELECT_COLUMNS}
       FROM knn
       JOIN chunks c ON c.id = knn.rowid
       JOIN documents d ON d.id = c.document_id
       ORDER BY knn.distance`,
    )
    .all(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength)) as LegRow[]

  if (opts.recordQueryUsage !== false) {
    recordUsage(db, { model: embedder.model, purpose: 'embed', promptTokens })
  }

  const fused = rrfFuse([
    ftsRows.map((r) => r.chunkId),
    vecRows.map((r) => r.chunkId),
  ])

  const rowById = new Map<number, { row: LegRow; legs: Set<string>; scores: Map<string, number> }>()
  const track = (rows: LegRow[], leg: string, scoreOf: (r: LegRow, idx: number) => number) => {
    rows.forEach((r, idx) => {
      let entry = rowById.get(r.chunkId)
      if (!entry) {
        entry = { row: r, legs: new Set(), scores: new Map() }
        rowById.set(r.chunkId, entry)
      }
      entry.legs.add(leg)
      entry.scores.set(leg, scoreOf(r, idx))
    })
  }
  track(ftsRows, 'fts', (_r, idx) => 1 / (RRF_K + idx + 1))
  track(vecRows, 'vector', (_r, idx) => 1 / (RRF_K + idx + 1))

  return fused.slice(0, limit).map((chunkId) => {
    const entry = rowById.get(chunkId)!
    const legs = entry.legs.has('both') ? 'both' : [...entry.legs].sort().join('+')
    const score = [...entry.scores.values()].reduce((a, b) => a + b, 0)
    return {
      chunkId: entry.row.chunkId,
      documentId: entry.row.documentId,
      title: entry.row.title,
      source: entry.row.source,
      page: entry.row.page,
      headingPath: entry.row.headingPath,
      text: entry.row.text,
      score,
      legs,
    }
  })
}
