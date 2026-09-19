import type { DB } from '../db.js'
import type { Migration } from '../migrations.js'

/** v2.3 知识库组织：documents.tags = JSON 字符串数组（纯元数据，Vault 平铺不动） */
export const documentTags: Migration = {
  name: '0002_document_tags',
  up: (db: DB) => {
    db.exec("ALTER TABLE documents ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'")
  },
}
