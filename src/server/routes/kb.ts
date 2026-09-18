import { Hono } from 'hono'
import {
  KbError,
  deleteDocument,
  getDocument,
  listDocuments,
  readDocumentFile,
  reindexAll,
  saveMarkdownEdit,
  uploadDocument,
} from '../kb/service.js'
import { hybridSearch } from '../kb/search.js'
import type { ServerDeps } from '../types.js'

export function kbRouter(deps: ServerDeps): Hono {
  const r = new Hono()

  r.onError((err, c) => {
    if (err instanceof KbError) return c.json({ error: err.message }, err.status)
    console.error('[kb]', err)
    return c.json({ error: '内部错误' }, 500)
  })

  r.get('/api/documents', (c) => c.json({ documents: listDocuments(deps.db) }))

  r.post('/api/documents', async (c) => {
    const body = await c.req.parseBody().catch(() => {
      throw new KbError(400, '请求须为 multipart/form-data')
    })
    const file = body['file']
    if (!(file instanceof File)) throw new KbError(400, '缺少 file 字段')
    const bytes = new Uint8Array(await file.arrayBuffer())
    const result = uploadDocument(deps.db, deps.vaultDir, { name: file.name, bytes })
    if (!result.duplicate) deps.indexer?.enqueue(result.document.id)
    return c.json(result, result.duplicate ? (200 as const) : (201 as const))
  })

  r.get('/api/documents/:id', (c) => {
    const doc = getDocument(deps.db, Number(c.req.param('id')))
    if (!doc) throw new KbError(404, '文档不存在')
    return c.json({ document: doc })
  })

  // 原始文件：md 预览与 PDF 原生预览（票 06 引用跳转用）
  r.get('/api/documents/:id/raw', (c) => {
    const { document, bytes } = readDocumentFile(deps.db, deps.vaultDir, Number(c.req.param('id')))
    return new Response(bytes, {
      headers: {
        'content-type': `${document.mime}; charset=utf-8`,
        'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(document.title)}`,
        'cache-control': 'no-store',
      },
    })
  })

  r.put('/api/documents/:id', async (c) => {
    const body = await c.req
      .json<{ content?: string }>()
      .catch(() => ({}) as { content?: string })
    if (typeof body.content !== 'string') throw new KbError(400, '缺少 content 字段')
    const document = saveMarkdownEdit(deps.db, deps.vaultDir, Number(c.req.param('id')), body.content)
    deps.indexer?.enqueue(document.id)
    return c.json({ document })
  })

  // 失败重试 / 手动重建索引
  r.post('/api/documents/:id/reindex', (c) => {
    const id = Number(c.req.param('id'))
    if (!getDocument(deps.db, id)) throw new KbError(404, '文档不存在')
    if (!deps.indexer) throw new KbError(503, '索引器未就绪（测试环境）')
    deps.indexer.enqueue(id)
    return c.json({ ok: true, queued: true }, 202)
  })

  // 全量重建：收编孤儿文件 + 全部回 queued + 入队（票 05）
  r.post('/api/documents/reindex-all', (c) => {
    if (!deps.indexer) throw new KbError(503, '索引器未就绪（测试环境）')
    const count = reindexAll(deps.db, deps.vaultDir)
    deps.indexer.recover()
    return c.json({ ok: true, queued: count }, 202)
  })

  // 检索测试口（票 06 的对话固定管线复用同一函数）
  r.get('/api/search', async (c) => {
    const q = c.req.query('q')?.trim() ?? ''
    if (!q) throw new KbError(400, '缺少 q 参数')
    if (!deps.embedder) throw new KbError(503, '嵌入客户端未就绪（测试环境）')
    const limit = Number(c.req.query('limit') ?? 6)
    const hits = await hybridSearch(deps.db, deps.embedder, q, {
      limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 20) : 6,
    })
    return c.json({ hits })
  })

  r.delete('/api/documents/:id', (c) => {
    deleteDocument(deps.db, deps.vaultDir, Number(c.req.param('id')))
    return c.body(null, 204)
  })

  return r
}
