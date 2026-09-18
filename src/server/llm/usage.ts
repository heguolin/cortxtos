import type { DB } from '../db.js'

export type UsagePurpose = 'chat' | 'background' | 'embed' | 'vision'

export interface UsageRow {
  model: string
  purpose: UsagePurpose
  promptTokens?: number
  completionTokens?: number
  costEst?: number | null
}

/** DESIGN §4.4：每次 LLM/嵌入调用强制落一条 UsageRecord */
export function recordUsage(db: DB, row: UsageRow): void {
  db.prepare(
    'INSERT INTO usage_records(model, purpose, prompt_tokens, completion_tokens, cost_est) VALUES (?, ?, ?, ?, ?)',
  ).run(row.model, row.purpose, row.promptTokens ?? 0, row.completionTokens ?? 0, row.costEst ?? null)
}
