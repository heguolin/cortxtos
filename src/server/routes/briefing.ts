import { Hono } from 'hono'
import { getJobByName, getRun, listJobs, listRuns } from '../scheduler.js'
import type { ServerDeps } from '../types.js'

export type BriefingStatus = 404 | 503

export class BriefingError extends Error {
  constructor(
    public readonly status: BriefingStatus,
    message: string,
  ) {
    super(message)
  }
}

const BRIEFING_JOB = 'daily-briefing'

export function briefingRouter(deps: ServerDeps): Hono {
  const r = new Hono()

  r.onError((err, c) => {
    if (err instanceof BriefingError) return c.json({ error: err.message }, err.status)
    console.error('[briefing]', err)
    return c.json({ error: '内部错误' }, 500)
  })

  r.get('/api/jobs', (c) => c.json({ jobs: listJobs(deps.db) }))

  // 手动触发（M0 简报页「立即生成」；M1 任务页复用）
  r.post('/api/jobs/:name/run', async (c) => {
    if (!deps.scheduler) throw new BriefingError(503, '调度器未就绪（测试环境）')
    const name = c.req.param('name')
    if (!getJobByName(deps.db, name)) throw new BriefingError(404, '任务不存在')
    const runId = await deps.scheduler.runJob(name)
    return c.json({ ok: true, runId })
  })

  // 简报 = daily-briefing 的运行产物
  r.get('/api/briefings', (c) => {
    const job = getJobByName(deps.db, BRIEFING_JOB)
    if (!job) return c.json({ briefings: [] })
    const runs = listRuns(deps.db, job.id)
    return c.json({
      briefings: runs.map((run) => ({
        id: run.id,
        status: run.status,
        started_at: run.started_at,
        preview: (run.output ?? run.error ?? '').slice(0, 80),
      })),
    })
  })

  r.get('/api/briefings/:id', (c) => {
    const run = getRun(deps.db, Number(c.req.param('id')))
    if (!run) throw new BriefingError(404, '简报不存在')
    return c.json({ briefing: run })
  })

  return r
}
