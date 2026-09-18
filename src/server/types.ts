import type { DB } from './db.js'
import type { AppConfig } from './config.js'
import type { LoginRateLimiter } from './auth/ratelimit.js'
import type { Indexer } from './kb/indexer.js'

export interface ServerDeps {
  db: DB
  config: AppConfig
  rateLimiter: LoginRateLimiter
  /** Vault 真相源目录（ADR 0003） */
  vaultDir: string
  /** 入库管线（票 04）；测试环境可缺省 */
  indexer?: Indexer
}
