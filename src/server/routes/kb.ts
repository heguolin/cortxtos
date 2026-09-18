import { Hono } from 'hono'
import {
  KbError,
  deleteDocument,
  getDocument,
  listDocuments,
  readDocumentFile,
  saveMarkdownEdit,
  uploadDocument,
} from '../kb/service.js'
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
    return c.json({ document })
  })

  r.delete('/api/documents/:id', (c) => {
    deleteDocument(deps.db, deps.vaultDir, Number(c.req.param('id')))
    return c.body(null, 204)
  })

  return r
}
