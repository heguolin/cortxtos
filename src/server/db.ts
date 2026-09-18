import Database from 'better-sqlite3'
import * as sqliteVec from 'sqlite-vec'

export type DB = Database.Database

export function openDb(dbPath: string): DB {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  sqliteVec.load(db)
  return db
}

/**
 * 向量表依赖嵌入维度（config），不能进基线迁移；幂等创建。
 * 注意（sqlite-vec 0.1.9 + better-sqlite3 实测）：
 * 1. 声明 PK 列后，绑定式插入会把 PK 报成非整数（扩展 bug）——因此不声明 PK，
 *    用 rowid 充当 chunk_id：插入时 chunk_id 拼进 SQL 字面量（来自自家 DB 的整数，无注入面），向量走绑定。
 * 2. 查询返回 rowid 即 chunk_id；删除按 rowid。
 */
export function ensureVecTable(db: DB, dimensions: number): void {
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding FLOAT[${dimensions}])`)
}

/** 已建向量表的实际维度；null = 尚未创建 */
export function currentVecDimensions(db: DB): number | null {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chunk_vec'").get() as
    | { sql: string }
    | undefined
  if (!row) return null
  const m = /\[(-?\d+)\]/.exec(row.sql)
  return m ? Number(m[1]) : null
}
