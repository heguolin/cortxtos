import { Hono } from 'hono'
import {
  KbError,
  deleteDocument,
  findDocumentByUrl,
  getDocument,
  listDocuments,
  normalizeTags,
  readDocumentFile,
  reindexAll,
  saveMarkdownEdit,
  setTags,
  uploadDocument,
} from '../kb/service.js'
import { hybridSearch } from '../kb/search.js'
import {
  WebCaptureError,
  buildCaptureMarkdown,
  captureUrlPage,
  extractBareUrl,
} from '../kb/webcapture.js'
import type { ServerDeps } from '../types.js'

/** tags 列是 JSON 字符串，API 边界统一解析为数组（脏数据降级空数组） */
function withTags<D extends { tags: string }>(doc: D): Omit<D, 'tags'> & { tags: string[] } {
  try {
    return { ...doc, tags: (JSON.parse(doc.tags || '[]') as string[]) ?? [] }
  } catch {
    return { ...doc, tags: [] }
  }
}

export function kbRouter(deps: ServerDeps): Hono {
  const r = new Hono()

  r.onError((err, c) => {
    if (err instanceof KbError) return c.json({ error: err.message }, err.status)
    if (err instanceof WebCaptureError) return c.json({ error: err.message }, err.status)
    console.error('[kb]', err)
    return c.json({ error: '内部错误' }, 500)
  })

  r.get('/api/documents', (c) => {
    const documents = listDocuments(deps.db, {
      q: c.req.query('q'),
      tag: c.req.query('tag'),
    })
    return c.json({ documents: documents.map(withTags) })
  })

  // 打标签（v2.3 知识库组织）
  r.patch('/api/documents/:id/tags', async (c) => {
    const body = await c.req
      .json<{ tags?: unknown }>()
      .catch(() => ({}) as { tags?: unknown })
    const tags = normalizeTags(body.tags)
    const document = setTags(deps.db, Number(c.req.param('id')), tags)
    return c.json({ document: withTags(document) })
  })

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
    return new Response(new Uint8Array(bytes), {
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

  // 快速捕获：裸 URL 走网页捕获管线（DESIGN §4.5）；纯文本/Markdown 直接入库（DESIGN v2.2），首行作标题
  r.post('/api/documents/capture', async (c) => {
    const body = await c.req
      .json<{ text?: string }>()
      .catch(() => ({}) as { text?: string })
    const text = body.text?.trim()
    if (!text) throw new KbError(400, '内容不能为空')
    if (text.length > 50_000) throw new KbError(413, '内容超过 50000 字上限')
    if (!deps.indexer) throw new KbError(503, '索引器未就绪（测试环境）')

    if (extractBareUrl(text)) {
      const page = await captureUrlPage(text)
      const content = buildCaptureMarkdown(page)
      const bytes = new TextEncoder().encode(content)
      const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')

      // ADR 0005：URL 为业务身份——同 URL 已在库 → 幂等或覆盖（标签保留）
      const existing = findDocumentByUrl(deps.db, page.url)
      if (existing) {
        if (existing.sha256 === sha) {
          return c.json({ document: existing, duplicate: true, captured: true }, 200 as const)
        }
        const tags = existing.tags
        deleteDocument(deps.db, deps.vaultDir, existing.id)
        const result = uploadDocument(deps.db, deps.vaultDir, {
          name: `${page.title}.md`,
          bytes,
          url: page.url,
        })
        if (tags !== '[]') {
          try {
            setTags(deps.db, result.document.id, JSON.parse(tags) as string[])
          } catch {
            // 旧标签数据异常时不阻断覆盖
          }
        }
        deps.indexer.enqueue(result.document.id)
        return c.json({ document: result.document, overwritten: true, captured: true }, 200 as const)
      }

      const result = uploadDocument(deps.db, deps.vaultDir, {
        name: `${page.title}.md`,
        bytes,
        url: page.url,
      })
      if (!result.duplicate) deps.indexer.enqueue(result.document.id)
      return c.json(
        { document: result.document, duplicate: result.duplicate, captured: true },
        result.duplicate ? (200 as const) : (201 as const),
      )
    }

    const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? ''
    const title = firstLine.replace(/^#+\s*/, '').replace(/[\\/:*?"<>|]/g, ' ').slice(0, 40) ||
      `捕获 ${new Date().toLocaleString('zh-CN', { hour12: false })}`
    const result = uploadDocument(deps.db, deps.vaultDir, {
      name: `${title}.md`,
      bytes: new TextEncoder().encode(text),
    })
    if (!result.duplicate) deps.indexer.enqueue(result.document.id)
    return c.json(
      { document: result.document, duplicate: result.duplicate },
      result.duplicate ? (200 as const) : (201 as const),
    )
  })

  r.delete('/api/documents/:id', (c) => {
    deleteDocument(deps.db, deps.vaultDir, Number(c.req.param('id')))
    return c.body(null, 204)
  })

  return r
}
