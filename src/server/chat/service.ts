import { requireApiKey, streamChat, type ChatModel } from '../llm/chat.js'
import { recordUsage } from '../llm/usage.js'
import { hybridSearch, type Hit } from '../kb/search.js'
import type { EmbeddingClient } from '../llm/embedder.js'
import type { AssistantMessage, Context, Message, UserMessage } from '@earendil-works/pi-ai'
import type { DB } from '../db.js'

/** DESIGN §4.2：M0 固定管线，聊天固定 primary，不自动降级；上下文 = 最近 12 轮 + 检索结果 */
const HISTORY_TURNS = 12
const SEARCH_LIMIT = 6

export interface SessionRow {
  id: number
  title: string
  created_at: string
  updated_at: string
}

export interface StoredMessage {
  id: number
  session_id: number
  role: 'user' | 'assistant'
  content: string
  citations: Citation[]
  model: string | null
  usage: { promptTokens: number; completionTokens: number } | null
  created_at: string
}

export interface Citation {
  n: number
  documentId: number
  title: string
  page: number | null
  headingPath: string | null
}

export class ChatError extends Error {
  constructor(
    public readonly status: ChatStatus,
    message: string,
  ) {
    super(message)
  }
}

export type ChatStatus = 400 | 404 | 503

export function createSession(db: DB, title?: string): SessionRow {
  return db
    .prepare('INSERT INTO sessions(title) VALUES (?) RETURNING *')
    .get(title?.trim() || '新会话') as SessionRow
}

export function listSessions(db: DB): SessionRow[] {
  return db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC, id DESC').all() as SessionRow[]
}

function toStoredMessage(r: {
  id: number
  session_id: number
  role: 'user' | 'assistant'
  content: string
  citations: string | null
  model: string | null
  usage: string | null
  created_at: string
}): StoredMessage {
  let citations: Citation[] = []
  let usage: StoredMessage['usage'] = null
  try {
    citations = r.citations ? (JSON.parse(r.citations) as Citation[]) : []
    usage = r.usage ? (JSON.parse(r.usage) as NonNullable<StoredMessage['usage']>) : null
  } catch {
    // 脏数据降级为空
  }
  return { ...r, citations, usage }
}

export function getSession(db: DB, id: number): SessionRow {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
  if (!row) throw new ChatError(404, '会话不存在')
  return row
}

export function getMessages(db: DB, sessionId: number): StoredMessage[] {
  return (
    db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id').all(sessionId) as Parameters<
      typeof toStoredMessage
    >[0][]
  ).map(toStoredMessage)
}

export function deleteSession(db: DB, id: number): void {
  getSession(db, id)
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

function touchSession(db: DB, id: number): void {
  db.prepare("UPDATE sessions SET updated_at = datetime('now') WHERE id = ?").run(id)
}

function insertMessage(
  db: DB,
  sessionId: number,
  role: 'user' | 'assistant',
  content: string,
  citations: Citation[],
  model: string | null,
  usage: { promptTokens: number; completionTokens: number } | null,
): StoredMessage {
  const info = db
    .prepare(
      'INSERT INTO messages(session_id, role, content, citations, model, usage) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(sessionId, role, content, JSON.stringify(citations), model, usage ? JSON.stringify(usage) : null)
  touchSession(db, sessionId)
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid)) as Parameters<
    typeof toStoredMessage
  >[0]
  return toStoredMessage(row)
}

const SYSTEM_PROMPT = `你是 CortxtOS，运行在用户自托管服务器上的个人知识库助手。
规则：
1. 优先依据提供的「检索到的知识库片段」回答问题。
2. 来自知识库的事实性陈述必须标注引用编号，如 [1]、[2]，编号对应片段开头的标号。
3. 片段不足以回答时如实说明，不要编造。
4. 用简体中文回答，风格简洁直接。`

function citationOf(hit: Hit, n: number): Citation {
  return { n, documentId: hit.documentId, title: hit.title, page: hit.page, headingPath: hit.headingPath }
}

function syntheticAssistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'cortxt',
    model: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

function buildContext(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  hits: Hit[],
  question: string,
): { context: Context; citations: Citation[] } {
  const citations = hits.map((h, i) => citationOf(h, i + 1))
  const contextBlock =
    hits.length > 0
      ? `检索到的知识库片段：\n${hits
          .map((h, i) => {
            const where = [h.page != null ? `第${h.page}页` : null, h.headingPath].filter(Boolean).join(' · ')
            return `[${i + 1}] （${h.title}${where ? ` · ${where}` : ''}）\n${h.text}`
          })
          .join('\n\n')}`
      : '（本次检索没有命中知识库内容。如仍需给出事实，请说明它不来自知识库。）'

  const messages: Message[] = [
    ...history.slice(-HISTORY_TURNS).map((m) =>
      m.role === 'user'
        ? ({ role: 'user', content: m.content, timestamp: Date.now() } satisfies UserMessage)
        : syntheticAssistant(m.content),
    ),
    { role: 'user', content: `${contextBlock}\n\n---\n\n用户问题：${question}`, timestamp: Date.now() },
  ]
  return { context: { systemPrompt: SYSTEM_PROMPT, messages }, citations }
}

export interface AskDeps {
  db: DB
  embedder: EmbeddingClient
  chatModel: ChatModel
  apiKey?: string
}

export interface AskCallbacks {
  onContext?: (citations: Citation[]) => void
  onDelta?: (text: string) => void
  onError?: (message: string) => void
}

/** 固定管线：检索 → 注入 → 流式回答 → 落库 + 记账。返回最终 assistant 消息（可能带 errorMessage）。 */
export async function ask(
  deps: AskDeps,
  sessionId: number,
  question: string,
  cb: AskCallbacks = {},
): Promise<{ userMessage: StoredMessage; assistantMessage: StoredMessage | null }> {
  const userMessage = insertMessage(deps.db, sessionId, 'user', question, [], null, null)

  const historyRows = getMessages(deps.db, sessionId)
    .slice(0, -1)
    .map((m) => ({ role: m.role, content: m.content }))

  let hits: Hit[] = []
  try {
    hits = await hybridSearch(deps.db, deps.embedder, question, { limit: SEARCH_LIMIT })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cb.onError?.(message)
    const assistantMessage = insertMessage(deps.db, sessionId, 'assistant', `检索失败：${message}`, [], null, null)
    return { userMessage, assistantMessage }
  }
  const { context, citations } = buildContext(historyRows, hits, question)
  cb.onContext?.(citations)

  let partial = ''
  let usage: { promptTokens: number; completionTokens: number } | null = null
  let lastError: string | undefined
  try {
    const result = await streamChat(deps.chatModel, context, {
      apiKey: requireApiKey(deps.apiKey),
      onDelta: (t) => {
        partial += t
        cb.onDelta?.(t)
      },
    })
    partial = result.text
    usage = result.usage
    // 用户主动停止不算失败；其余错误显式上报（DESIGN §4.2：不静默降级）
    if (result.errorMessage && !result.aborted) lastError = result.errorMessage
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
  }

  if (lastError) {
    cb.onError?.(lastError)
    const content = partial.trim() ? `${partial}\n\n（生成中断：${lastError}）` : `生成失败：${lastError}`
    const assistantMessage = insertMessage(
      deps.db,
      sessionId,
      'assistant',
      content,
      citations,
      deps.chatModel.id,
      null,
    )
    return { userMessage, assistantMessage }
  }

  if (usage) {
    recordUsage(deps.db, {
      model: deps.chatModel.id,
      purpose: 'chat',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    })
  }
  const assistantMessage = insertMessage(
    deps.db,
    sessionId,
    'assistant',
    partial.trim() || '（空回复）',
    citations,
    deps.chatModel.id,
    usage,
  )
  return { userMessage, assistantMessage }
}
