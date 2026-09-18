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
} from '../chat/service.js'
import type { ServerDeps } from '../types.js'

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

  // 固定管线 + SSE：citations → delta* → done / error
  r.post('/api/sessions/:id/messages', async (c) => {
    const chatModel = deps.chatModel
    const embedder = deps.embedder
    if (!chatModel || !embedder) throw new ChatError(503, '对话依赖未就绪（测试环境）')
    const body = await c.req
      .json<{ content?: string }>()
      .catch(() => ({}) as { content?: string })
    const question = body.content?.trim()
    if (!question) throw new ChatError(400, '缺少 content')
    const session = getSession(deps.db, Number(c.req.param('id')))
    if (session.title === '新会话') {
      deps.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(question.slice(0, 20), session.id)
    }

    const ac = new AbortController()
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => ac.abort())
      // 串行化 delta 写入，保证 SSE 顺序
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
          },
          session.id,
          question,
          {
            onContext: (citations) => safeWrite('citations', { citations }),
            onDelta: (text) => safeWrite('delta', { text }),
            onError: (message) => safeWrite('error', { message }),
          },
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

  return r
}
