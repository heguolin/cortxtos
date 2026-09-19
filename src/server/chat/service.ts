import { Type } from '@earendil-works/pi-ai'
import { runAgentLoop, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Context, Message, UserMessage } from '@earendil-works/pi-ai'
import { requireApiKey, streamChat, type ChatModel } from '../llm/chat.js'
import { recordUsage } from '../llm/usage.js'
import { hybridSearch, type Hit } from '../kb/search.js'
import { readDocumentFile, getDocument } from '../kb/service.js'
import { extractPages } from '../kb/extract.js'
import type { EmbeddingClient } from '../llm/embedder.js'
import type { DB } from '../db.js'

/** DESIGN v2.2：M1 起固定管线打底 + 工具深挖（混合式）；图片走 vision 档当轮对话不入库 */
const HISTORY_TURNS = 12
const SEARCH_LIMIT = 6
const TOOL_BUDGET = 8
const KB_READ_MAX_CHARS = 6000

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

export type ChatStatus = 400 | 404 | 503

export class ChatError extends Error {
  constructor(
    public readonly status: ChatStatus,
    message: string,
  ) {
    super(message)
  }
}

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

const SYSTEM_PROMPT_AGENT = `${SYSTEM_PROMPT}
5. 你还有知识库工具可用：固定检索不够时，可用 kb_search 换关键词补检索、kb_read 通读某篇文档（可指定页）、kb_list 浏览文档清单；工具结果里的事实按「（文档名）」形式标注来源。不需要工具就直接回答。`

function citationOf(hit: Hit, n: number): Citation {
  return { n, documentId: hit.documentId, title: hit.title, page: hit.page, headingPath: hit.headingPath }
}

