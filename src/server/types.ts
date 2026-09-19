import type { DB } from './db.js'
import type { AppConfig } from './config.js'
import type { LoginRateLimiter } from './auth/ratelimit.js'
import type { Indexer } from './kb/indexer.js'
import type { EmbeddingClient } from './llm/embedder.js'
import type { ChatModel } from './llm/chat.js'
import type { Scheduler } from './scheduler.js'

export interface ServerDeps {
  db: DB
  config: AppConfig
  rateLimiter: LoginRateLimiter
  /** Vault 真相源目录（ADR 0003） */
  vaultDir: string
  /** 入库管线（票 04）；测试环境可缺省 */
  indexer?: Indexer
  /** 查询侧嵌入客户端（票 05 检索 / 票 06 对话）；测试环境可缺省 */
  embedder?: EmbeddingClient
  /** 聊天主力模型（票 06）；测试环境可缺省 */
  chatModel?: ChatModel
  /** 聊天档位读取 key 的环境变量名（key 只存 .env） */
  chatApiKeyEnv?: string
  /** vision 档模型（图片问答）；未配置 = 图片请求报错 */
  visionModel?: ChatModel | null
  /** vision 档读取 key 的环境变量名 */
  visionApiKeyEnv?: string
  /** background 档模型（会话级换档重试生成用，ADR：重试生成） */
  backgroundModel?: ChatModel | null
  /** background 档读取 key 的环境变量名 */
  backgroundApiKeyEnv?: string
  /** config.json 绝对路径（阵容编辑写盘用，ADR 0007）；测试可缺省 */
  configPath?: string
  /** 阵容保存成功后的自重启钩子（生产 = 延迟退出交 Docker 拉起；测试省略） */
  onConfigSave?: () => void
  /** 调度器（票 07）；测试环境可缺省 */
  scheduler?: Scheduler
}
