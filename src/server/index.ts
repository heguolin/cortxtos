import fs from 'node:fs'
import path from 'node:path'
import { ConfigError, loadConfig, loadDotEnv } from './config.js'
import { openDb, ensureVecTable } from './db.js'
import { migrate } from './migrations.js'
import { createApp, startServer } from './http.js'
import { dirLayout, resolveDataDir } from './paths.js'

function fail(message: string): never {
  console.error(`[cortxt] ${message}`)
  process.exit(1)
}

function boot(): void {
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
  ensureVecTable(db, config.models.embedding.dimensions)

  // DESIGN §8：key 缺失明确告警，不静默、不崩溃（调用时显式报错）
  if (!process.env.LLM_API_KEY) {
    console.warn('[cortxt] 告警: 未配置 LLM_API_KEY —— 对话/嵌入在配置前将显式报错（不影响启动）')
  }
  if (!process.env.LLM_BASE_URL) {
    console.warn('[cortxt] 告警: 未配置 LLM_BASE_URL —— 对话/嵌入在配置前将显式报错（不影响启动）')
  }

  const app = createApp()
  startServer(app, config.server.port)
}

boot()