function contextBlockOf(hits: Hit[]): string {
  return hits.length > 0
    ? `检索到的知识库片段：\n${hits
        .map((h, i) => {
          const where = [h.page != null ? `第${h.page}页` : null, h.headingPath].filter(Boolean).join(' · ')
          return `[${i + 1}] （${h.title}${where ? ` · ${where}` : ''}）\n${h.text}`
        })
        .join('\n\n')}`
    : '（本次检索没有命中知识库内容。如仍需给出事实，请说明它不来自知识库。）'
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

/** 深挖工具集（DESIGN v2.2 三个，克制）：补检索 / 读文档 / 列清单。工具调用有总预算护栏。 */
function buildKbTools(
  deps: { db: DB; embedder: EmbeddingClient; vaultDir: string },
  cb: { onTool: (name: string, detail: string) => void },
): AgentTool[] {
  let budget = 0
  const overBudget = (): boolean => {
    budget += 1
    return budget > TOOL_BUDGET
  }
  const budgetResult = () => ({
    content: [{ type: 'text' as const, text: '已达到工具调用上限，请直接基于现有信息回答。' }],
    details: {},
    terminate: true,
  })

  const kbSearchParams = Type.Object({ query: Type.String({ description: '检索关键词' }) })
  const kbSearch: AgentTool<typeof kbSearchParams> = {
    name: 'kb_search',
    label: '补充检索',
    description: '用新的关键词再检索一次知识库，返回相关片段',
    parameters: kbSearchParams,
    execute: async (_id, params) => {
      cb.onTool('kb_search', params.query)
      if (overBudget()) return budgetResult()
      const hits = await hybridSearch(deps.db, deps.embedder, params.query, { limit: SEARCH_LIMIT })
      const text =
        hits.length > 0
          ? hits
              .map((h, i) => {
                const where = [h.page != null ? `第${h.page}页` : null, h.headingPath].filter(Boolean).join(' · ')
                return `[${i + 1}] （${h.title}${where ? ` · ${where}` : ''}）\n${h.text}`
              })
              .join('\n\n')
          : '没有命中任何内容。'
      return { content: [{ type: 'text', text }], details: { hits: hits.length } }
    },
  }

  const kbReadParams = Type.Object({
    documentId: Type.Number({ description: '文档 ID（来自检索结果或 kb_list）' }),
    page: Type.Optional(Type.Number({ description: '可选，只读该页（PDF）' })),
  })
  const kbRead: AgentTool<typeof kbReadParams> = {
    name: 'kb_read',
    label: '读文档',
    description: '读取知识库中指定文档的内容（可指定页码），用于深入理解全文',
    parameters: kbReadParams,
    execute: async (_id, params) => {
      const doc = getDocument(deps.db, params.documentId)
      const label = doc ? `${doc.title}${params.page != null ? ` 第${params.page}页` : ''}` : `#${params.documentId}`
      cb.onTool('kb_read', label)
      if (overBudget()) return budgetResult()
      if (!doc) return { content: [{ type: 'text', text: `文档 #${params.documentId} 不存在。` }], details: {} }
      const { bytes } = readDocumentFile(deps.db, deps.vaultDir, doc.id)
      let pages = await extractPages(doc.mime, bytes)
      if (params.page != null) {
        pages = pages.filter((p) => p.page === params.page)
        if (pages.length === 0) {
          return { content: [{ type: 'text', text: `${doc.title} 中没有第 ${params.page} 页。` }], details: {} }
        }
      }
      const text = pages
        .map((p) => (p.page != null ? `【第 ${p.page} 页】\n${p.text}` : p.text))
        .join('\n\n')
        .slice(0, KB_READ_MAX_CHARS)
      return {
        content: [{ type: 'text', text: `（${doc.title}）\n${text}${text.length >= KB_READ_MAX_CHARS ? '\n…(内容过长已截断)' : ''}` }],
        details: { documentId: doc.id },
      }
    },
  }

  const kbListParams = Type.Object({})
  const kbList: AgentTool<typeof kbListParams> = {
    name: 'kb_list',
    label: '文档清单',
    description: '列出知识库中的全部文档（标题与状态）',
    parameters: kbListParams,
    execute: async () => {
      cb.onTool('kb_list', '浏览文档列表')
      if (overBudget()) return budgetResult()
      const rows = deps.db.prepare('SELECT id, title FROM documents ORDER BY id DESC LIMIT 100').all() as Array<{
        id: number
        title: string
      }>
      const text = rows.length > 0 ? rows.map((r) => `#${r.id} ${r.title}`).join('\n') : '知识库为空。'
      return { content: [{ type: 'text', text }], details: { count: rows.length } }
    },
  }

  return [kbSearch, kbRead, kbList]
}

export interface AskImage {
  data: Buffer
  mimeType: string
}

export interface AskDeps {
  db: DB
  embedder: EmbeddingClient
  chatModel: ChatModel
  apiKey?: string
  /** vision 档（图片问答用）；未配置则图片请求报 503 */
  visionModel?: ChatModel | null
  visionApiKey?: string
  vaultDir: string
}

export interface AskCallbacks {
  onContext?: (citations: Citation[]) => void
  onDelta?: (text: string) => void
  onError?: (message: string) => void
  onTool?: (name: string, detail: string) => void
  signal?: AbortSignal
}

/** 持久化 assistant 消息：replaceId 存在则原位更新（重试生成），否则插入 */
function persistAssistant(
  deps: AskDeps,
  sessionId: number,
  replaceId: number | null,
  content: string,
  citations: Citation[],
  modelId: string | null,
  usage: { promptTokens: number; completionTokens: number } | null,
): StoredMessage {
  if (replaceId) {
    deps.db
      .prepare('UPDATE messages SET content = ?, citations = ?, model = ?, usage = ? WHERE id = ?')
      .run(content, JSON.stringify(citations), modelId, usage ? JSON.stringify(usage) : null, replaceId)
    touchSession(deps.db, sessionId)
    const row = deps.db.prepare('SELECT * FROM messages WHERE id = ?').get(replaceId) as Parameters<
      typeof toStoredMessage
    >[0]
    return toStoredMessage(row)
  }
  return insertMessage(deps.db, sessionId, 'assistant', content, citations, modelId, usage)
}

/** 生成核心：检索之后的「生成 + 失败落库/替换 + 记账」共用段（ask 与重试生成共用） */
async function generateCore(
  deps: AskDeps,
  sessionId: number,
  question: string,
  opts: {
    model: ChatModel
    apiKey?: string
    purpose: 'chat' | 'vision'
    image?: AskImage
    historyMsgs: Message[]
    citations: Citation[]
    contextBlock: string
    replaceAssistantId: number | null
  },
  cb: AskCallbacks = {},
): Promise<StoredMessage> {
  let partial = ''
  let usage: { promptTokens: number; completionTokens: number } | null = null
  let lastError: string | undefined

  try {
    // key 缺失等配置错误也走统一失败路径（显式报错 + 落库，不静默）
    const apiKey = requireApiKey(opts.apiKey)
    if (opts.image) {
      // 图片问答：vision 档单轮（不挂工具，降低不稳定面）
      const lastUser: UserMessage = {
        role: 'user',
        content: [
          { type: 'text', text: `${opts.contextBlock}\n\n---\n\n用户问题：${question}` },
          { type: 'image', data: opts.image.data.toString('base64'), mimeType: opts.image.mimeType },
        ],
        timestamp: Date.now(),
      }
      const result = await streamChat(
        opts.model,
        { systemPrompt: SYSTEM_PROMPT, messages: [...opts.historyMsgs, lastUser] },
        { apiKey, signal: cb.signal, onDelta: (t) => { partial += t; cb.onDelta?.(t) } },
      )
      partial = result.text
      usage = result.usage
      if (result.errorMessage && !result.aborted) lastError = result.errorMessage
    } else {
      // 混合式 agent loop：固定检索打底，模型可按需深挖
      const lastUser: UserMessage = {
        role: 'user',
        content: `${opts.contextBlock}\n\n---\n\n用户问题：${question}`,
        timestamp: Date.now(),
      }
      const tools = buildKbTools(deps, { onTool: (name, detail) => cb.onTool?.(name, detail) })
      const streamFn: StreamFn = (m, ctx, o) =>
        import('@earendil-works/pi-ai/api/openai-completions').then((api) =>
          api.stream(m as ChatModel, ctx, { ...o, apiKey }),
        )
      const finalMsgs = await runAgentLoop(
        [lastUser],
        { systemPrompt: SYSTEM_PROMPT_AGENT, messages: [...opts.historyMsgs, lastUser], tools },
        { model: opts.model, convertToLlm: (msgs) => msgs.filter((m): m is Message => m.role === 'user' || m.role === 'assistant' || m.role === 'toolResult') },
        (event) => {
          if (event.type === 'message_update') {
            const e = event.assistantMessageEvent
            if (e.type === 'text_delta') {
              partial += e.delta
              cb.onDelta?.(e.delta)
            }
          } else if (event.type === 'tool_execution_start') {
            cb.onTool?.(event.toolName, JSON.stringify(event.args).slice(0, 120))
          }
        },
        cb.signal,
        streamFn,
      )
      const lastAssistant = [...finalMsgs].reverse().find((m) => m.role === 'assistant') as
        | AssistantMessage
        | undefined
      if (lastAssistant) {
        // 事件式失败（如上游 500）：信息在 errorMessage / stopReason 上，不显式检查就会变"空回复"
        if (lastAssistant.errorMessage || lastAssistant.stopReason === 'error') {
          lastError = lastAssistant.errorMessage ?? '模型调用失败'
        }
        partial = lastAssistant.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('')
        usage = {
          promptTokens: lastAssistant.usage?.input ?? 0,
          completionTokens: lastAssistant.usage?.output ?? 0,
        }
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
  }

  if (lastError) {
    cb.onError?.(lastError)
    const content = partial.trim() ? `${partial}\n\n（生成中断：${lastError}）` : `生成失败：${lastError}`
    return persistAssistant(deps, sessionId, opts.replaceAssistantId, content, opts.citations, opts.model.id, null)
  }

  if (usage) {
    recordUsage(deps.db, {
      model: opts.model.id,
      purpose: opts.purpose,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
    })
  }
  return persistAssistant(
    deps,
    sessionId,
    opts.replaceAssistantId,
    partial.trim() || '（空回复）',
    opts.citations,
    opts.model.id,
    usage,
  )
}

/** 混合式对话：固定检索注入 → 文本走 agent loop（可深挖）/ 图片走 vision 单轮。落库 + 记账。 */
export async function ask(
  deps: AskDeps,
  sessionId: number,
  question: string,
  cb: AskCallbacks = {},
  image?: AskImage,
): Promise<{ userMessage: StoredMessage; assistantMessage: StoredMessage | null }> {
  const isVision = !!image
  const model = isVision ? deps.visionModel : deps.chatModel
  if (isVision && !model) {
    throw new ChatError(503, 'vision 档未配置：请在服务器 data/config.json 的 models.vision 配置后重启')
  }

  const userMessage = insertMessage(deps.db, sessionId, 'user', question, [], model?.id ?? null, null)

  const historyRows = getMessages(deps.db, sessionId).slice(0, -1)
  const historyMsgs: Message[] = historyRows
    .slice(-HISTORY_TURNS)
    .map((m) =>
      m.role === 'user'
        ? ({ role: 'user', content: m.content, timestamp: Date.now() } satisfies UserMessage)
        : syntheticAssistant(m.content),
    )

  let hits: Hit[] = []
  try {
    hits = await hybridSearch(deps.db, deps.embedder, question, { limit: SEARCH_LIMIT })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cb.onError?.(message)
    const assistantMessage = insertMessage(deps.db, sessionId, 'assistant', `检索失败：${message}`, [], null, null)
    return { userMessage, assistantMessage }
  }
  const citations = hits.map((h, i) => citationOf(h, i + 1))
  cb.onContext?.(citations)

  const assistantMessage = await generateCore(
    deps,
    sessionId,
    question,
    {
      model: model!,
      apiKey: isVision ? deps.visionApiKey : deps.apiKey,
      purpose: isVision ? 'vision' : 'chat',
      image,
      historyMsgs,
      citations,
      contextBlock: contextBlockOf(hits),
      replaceAssistantId: null,
    },
    cb,
  )
  return { userMessage, assistantMessage }
}

/** 重试生成（ADR：会话级换档）：对上一条用户消息用 background 档重跑「检索 + 生成」，
 *  原位替换最后一条 assistant 消息；用户气泡不动、不落库。 */
export async function retryLast(
  deps: AskDeps & { backgroundModel?: ChatModel | null; backgroundApiKey?: string },
  sessionId: number,
  cb: AskCallbacks = {},
): Promise<{ replacedMessage: StoredMessage | null }> {
  const model = deps.backgroundModel
  if (!model) throw new ChatError(503, 'background 档未配置：请在 data/config.json 的 models.background 配置后重启')

  const msgs = getMessages(deps.db, sessionId)
  let lastUserIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]!.role === 'user') {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx === -1) throw new ChatError(400, '没有可重试的用户消息')
  const question = msgs[lastUserIdx]!.content
  const failedAssistant = msgs.slice(lastUserIdx + 1).find((m) => m.role === 'assistant') ?? null

  const historyMsgs: Message[] = msgs
    .slice(0, lastUserIdx)
    .slice(-HISTORY_TURNS)
    .map((m) =>
      m.role === 'user'
        ? ({ role: 'user', content: m.content, timestamp: Date.now() } satisfies UserMessage)
        : syntheticAssistant(m.content),
    )

  let hits: Hit[] = []
  try {
    hits = await hybridSearch(deps.db, deps.embedder, question, { limit: SEARCH_LIMIT })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    cb.onError?.(message)
    const replacedMessage = persistAssistant(deps, sessionId, failedAssistant?.id ?? null, `检索失败：${message}`, [], null, null)
    return { replacedMessage }
  }
  const citations = hits.map((h, i) => citationOf(h, i + 1))
  cb.onContext?.(citations)

  const replacedMessage = await generateCore(
    deps,
    sessionId,
    question,
    {
      model,
      apiKey: deps.backgroundApiKey,
      purpose: 'chat',
      historyMsgs,
      citations,
      contextBlock: contextBlockOf(hits),
      replaceAssistantId: failedAssistant?.id ?? null,
    },
    cb,
  )
  return { replacedMessage }
}

export { Context }
