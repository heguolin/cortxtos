import type { DB } from './db.js'

export interface JobRow {
  id: number
  name: string
  kind: 'cron' | 'manual'
  spec: string
  enabled: number
  last_run_at: string | null
  created_at: string
}

export interface RunRow {
  id: number
  job_id: number
  status: 'running' | 'success' | 'failed'
  started_at: string
  finished_at: string | null
  output: string | null
  error: string | null
}

export function getJobByName(db: DB, name: string): JobRow | undefined {
  return db.prepare('SELECT * FROM jobs WHERE name = ?').get(name) as JobRow | undefined
}

export function listJobs(db: DB): JobRow[] {
  return db.prepare('SELECT * FROM jobs ORDER BY id').all() as JobRow[]
}

export function listRuns(db: DB, jobId: number): RunRow[] {
  return db.prepare('SELECT * FROM runs WHERE job_id = ? ORDER BY id DESC').all(jobId) as RunRow[]
}

export function getRun(db: DB, runId: number): RunRow | undefined {
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined
}

/** 本地时区日期串（YYYY-MM-DD），用于「今天是否已跑」判定 */
export function localDateStr(d = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 本地 HH:mm */
export function localHM(d = new Date()): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 上次触发的本地日期；null = 从未跑过 */
export function lastRunLocalDate(db: DB, jobId: number): string | null {
  const row = db
    .prepare('SELECT started_at FROM runs WHERE job_id = ? ORDER BY id DESC LIMIT 1')
    .get(jobId) as { started_at: string } | undefined
  if (!row) return null
  // started_at 为 SQLite UTC 'YYYY-MM-DD HH:MM:SS' → 转本地日期
  const d = new Date(row.started_at.replace(' ', 'T') + 'Z')
  return localDateStr(d)
}

export interface JobSpec {
  schedule: string
  /** 自定义任务的提示词（内置 daily-briefing 无此字段） */
  prompt?: string
  /** 展示名（自定义任务用；内置任务用默认名） */
  title?: string
}

/** 任务执行器：由上层按 job 分派（内置简报 / 自定义提示词任务） */
export type JobExecutor = (job: JobRow) => Promise<string>

/**
 * 进程内 cron（分钟粒度 tick，DESIGN §4.3）。
 * 错过点位（宕机/重启）当天补跑一次；重复触发由「当天已跑」判定挡住。
 * schedule 变更即时生效（每 tick 重读 spec）。
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(
    private readonly db: DB,
    private readonly executor: JobExecutor,
  ) {}

  /** 内置任务种子（幂等）：daily-briefing，schedule 取 config */
  static seedDailyBriefing(db: DB, schedule: string): void {
    db.prepare('INSERT OR IGNORE INTO jobs(name, kind, spec) VALUES (?, ?, ?)').run(
      'daily-briefing',
      'cron',
      JSON.stringify({ schedule } satisfies JobSpec),
    )
  }

  start(): void {
    this.stop()
    this.timer = setInterval(() => void this.tickNow(), 30_000)
    void this.tickNow()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 一轮调度检查（public 供测试直接驱动） */
  async tickNow(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const jobs = this.db.prepare("SELECT * FROM jobs WHERE enabled = 1 AND kind = 'cron'").all() as JobRow[]
      const today = localDateStr()
      for (const job of jobs) {
        let schedule = '08:00'
        try {
          schedule = (JSON.parse(job.spec) as JobSpec).schedule ?? '08:00'
        } catch {
          // 坏 spec 走默认
        }
        if (localHM() >= schedule && lastRunLocalDate(this.db, job.id) !== today) {
          void this.runJob(job.name).catch(() => {})
        }
      }
    } finally {
      this.running = false
    }
  }

  /** 手动/调度共用的执行入口：建 run → 执行 → 落 output/error。返回 runId。 */
  async runJob(name: string): Promise<number> {
    const job = getJobByName(this.db, name)
    if (!job) throw new Error(`任务不存在: ${name}`)
    const info = this.db
      .prepare("INSERT INTO runs(job_id, status) VALUES (?, 'running')")
      .run(job.id)
    const runId = Number(info.lastInsertRowid)
    try {
      const output = await this.executor(job)
      this.db
        .prepare("UPDATE runs SET status = 'success', finished_at = datetime('now'), output = ? WHERE id = ?")
        .run(output, runId)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[scheduler] 任务 ${name} 失败: ${message}`)
      this.db
        .prepare("UPDATE runs SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?")
        .run(message, runId)
    }
    this.db.prepare("UPDATE jobs SET last_run_at = datetime('now') WHERE id = ?").run(job.id)
    return runId
  }
}
