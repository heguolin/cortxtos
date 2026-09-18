import type { DB } from './db.js'
import type { AppConfig } from './config.js'
import type { LoginRateLimiter } from './auth/ratelimit.js'

export interface ServerDeps {
  db: DB
  config: AppConfig
  rateLimiter: LoginRateLimiter
}
