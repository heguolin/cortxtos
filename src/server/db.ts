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

/** 向量表依赖嵌入维度（config），不能进基线迁移；幂等创建 */
export function ensureVecTable(db: DB, dimensions: number): void {
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding FLOAT[${dimensions}])`,
  )
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
