import { Hono } from 'hono'
import fs from 'node:fs'
import path from 'node:path'
import { KbError, listDocuments, getDocument } from '../kb/service.js'
import { hybridSearch } from '../kb/search.js'
import { getJobByName, listRuns } from '../scheduler.js'
import type { ServerDeps } from '../types.js'

export type PublicStatus = 400 | 404 | 503

export class PublicError extends Error {
  constructor(
    public readonly status: PublicStatus,
    message: string,
  ) {
    super(message)
  }
}

/**
 * 公开只读路由（挂载于鉴权守卫之前）：
 * 所有人可浏览知识库（列表/内容/搜索）与简报；一切写操作与 AI 使用仍需登录（DESIGN v2.4.3）。
 */
export function publicRouter(deps: ServerDeps): Hono {
  const r = new Hono()

  r.onError((err, c) => {
    if (err instanceof KbError) return c.json({ error: err.message }, err.status)
    if (err instanceof PublicError) return c.json({ error: err.message }, err.status)
    console.error('[public]', err)
    return c.json({ error: '内部错误' }, 500)
  })

  // 知识库列表（含 q/tag 筛选）
  r.get('/api/documents', (c) => {
    const documents = listDocuments(deps.db, {
      q: c.req.query('q'),
      tag: c.req.query('tag'),
    })
    return c.json({ documents: documents.map(withTags) })
  })

  // 文档元信息
  r.get('/api/documents/:id', (c) => {
    const doc = getDocument(deps.db, Number(c.req.param('id')))
    if (!doc) throw new KbError(404, '文档不存在')
    return c.json({ document: withTags(doc) })
  })

  // 文档原始内容（md 阅读 / PDF 原生预览）
  r.get('/api/documents/:id/raw', (c) => {
    const doc = getDocument(deps.db, Number(c.req.param('id')))
    if (!doc) throw new KbError(404, '文档不存在')
    const p = path.join(deps.vaultDir, doc.source)
    if (!fs.existsSync(p)) throw new KbError(410, '源文件已丢失（Vault 与索引不一致），可删除后重新上传')
    const bytes = fs.readFileSync(p)
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': `${doc.mime}; charset=utf-8`,
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(doc.title)}`,
        'cache-control': 'no-store',
      },
    })
  })

  // 库内检索（只读；每次消耗一条嵌入调用）
  r.get('/api/search', async (c) => {
    const q = c.req.query('q')?.trim() ?? ''
    if (!q) throw new PublicError(400, '缺少 q 参数')
    if (!deps.embedder) throw new PublicError(503, '嵌入客户端未就绪（测试环境）')
    const limit = Number(c.req.query('limit') ?? 6)
    const hits = await hybridSearch(deps.db, deps.embedder, q, {
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 20) : 6,
    })
    return c.json({ hits })
  })

  // 简报（只读）
  const BRIEFING_JOB = 'daily-briefing'
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
    const run = deps.db
      .prepare('SELECT * FROM runs WHERE id = ?')
      .get(Number(c.req.param('id'))) as
      | { id: number; status: string; started_at: string; finished_at: string | null; output: string | null; error: string | null }
      | undefined
    if (!run) throw new PublicError(404, '简报不存在')
    return c.json({ briefing: run })
  })

  return r
}

/** tags 列是 JSON 字符串，API 边界统一解析为数组（脏数据降级空数组） */
function withTags<D extends { tags: string }>(doc: D): Omit<D, 'tags'> & { tags: string[] } {
  try {
    return { ...doc, tags: (JSON.parse(doc.tags || '[]') as string[]) ?? [] }
  } catch {
    return { ...doc, tags: [] }
  }
}
