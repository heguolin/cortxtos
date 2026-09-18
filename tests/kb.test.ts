import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb, type DB } from '../src/server/db.js'
import { migrate } from '../src/server/migrations.js'
import {
  KbError,
  deleteDocument,
  listDocuments,
  readDocumentFile,
  saveMarkdownEdit,
  uploadDocument,
} from '../src/server/kb/service.js'

let db: DB
let vaultDir: string

beforeEach(() => {
  db = openDb(':memory:')
  migrate(db)
  vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortxt-kb-'))
})

const md = (content: string) => new TextEncoder().encode(content)

describe('uploadDocument', () => {
  it('上传 md → 落 Vault + 登记 queued', () => {
    const { document, duplicate } = uploadDocument(db, vaultDir, {
      name: '笔记.md',
      bytes: md('# 标题\n\n正文内容'),
    })
    expect(duplicate).toBe(false)
    expect(document.status).toBe('queued')
    expect(document.mime).toBe('text/markdown')
    expect(fs.existsSync(path.join(vaultDir, document.source))).toBe(true)
  })

  it('同内容重复上传 → sha256 幂等，不产生第二行', () => {
    const first = uploadDocument(db, vaultDir, { name: 'a.md', bytes: md('hello') })
    const second = uploadDocument(db, vaultDir, { name: 'b.md', bytes: md('hello') })
    expect(second.duplicate).toBe(true)
    expect(second.document.id).toBe(first.document.id)
    expect(listDocuments(db).length).toBe(1)
  })

  it('同名不同内容 → 自动改名 " (2)" 落盘', () => {
    uploadDocument(db, vaultDir, { name: 'a.md', bytes: md('one') })
    const second = uploadDocument(db, vaultDir, { name: 'a.md', bytes: md('two') })
    expect(second.document.source).toBe('a (2).md')
  })

  it('拒绝不支持的类型', () => {
    expect(() => uploadDocument(db, vaultDir, { name: 'virus.exe', bytes: md('x') })).toThrow(KbError)
    expect(() => uploadDocument(db, vaultDir, { name: 'virus.exe', bytes: md('x') })).toThrowError(
      /不支持的文件类型/,
    )
  })

  it('拒绝空文件与路径穿越名', () => {
    expect(() => uploadDocument(db, vaultDir, { name: 'empty.md', bytes: md('') })).toThrowError(/空文件/)
    expect(() => uploadDocument(db, vaultDir, { name: '../../etc/passwd.md', bytes: md('x') })).not.toThrow()
    const doc = listDocuments(db)[0]
    expect(doc?.source).not.toContain('..')
  })
})

describe('deleteDocument', () => {
  it('删除 = 文件与 DB 行同时消失', () => {
    const { document } = uploadDocument(db, vaultDir, { name: 'gone.md', bytes: md('bye') })
    const file = path.join(vaultDir, document.source)
    expect(fs.existsSync(file)).toBe(true)
    deleteDocument(db, vaultDir, document.id)
    expect(fs.existsSync(file)).toBe(false)
    expect(listDocuments(db).length).toBe(0)
  })

  it('删除不存在的 id → 404', () => {
    expect(() => deleteDocument(db, vaultDir, 999)).toThrowError(/不存在/)
  })
})

describe('saveMarkdownEdit', () => {
  it('保存即重写真相源，状态回 queued，sha256 更新', () => {
    const { document } = uploadDocument(db, vaultDir, { name: 'e.md', bytes: md('v1') })
    const updated = saveMarkdownEdit(db, vaultDir, document.id, 'v2 内容')
    expect(updated.status).toBe('queued')
    expect(updated.sha256).not.toBe(document.sha256)
    const { bytes } = readDocumentFile(db, vaultDir, document.id)
    expect(bytes.toString('utf8')).toBe('v2 内容')
  })

  it('拒绝编辑非 Markdown', () => {
    const { document } = uploadDocument(db, vaultDir, { name: 'p.pdf', bytes: md('%PDF-1.4') })
    expect(() => saveMarkdownEdit(db, vaultDir, document.id, 'x')).toThrowError(/Markdown/)
  })
})

describe('readDocumentFile', () => {
  it('文件丢失 → 410 明确报错', () => {
    const { document } = uploadDocument(db, vaultDir, { name: 'lost.md', bytes: md('x') })
    fs.unlinkSync(path.join(vaultDir, document.source))
    expect(() => readDocumentFile(db, vaultDir, document.id)).toThrowError(/丢失/)
  })
})
