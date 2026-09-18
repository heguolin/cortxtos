import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { DB } from '../db.js'

/** DESIGN §4.1：单文件 50MB 上限；仅 .md / .txt / .pdf */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

const ALLOWED: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
}

export interface DocumentRow {
  id: number
  title: string
  source: string
  mime: string
  sha256: string
  size: number
  status: string
  error: string | null
  created_at: string
  updated_at: string
}

export type KbStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 503

export class KbError extends Error {
  constructor(
    public readonly status: KbStatus,
    message: string,
  ) {
    super(message)
  }
}

export function getDocument(db: DB, id: number): DocumentRow | undefined {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined
}

export function listDocuments(db: DB): DocumentRow[] {
  return db
    .prepare('SELECT * FROM documents ORDER BY id DESC')
    .all() as DocumentRow[]
}

function sanitizeName(raw: string): string {
  const base = path
    .basename(raw)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
  if (!base || base === '.' || base === '..') throw new KbError(400, '文件名不合法')
  return base.length > 120 ? base.slice(-120) : base
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Vault 内平铺；同名不同内容 → 追加 " (2)" 序号 */
function uniqueVaultPath(vaultDir: string, name: string): string {
  let candidate = path.join(vaultDir, name)
  if (!fs.existsSync(candidate)) return candidate
  const ext = path.extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let i = 2; ; i++) {
    candidate = path.join(vaultDir, `${stem} (${i})${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
}

/** 删除文档的派生索引行（向量 + FTS5 + chunks，注意先删引用 chunks 的行）。真相源文件不动。 */
export function clearDerivedIndex(db: DB, documentId: number): void {
  const hasVec = !!db.prepare("SELECT name FROM sqlite_master WHERE name = 'chunk_vec'").get()
  if (hasVec) {
    // chunk_vec 的 rowid 即 chunks.id（见 db.ts 注释）
    db.prepare('DELETE FROM chunk_vec WHERE rowid IN (SELECT id FROM chunks WHERE document_id = ?)').run(documentId)
  }
  db.prepare('DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)').run(documentId)
  db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId)
}

export interface UploadInput {
  name: string
  bytes: Uint8Array
}

export interface UploadResult {
  document: DocumentRow
  duplicate: boolean
}

export function uploadDocument(db: DB, vaultDir: string, input: UploadInput): UploadResult {
  const name = sanitizeName(input.name)
  const ext = path.extname(name).toLowerCase()
  const mime = ALLOWED[ext]
  if (!mime) throw new KbError(415, `不支持的文件类型「${ext || '(无扩展名)'}」：仅支持 .md / .txt / .pdf`)
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new KbError(413, '文件超过 50MB 上限')
  if (input.bytes.byteLength === 0) throw new KbError(400, '空文件')

  const sha = sha256Of(input.bytes)
  const existing = db.prepare('SELECT * FROM documents WHERE sha256 = ?').get(sha) as
    | DocumentRow
    | undefined
  if (existing) return { document: existing, duplicate: true }

  const target = uniqueVaultPath(vaultDir, name)
  fs.writeFileSync(target, input.bytes)
  const title = path.basename(target)
  const info = db
    .prepare(
      "INSERT INTO documents(title, source, mime, sha256, size, status) VALUES (?, ?, ?, ?, ?, 'queued')",
    )
    .run(title, title, mime, sha, input.bytes.byteLength)
  return { document: getDocument(db, Number(info.lastInsertRowid))!, duplicate: false }
}

/** DESIGN §4.1：删除 = 删文件 + 删索引行；先删 DB（事务），文件尽力删（孤儿文件不可见且会被 reindex 收编） */
export function deleteDocument(db: DB, vaultDir: string, id: number): void {
  const doc = getDocument(db, id)
  if (!doc) throw new KbError(404, '文档不存在')
  db.transaction(() => {
    clearDerivedIndex(db, id)
    db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  })()
  const p = path.join(vaultDir, doc.source)
  if (fs.existsSync(p)) {
    try {
      fs.unlinkSync(p)
    } catch (err) {
      console.error(`[kb] 文件删除失败（${doc.source}）:`, err)
    }
  }
}

export function readDocumentFile(
  db: DB,
  vaultDir: string,
  id: number,
): { document: DocumentRow; bytes: Buffer } {
  const doc = getDocument(db, id)
  if (!doc) throw new KbError(404, '文档不存在')
  const p = path.join(vaultDir, doc.source)
  if (!fs.existsSync(p)) throw new KbError(410, '源文件已丢失（Vault 与索引不一致），可删除后重新上传')
  return { document: doc, bytes: fs.readFileSync(p) }
}

/** 在线编辑：仅 Markdown；保存即重写真相源，状态回 queued 等重建索引 */
export function saveMarkdownEdit(
  db: DB,
  vaultDir: string,
  id: number,
  content: string,
): DocumentRow {
  const doc = getDocument(db, id)
  if (!doc) throw new KbError(404, '文档不存在')
  if (doc.mime !== 'text/markdown') throw new KbError(415, '仅支持 Markdown 在线编辑')
  const bytes = Buffer.from(content, 'utf8')
  if (bytes.byteLength > MAX_UPLOAD_BYTES) throw new KbError(413, '内容超过 50MB 上限')
  const sha = sha256Of(bytes)
  const clash = db.prepare('SELECT id FROM documents WHERE sha256 = ? AND id != ?').get(sha, id)
  if (clash) throw new KbError(409, '内容与另一份现有文档完全相同（sha256 冲突）')

  fs.writeFileSync(path.join(vaultDir, doc.source), bytes)
  db.transaction(() => {
    clearDerivedIndex(db, id)
    db.prepare(
      "UPDATE documents SET sha256 = ?, size = ?, status = 'queued', error = NULL, updated_at = datetime('now') WHERE id = ?",
    ).run(sha, bytes.byteLength, id)
  })()
  return getDocument(db, id)!
}
