import { chunkPages, type ChunkDraft } from './chunk.js'
import { extractPages } from './extract.js'
import { clearDerivedIndex, getDocument, readDocumentFile } from './service.js'
import { tokenizeForFts } from './tokenize.js'
import { recordUsage } from '../llm/usage.js'
import type { EmbeddingClient } from '../llm/embedder.js'
import type { DB } from '../db.js'

const EMBED_BATCH_SIZE = 16

/**
 * 串行索引队列（单进程语义）。DESIGN §4.1 状态机：
 * queued → indexing → ready / failed(可重试)；失败不污染 Vault（真相源）。
 */
export class Indexer {
  private queue: number[] = []
  private processing = false

  constructor(
    private readonly db: DB,
    private readonly vaultDir: string,
    private readonly embedder: EmbeddingClient,
    private readonly dimensions: number,
  ) {}

  enqueue(id: number): void {
    if (!this.queue.includes(id)) this.queue.push(id)
    void this.drain()
  }

  /** 启动恢复：把上次没跑完的 queued/indexing 重新入队 */
  recover(): void {
    const rows = this.db
      .prepare("SELECT id FROM documents WHERE status IN ('queued','indexing')")
      .all() as { id: number }[]
    for (const r of rows) this.enqueue(r.id)
    if (rows.length > 0) console.log(`[indexer] 恢复 ${rows.length} 个待索引文档`)
  }

  private async drain(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!
        await this.processDocument(id)
      }
    } finally {
      this.processing = false
    }
  }

  async processDocument(id: number): Promise<'ready' | 'failed'> {
    const doc = getDocument(this.db, id)
    if (!doc) return 'failed'
    this.setStatus(id, 'indexing', null)
    try {
      const { bytes } = readDocumentFile(this.db, this.vaultDir, id)
      const pages = await extractPages(doc.mime, bytes)
      const drafts: ChunkDraft[] = chunkPages(pages, doc.mime === 'text/markdown')
      if (drafts.length === 0) throw new Error('没有可索引的内容')

      // 结构化索引（chunks + FTS5）在事务内重建
      const chunkIds: number[] = []
      this.db.transaction(() => {
        clearDerivedIndex(this.db, id)
        const insChunk = this.db.prepare(
          'INSERT INTO chunks(document_id, ord, text, page, heading_path, token_count) VALUES (?, ?, ?, ?, ?, ?)',
        )
        const insFts = this.db.prepare('INSERT INTO chunks_fts(chunk_id, text) VALUES (?, ?)')
        drafts.forEach((d, i) => {
          const info = insChunk.run(id, i, d.text, d.page, d.headingPath, d.tokens)
          const chunkId = Number(info.lastInsertRowid)
          chunkIds.push(chunkId)
          insFts.run(chunkId, tokenizeForFts(d.text))
        })
      })()

      // 向量索引：分批嵌入 + UsageRecord 强制归因（purpose=embed）
      // rowid 即 chunk_id（见 db.ts ensureVecTable 注释）：chunk_id 是自家 DB 整数，拼字面量安全
      for (let start = 0; start < drafts.length; start += EMBED_BATCH_SIZE) {
        const batch = drafts.slice(start, start + EMBED_BATCH_SIZE)
        const { vectors, promptTokens } = await this.embedder.embed(batch.map((d) => d.text))
        if (vectors.length !== batch.length) {
          throw new Error(`嵌入返回条数不符：${vectors.length} != ${batch.length}`)
        }
        const dim = vectors[0]?.length ?? 0
        if (dim !== this.dimensions) {
          throw new Error(
            `嵌入维度不匹配：API 返回 ${dim}，config 期望 ${this.dimensions}（修改 models.embedding.dimensions 后需重建索引）`,
          )
        }
        recordUsage(this.db, { model: this.embedder.model, purpose: 'embed', promptTokens })
        batch.forEach((_, i) => {
          const chunkId = chunkIds[start + i]!
          const f32 = new Float32Array(vectors[i]!)
          this.db
            .prepare(`INSERT INTO chunk_vec VALUES (${chunkId}, ?)`)
            .run(Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength))
        })
      }

      this.setStatus(id, 'ready', null)
      console.log(`[indexer] 文档 ${id}（${doc.title}）就绪：${drafts.length} chunks`)
      return 'ready'
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[indexer] 文档 ${id}（${doc.title}）索引失败: ${message}`)
      this.setStatus(id, 'failed', message)
      return 'failed'
    }
  }

  private setStatus(id: number, status: string, error: string | null): void {
    this.db
      .prepare("UPDATE documents SET status = ?, error = ?, updated_at = datetime('now') WHERE id = ?")
      .run(status, error, id)
  }
}
