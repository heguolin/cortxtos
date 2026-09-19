import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  ChatError,
  ask,
  createSession,
  deleteSession,
  getMessages,
  getSession,
  listSessions,
  retryLast,
  type AskImage,
} from '../chat/service.js'
import type { ServerDeps } from '../types.js'

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const IMAGE_MAX_BYTES = 10 * 1024 * 1024

export function chatRouter(deps: ServerDeps): Hono {
  const r = new Hono()

  r.onError((err, c) => {
    if (err instanceof ChatError) return c.json({ error: err.message }, err.status)
    console.error('[chat]', err)
    return c.json({ error: '内部错误' }, 500)
  })

  r.get('/api/sessions', (c) => c.json({ sessions: listSessions(deps.db) }))

  r.post('/api/sessions', async (c) => {
    const body = await c.req
      .json<{ title?: string }>()
      .catch(() => ({}) as { title?: string })
    return c.json({ session: createSession(deps.db, body.title) }, 201)
  })

  r.get('/api/sessions/:id', (c) => {
    const session = getSession(deps.db, Number(c.req.param('id')))
    return c.json({ session, messages: getMessages(deps.db, session.id) })
  })

  r.delete('/api/sessions/:id', (c) => {
    deleteSession(deps.db, Number(c.req.param('id')))
    return c.body(null, 204)
  })

  // 混合式对话 + SSE：citations → tool* → delta* → done / error
  // 图片问答走 multipart（content + image）；纯文本走 JSON（兼容既有客户端）
  r.post('/api/sessions/:id/messages', async (c) => {
    const chatModel = deps.chatModel
    const embedder = deps.embedder
    if (!chatModel || !embedder) throw new ChatError(503, '对话依赖未就绪（测试环境）')

    const contentType = c.req.header('content-type') ?? ''
    let question = ''
    let image: AskImage | undefined
    if (contentType.includes('multipart/form-data')) {
      const body = await c.req.parseBody().catch(() => {
        throw new ChatError(400, '请求格式错误')
      })
      question = typeof body['content'] === 'string' ? (body['content'] as string).trim() : ''
      const file = body['image']
      if (file instanceof File && file.size > 0) {
        if (!IMAGE_TYPES.has(file.type)) throw new ChatError(400, '仅支持 jpg / png / webp 图片')
        if (file.size > IMAGE_MAX_BYTES) throw new ChatError(400, '图片超过 10MB 上限')
        image = { data: Buffer.from(await file.arrayBuffer()), mimeType: file.type }
      }
    } else {
      const body = await c.req
        .json<{ content?: string }>()
        .catch(() => ({}) as { content?: string })
      question = body.content?.trim() ?? ''
    }
    if (!question) throw new ChatError(400, '缺少 content')

    const session = getSession(deps.db, Number(c.req.param('id')))
    if (session.title === '新会话') {
      deps.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(question.slice(0, 20), session.id)
    }

    const visionModel = deps.visionModel
    const visionApiKey = process.env[deps.visionApiKeyEnv ?? 'LLM_API_KEY']

    const ac = new AbortController()
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => ac.abort())
      let chain: Promise<void> = Promise.resolve()
      let closed = false
      const safeWrite = (event: string, data: unknown) => {
        if (closed) return
        chain = chain
          .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
          .catch(() => {
            closed = true
            ac.abort()
          })
      }

      try {
        const { userMessage, assistantMessage } = await ask(
          {
            db: deps.db,
            embedder,
            chatModel,
            apiKey: process.env[deps.chatApiKeyEnv ?? 'LLM_API_KEY'],
            visionModel,
            visionApiKey,
            vaultDir: deps.vaultDir,
          },
          session.id,
          question,
          {
            signal: ac.signal,
            onContext: (citations) => safeWrite('citations', { citations }),
            onDelta: (text) => safeWrite('delta', { text }),
            onError: (message) => safeWrite('error', { message }),
            onTool: (name, detail) => safeWrite('tool', { name, detail }),
          },
          image,
        )
        await chain
        closed = true
        await stream.writeSSE({
          event: 'done',
          data: JSON.stringify({ userMessage, assistantMessage }),
        })
      } catch (err) {
        await chain.catch(() => {})
        closed = true
        await stream
          .writeSSE({
            event: 'error',
            data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
          })
          .catch(() => {})
      }
    })
  })

  // 重试生成（ADR：会话级换档）：用 background 档对上一条用户消息重跑，原位替换失败回复
  r.post('/api/sessions/:id/retry', async (c) => {
    const chatModel = deps.backgroundModel
    const embedder = deps.embedder
    if (!chatModel || !embedder) throw new ChatError(503, 'background 档未就绪（测试环境或未配置）')
    const session = getSession(deps.db, Number(c.req.param('id')))
    // 在 SSE 头发出前校验（否则错误只能以 200 事件流呈现）
    if (!getMessages(deps.db, session.id).some((m) => m.role === 'user')) {
      throw new ChatError(400, '没有可重试的用户消息')
    }

    const ac = new AbortController()
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => ac.abort())
      let chain: Promise<void> = Promise.resolve()
      let closed = false
      const safeWrite = (event: string, data: unknown) => {
        if (closed) return
        chain = chain
          .then(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
          .catch(() => {
            closed = true
            ac.abort()
          })
      }
      try {
        const { replacedMessage } = await retryLast(
          {
            db: deps.db,
            embedder,
            chatModel,
            apiKey: process.env[deps.chatApiKeyEnv ?? 'LLM_API_KEY'],
            backgroundModel: chatModel,
            backgroundApiKey: process.env[deps.backgroundApiKeyEnv ?? 'LLM_API_KEY'],
            vaultDir: deps.vaultDir,
          },
          session.id,
          {
            signal: ac.signal,
            onContext: (citations) => safeWrite('citations', { citations }),
            onDelta: (text) => safeWrite('delta', { text }),
            onError: (message) => safeWrite('error', { message }),
            onTool: (name, detail) => safeWrite('tool', { name, detail }),
          },
        )
        await chain
        closed = true
        await stream.writeSSE({ event: 'done', data: JSON.stringify({ replacedMessage }) })
      } catch (err) {
        await chain.catch(() => {})
        closed = true
        await stream
          .writeSSE({
            event: 'error',
            data: JSON.stringify({ message: err instanceof Error ? err.message : String(err) }),
          })
          .catch(() => {})
      }
    })
  })

  return r
}
