import { Hono } from 'hono'
import { getJobByName } from '../scheduler.js'
import type { ServerDeps } from '../types.js'

export type DashboardStatus = 503

export class DashboardError extends Error {
  constructor(
    public readonly status: DashboardStatus,
    message: string,
  ) {
    super(message)
  }
}

interface UsageRow {
  purpose: string
  prompt_tokens: number
  completion_tokens: number
  created_at: string
}

/** 今天（仪表盘）聚合数据。时间口径 = 本地时区最近 N 天（JS 侧分组，SQLite 只出原始行） */
export function dashboardRouter(deps: ServerDeps): Hono {
  const r = new Hono()

  r.onError((err, c) => {
    if (err instanceof DashboardError) return c.json({ error: err.message }, err.status)
    console.error('[dashboard]', err)
    return c.json({ error: '内部错误' }, 500)
  })

  r.get('/api/dashboard', (c) => {
    const db = deps.db

    const docsTotal = (db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n
    const docsToday = (
      db
        .prepare("SELECT COUNT(*) AS n FROM documents WHERE updated_at >= datetime('now', '-1 day')")
        .get() as { n: number }
    ).n
    const sessions = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    const activeJobs = (
      db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE enabled = 1').get() as { n: number }
    ).n

    // 近 7 天用量（本地日分组）
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ')
    const usageRows = db
      .prepare('SELECT purpose, prompt_tokens, completion_tokens, created_at FROM usage_records WHERE created_at >= ?')
      .all(since) as UsageRow[]
    const days: Array<{ day: string; chat: number; embed: number; background: number }> = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600 * 1000)
      days.push({
        day: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
        chat: 0,
        embed: 0,
        background: 0,
      })
    }
    const dayKey = (iso: string) => {
      const d = new Date(iso.replace(' ', 'T') + 'Z')
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    let tokensToday = 0
    let tokens24hChat = 0
    const since24h = new Date(Date.now() - 24 * 3600 * 1000)
    for (const row of usageRows) {
      const tokens = row.prompt_tokens + row.completion_tokens
      const created = new Date(row.created_at.replace(' ', 'T') + 'Z')
      const key = dayKey(row.created_at)
      const bucket = days.find((d) => d.day === key)
      const kind = row.purpose === 'chat' || row.purpose === 'vision' ? 'chat' : row.purpose === 'embed' ? 'embed' : 'background'
      if (bucket) bucket[kind] += tokens
      if (created >= since24h) {
        tokensToday += tokens
        if (kind === 'chat') tokens24hChat += tokens
      }
    }

    const recentDocs = db
      .prepare('SELECT id, title, status, updated_at FROM documents ORDER BY updated_at DESC, id DESC LIMIT 5')
      .all()

    // 最新一条成功简报
    const briefingJob = getJobByName(db, 'daily-briefing')
    let latestBriefing: { id: number; started_at: string; output: string } | null = null
    if (briefingJob) {
      const row = db
        .prepare(
          "SELECT id, started_at, output FROM runs WHERE job_id = ? AND status = 'success' ORDER BY id DESC LIMIT 1",
        )
        .get(briefingJob.id) as { id: number; started_at: string; output: string } | undefined
      if (row) latestBriefing = row
    }

    return c.json({
      stats: { docsTotal, docsToday, sessions, activeJobs, tokensToday, tokens24hChat },
      recentDocs,
      latestBriefing,
      usage7d: days,
    })
  })

  return r
}
