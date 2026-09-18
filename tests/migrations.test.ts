import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, type DB } from '../src/server/db.js'
import { migrate } from '../src/server/migrations.js'
import '../src/server/migrations/0001_baseline.js'

function schemaOf(db: DB): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table','index','view','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name)
}

describe('migrate', () => {
  it('基线建全 DESIGN §6 全部表 + 认证存储', () => {
    const db = openDb(':memory:')
    migrate(db)
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'chunks_fts%'").all() as { name: string }[]
    ).map((r) => r.name)
    for (const t of [
      'documents',
      'chunks',
      'sessions',
      'messages',
      'jobs',
      'runs',
      'usage_records',
      'kv',
      'user_auth',
      'app_sessions',
      '_migrations',
    ]) {
      expect(tables, `缺少表 ${t}`).toContain(t)
    }
    // FTS5 虚表 + 向量虚表（向量表在 ensureVecTable 后才存在）
    expect(
      (db.prepare("SELECT name FROM sqlite_master WHERE name='chunks_fts'").all() as unknown[]).length,
    ).toBe(1)
  })

  it('迁移幂等：连跑两遍 schema 无 diff，_migrations 只记一条', () => {
    const db = openDb(':memory:')
    migrate(db)
    const afterFirst = schemaOf(db)
    migrate(db)
    expect(schemaOf(db)).toEqual(afterFirst)
    expect((db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n).toBe(1)
  })

  it('WAL 已开启（文件库）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-db-'))
    const db = openDb(path.join(dir, 't.db'))
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  })

  it('外键强制：孤儿 message 拒绝写入', () => {
    const db = openDb(':memory:')
    migrate(db)
    expect(() =>
      db
        .prepare("INSERT INTO messages(session_id, role, content) VALUES (999, 'user', 'x')")
        .run(),
    ).toThrowError(/FOREIGN KEY/)
  })

  it('documents 状态 CHECK 约束生效', () => {
    const db = openDb(':memory:')
    migrate(db)
    expect(() =>
      db
        .prepare(
          "INSERT INTO documents(title, source, mime, sha256, size, status) VALUES ('a','a','text/markdown','aa',1,'weird')",
        )
        .run(),
    ).toThrowError(/CHECK/)
  })
})
