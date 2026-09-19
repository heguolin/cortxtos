import { Hono } from 'hono'
import { z } from 'zod'
import { getRun } from '../scheduler.js'
import {
  getJobByName,
  type JobRow,
  type JobSpec,
  listRuns,
} from '../scheduler.js'
import type { ServerDeps } from '../types.js'

export type TaskStatus = 400 | 404 | 503

export class BriefingError extends Error {
  constructor(
    public readonly status: TaskStatus,
    message: string,
  ) {
    super(message)
  }
}

const BRIEFING_JOB = 'daily-briefing'
const SCHEDULE_RE = /^([01]?\d|2[0-3]):[0-5]\d$/

const createTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(40),
  schedule: z.string().regex(SCHEDULE_RE, '须为 HH:mm（如 22:00）'),
  prompt: z.string().trim().min(1).max(4000),
})

const patchTaskSchema = z.strictObject({
  title: z.string().trim().min(1).max(40).optional(),
  schedule: z.string().regex(SCHEDULE_RE, '须为 HH:mm').optional(),
  prompt: z.string().trim().min(1).max(4000).optional(),
  enabled: z.boolean().optional(),
})

export interface JobView {
  id: number
  name: string
  title: string
  schedule: string
  prompt: string | null
  enabled: boolean
  builtin: boolean
  last_run_at: string | null
}

function toView(job: JobRow): JobView {
  let spec: JobSpec = { schedule: '08:00' }
  try {
    spec = JSON.parse(job.spec) as JobSpec
  } catch {
    // 坏 spec 走默认
  }
  return {
    id: job.id,
    name: job.name,
    title: spec.title ?? (job.name === BRIEFING_JOB ? '每日简报' : job.name),
    schedule: spec.schedule ?? '08:00',
    prompt: spec.prompt ?? null,
    enabled: job.enabled === 1,
    builtin: job.name === BRIEFING_JOB,
    last_run_at: job.last_run_at,
  }
}

export function tasksRouter(deps: ServerDeps): Hono {
  const r = new Hono()

  r.onError((err, c) => {
    if (err instanceof BriefingError) return c.json({ error: err.message }, err.status)
    console.error('[tasks]', err)
    return c.json({ error: '内部错误' }, 500)
  })

  r.get('/api/jobs', (c) => {
    const jobs = deps.db.prepare('SELECT * FROM jobs ORDER BY id').all() as JobRow[]
    return c.json({ jobs: jobs.map(toView) })
  })

  // 新建自定义任务
  r.post('/api/jobs', async (c) => {
    const body = createTaskSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) {
      throw new BriefingError(400, body.error.issues.map((i) => i.message).join('；'))
    }
    const { title, schedule, prompt } = body.data
    const name = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const info = deps.db
      .prepare("INSERT INTO jobs(name, kind, spec) VALUES (?, 'cron', ?)")
      .run(name, JSON.stringify({ schedule, prompt, title } satisfies JobSpec))
    const job = deps.db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(info.lastInsertRowid)) as JobRow
    return c.json({ job: toView(job) }, 201)
  })

  // 更新（时间/提示词/开关/改名）
  r.patch('/api/jobs/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const job = deps.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    if (!job) throw new BriefingError(404, '任务不存在')
    const body = patchTaskSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) {
      throw new BriefingError(400, body.error.issues.map((i) => i.message).join('；'))
    }
    const spec: JobSpec = (() => {
      try {
        return JSON.parse(job.spec) as JobSpec
      } catch {
        return { schedule: '08:00' }
      }
    })()
    const next = { ...spec, ...body.data }
    deps.db.prepare("UPDATE jobs SET spec = ?, enabled = ?, last_run_at = last_run_at WHERE id = ?").run(
      JSON.stringify({ schedule: next.schedule, prompt: next.prompt, title: next.title }),
      body.data.enabled === undefined ? job.enabled : body.data.enabled ? 1 : 0,
      id,
    )
    const updated = deps.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow
    return c.json({ job: toView(updated) })
  })

  r.delete('/api/jobs/:id', (c) => {
    const id = Number(c.req.param('id'))
    const job = deps.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    if (!job) throw new BriefingError(404, '任务不存在')
    if (job.name === BRIEFING_JOB) throw new BriefingError(400, '内置任务不可删除（可停用）')
    deps.db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
    return c.body(null, 204)
  })

  // 手动触发：参数兼容 id 与 name
  r.post('/api/jobs/:key/run', async (c) => {
    if (!deps.scheduler) throw new BriefingError(503, '调度器未就绪（测试环境）')
    const key = c.req.param('key')
    const job = /^\d+$/.test(key)
      ? (deps.db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(key)) as JobRow | undefined)
      : getJobByName(deps.db, key)
    if (!job) throw new BriefingError(404, '任务不存在')
    const runId = await deps.scheduler.runJob(job.name)
    return c.json({ ok: true, runId })
  })

  // 全部运行记录（跨任务，新→旧）
  r.get('/api/runs', (c) => {
    const rows = deps.db
      .prepare(
        `SELECT r.*, CASE WHEN j.name = 'daily-briefing' THEN '每日简报'
           ELSE COALESCE(json_extract(j.spec, '$.title'), j.name) END AS job_title,
         j.name AS job_name
         FROM runs r JOIN jobs j ON j.id = r.job_id
         ORDER BY r.id DESC LIMIT 50`,
      )
      .all() as Array<{ id: number; job_title: string; job_name: string; status: string; started_at: string; finished_at: string | null; output: string | null; error: string | null }>
    return c.json({ runs: rows })
  })

  // ===== 简报（保持 M0 兼容） =====
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
