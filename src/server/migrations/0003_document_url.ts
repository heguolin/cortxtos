import type { DB } from '../db.js'
import type { Migration } from '../migrations.js'

/** v2.4 票 02：documents.url = 网页捕获的业务身份（ADR 0005：同 URL 重抓覆盖）。
 *  部分唯一索引：文件捕获 url 为 NULL 不参与唯一约束。 */
export const documentUrl: Migration = {
  name: '0003_document_url',
  up: (db: DB) => {
    db.exec('ALTER TABLE documents ADD COLUMN url TEXT')
    db.exec('CREATE UNIQUE INDEX idx_documents_url ON documents(url) WHERE url IS NOT NULL')
  },
}
