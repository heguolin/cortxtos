import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * 配置 = 出厂默认 + <dataDir>/config.json 覆盖，zod fail-fast 校验。
 * 纪律（CONTEXT.md）：未知键直接报错，绝不静默忽略——防手改拼写埋雷。
 */

const modelProfileSchema = z.strictObject({
  model: z.string().min(1),
  baseUrl: z.url().optional(),
})

const embeddingProfileSchema = z.strictObject({
  model: z.string().min(1),
  baseUrl: z.url().optional(),
  dimensions: z.number().int().positive().max(4096).default(1024),
})

export const configSchema = z.strictObject({
  server: z
    .strictObject({ port: z.number().int().min(1).max(65535).default(3000) })
    .prefault({}),
  models: z.strictObject({
    primary: modelProfileSchema,
    background: modelProfileSchema,
    /** M2 接入图片问答；出厂先占位，可缺省 */
    vision: modelProfileSchema.optional(),
    embedding: embeddingProfileSchema,
  }),
  briefing: z
    .strictObject({
      schedule: z
        .string()
        .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, '须为 HH:mm（24 小时制，如 08:00）')
        .default('08:00'),
      promptTemplate: z
        .string()
        .default(
          '你是知识库管理员。请基于下面给出的「过去 24 小时新增或变更的文档」写一份简明日报：' +
            '先一句话总结，再分文档列要点。如果没有文档，输出「今日无更新」。',
        ),
    })
    .prefault({}),
})

export type AppConfig = z.infer<typeof configSchema>
export type ModelProfile = z.infer<typeof modelProfileSchema>
export type EmbeddingProfile = z.infer<typeof embeddingProfileSchema>

/** DESIGN §4.4 出厂阵容（config.json 可覆盖） */
export const FACTORY_CONFIG: AppConfig = configSchema.parse({
  models: {
    primary: { model: 'deepseek-v4-pro-0813' },
    background: { model: 'deepseek-v4-flash-0731' },
    vision: { model: 'qwen3.8-flash' },
    embedding: { model: 'bge-m3', dimensions: 1024 },
  },
})

export class ConfigError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v
  }
  return out
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('；')
}

/** 读取仓库根 .env（不存在则跳过）；服务器上由 compose env_file 注入，本函数服务于本地开发 */
export function loadDotEnv(envPath: string): void {
  if (!fs.existsSync(envPath)) return
  process.loadEnvFile(envPath)
}

export interface LoadedConfig {
  config: AppConfig
  /** null = 未提供 config.json，完整走出厂默认 */
  configPath: string | null
}

export function loadConfig(dataDir: string): LoadedConfig {
  const configPath = path.join(dataDir, 'config.json')
  const exists = fs.existsSync(configPath)
  let overrides: Record<string, unknown> = {}
  if (exists) {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch (err) {
      throw new ConfigError(`${configPath} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`)
    }
    if (!isPlainObject(parsed)) throw new ConfigError(`${configPath} 顶层必须是一个 JSON 对象`)
    overrides = parsed
  }
  const merged = deepMerge(FACTORY_CONFIG as unknown as Record<string, unknown>, overrides)
  const result = configSchema.safeParse(merged)
  if (!result.success) {
    throw new ConfigError(`配置校验失败（${configPath || '出厂默认'}）：${formatIssues(result.error)}`)
  }
  return { config: result.data, configPath: exists ? configPath : null }
}
