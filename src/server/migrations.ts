import type { DB } from './db.js'
import { baseline } from './migrations/0001_baseline.js'
import { documentTags } from './migrations/0002_document_tags.js'

export interface Migration {
  name: string
  up: (db: DB) => void
}

/** 注册表：新增迁移在此按序追加 */
export const migrations: Migration[] = [baseline, documentTags]

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  const applied = new Set(
    (db.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  )
  for (const m of migrations) {
    if (applied.has(m.name)) continue
    db.transaction(() => {
      m.up(db)
      db.prepare('INSERT INTO _migrations(name) VALUES (?)').run(m.name)
    })()
  }
}
