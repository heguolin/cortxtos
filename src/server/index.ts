import fs from 'node:fs'
import path from 'node:path'
import { ConfigError, loadConfig, loadDotEnv } from './config.js'
import { openDb, currentVecDimensions, ensureVecTable } from './db.js'
import { migrate } from './migrations.js'
import { purgeExpiredSessions, seedPasswordFromEnv } from './auth/service.js'
import { LoginRateLimiter } from './auth/ratelimit.js'
import { createEmbedderFromEnv } from './llm/embedder.js'
import { buildChatModel } from './llm/chat.js'
import { Indexer } from './kb/indexer.js'
import { createApp, startServer } from './http.js'
import { dirLayout, resolveDataDir } from './paths.js'

function fail(message: string): never {
  console.error(`[cortxt] ${message}`)
  process.exit(1)
}

async function boot(): Promise<void> {
  console.log('[cortxt] 启动中…')

  loadDotEnv(path.resolve('.env'))
  const layout = dirLayout(resolveDataDir())
  fs.mkdirSync(layout.dataDir, { recursive: true })
  fs.mkdirSync(layout.vaultDir, { recursive: true })

  let config
  try {
    ;({ config } = loadConfig(layout.dataDir))
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message)
    throw err
  }
  console.log(`[cortxt] 数据目录: ${layout.dataDir}`)

  const db = openDb(layout.dbPath)
  migrate(db)

  // 嵌入维度变更 → 丢弃旧向量，全部文档回 queued 重建（Vault 是真相源，安全）
  const currentDim = currentVecDimensions(db)
  const wantedDim = config.models.embedding.dimensions
  if (currentDim !== null && currentDim !== wantedDim) {
    console.warn(`[cortxt] 嵌入维度 ${currentDim} → ${wantedDim}：丢弃旧向量，全部文档将重建索引`)
    db.exec('DROP TABLE chunk_vec')
    db.prepare("UPDATE documents SET status = 'queued', error = NULL").run()
  }
  ensureVecTable(db, wantedDim)

  // DESIGN §8：.env 仅在库中无密码时种子，此后以 DB 为准
  const seedState = await seedPasswordFromEnv(db)
  if (seedState === 'seeded') console.log('[cortxt] 已从 APP_PASSWORD 种子登录密码（此后以数据库为准）')
  if (seedState === 'no-env') {
    console.warn('[cortxt] 告警: 尚未设置登录密码——请在 .env 配置 APP_PASSWORD 后重启，否则无法登录')
  }
  purgeExpiredSessions(db)

  // key 缺失明确告警，不静默、不崩溃（调用时显式报错）
  if (!process.env.LLM_API_KEY) {
    console.warn('[cortxt] 告警: 未配置 LLM_API_KEY —— 对话/嵌入在配置前将显式报错（不影响启动）')
  }
  if (!process.env.LLM_BASE_URL) {
    console.warn('[cortxt] 告警: 未配置 LLM_BASE_URL —— 对话/嵌入在配置前将显式报错（不影响启动）')
  }

  const embedder = createEmbedderFromEnv(config.models.embedding)
  const indexer = new Indexer(
    db,
    layout.vaultDir,
    embedder,
    config.models.embedding.dimensions,
  )
  indexer.recover()

  const app = createApp({
    db,
    config,
    rateLimiter: new LoginRateLimiter(),
    vaultDir: layout.vaultDir,
    indexer,
    embedder,
    chatModel: buildChatModel(config.models.primary),
  })
  startServer(app, config.server.port)
}

await boot().catch((err) => {
  console.error('[cortxt] 启动失败:', err)
  process.exit(1)
})
