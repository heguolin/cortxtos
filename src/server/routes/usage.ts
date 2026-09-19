import { Hono } from 'hono'
import type { ServerDeps } from '../types.js'

export class UsageError extends Error {
  constructor(
    public readonly status: 400,
    message: string,
  ) {
    super(message)
  }
}

interface RawRow {
  model: string
  purpose: string
  prompt_tokens: number
  completion_tokens: number
  created_at: string
}

const KIND = (purpose: string): 'chat' | 'background' | 'embed' | 'vision' =>
  purpose === 'chat' ? 'chat' : purpose === 'embed' ? 'embed' : purpose === 'vision' ? 'vision' : 'background'

/** 用量明细页（v2.3）：全量 usage_records 按本地日聚合，只记 token 不折算钱 */
export function usageRouter(deps: ServerDeps): Hono {
  const r = new Hono()

  r.onError((err, c) => {
    if (err instanceof UsageError) return c.json({ error: err.message }, err.status)
    console.error('[usage]', err)
    return c.json({ error: '内部错误' }, 500)
  })

  r.get('/api/usage', (c) => {
    const days = Number(c.req.query('days') ?? 7)
    if (![7, 30].includes(days)) throw new UsageError(400, 'days 仅支持 7 或 30')

    const since = new Date(Date.now() - days * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ')
    const rows = deps.db
      .prepare(
        'SELECT model, purpose, prompt_tokens, completion_tokens, created_at FROM usage_records WHERE created_at >= ? ORDER BY id DESC',
      )
      .all(since) as RawRow[]

    const daily: Array<{ day: string; chat: number; background: number; embed: number; vision: number }> = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000)
      daily.push({
        day: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        chat: 0,
        background: 0,
        embed: 0,
        vision: 0,
      })
    }
    const dayKey = (iso: string) => {
      const d = new Date(iso.replace(' ', 'T') + 'Z')
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    const summary = { total: 0, chat: 0, background: 0, embed: 0, vision: 0 }
    const byModel = new Map<string, number>()
    for (const row of rows) {
      const tokens = row.prompt_tokens + row.completion_tokens
      const kind = KIND(row.purpose)
      summary.total += tokens
      summary[kind] += tokens
      byModel.set(row.model, (byModel.get(row.model) ?? 0) + tokens)
      const bucket = daily.find((d) => d.day === dayKey(row.created_at))
      if (bucket) bucket[kind] += tokens
    }
    const models = [...byModel.entries()]
      .map(([model, tokens]) => ({ model, tokens }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 10)

    const records = rows.slice(0, 100).map((r) => ({
      model: r.model,
      purpose: KIND(r.purpose),
      tokens: r.prompt_tokens + r.completion_tokens,
      created_at: r.created_at,
    }))

    return c.json({ days, summary, models, daily, records })
  })

  return r
}
