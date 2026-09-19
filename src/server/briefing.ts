import { streamChat, type ChatModel } from './llm/chat.js'
import { recordUsage } from './llm/usage.js'
import type { DB } from './db.js'

/**
 * 每日简报（DESIGN §4.3）：扫描过去 24h 新增/变更文档 → background 档生成摘要。
 * 产物 = daily-briefing job 的 run.output，简报页直接读 runs 表。
 */
export async function runBriefing(
  db: DB,
  model: ChatModel,
  apiKey: string | undefined,
  promptTemplate: string,
): Promise<string> {
  const docs = db
    .prepare(
      "SELECT id, title FROM documents WHERE updated_at >= datetime('now', '-1 day') ORDER BY updated_at DESC",
    )
    .all() as { id: number; title: string }[]

  if (docs.length === 0) return '今日无更新'

  const parts = docs.map((d) => {
    const chunk = db.prepare('SELECT text FROM chunks WHERE document_id = ? ORDER BY ord LIMIT 1').get(d.id) as
      | { text: string }
      | undefined
    return `## ${d.title}\n${chunk ? chunk.text.slice(0, 400) : '（尚未索引，无内容摘要）'}`
  })
  const prompt = `${promptTemplate}\n\n${parts.join('\n\n')}`

  const result = await streamChat(
    model,
    {
      systemPrompt: '你是个人知识库管理员，负责写每日简报。用简体中文，简洁直接。',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    },
    { apiKey },
  )
  if (result.errorMessage) throw new Error(result.errorMessage)
  recordUsage(db, {
    model: model.id,
    purpose: 'background',
    promptTokens: result.usage?.promptTokens ?? 0,
    completionTokens: result.usage?.completionTokens ?? 0,
  })
  return result.text.trim() || '（空简报）'
}

/** 自定义定时任务：跑用户填写的提示词（background 档），产物落任务记录 */
export async function runPromptTask(
  db: DB,
  model: ChatModel,
  apiKey: string | undefined,
  prompt: string,
): Promise<string> {
  const result = await streamChat(
    model,
    {
      systemPrompt: '你是用户自托管工作台里的定时任务执行器。直接完成任务，用简体中文输出。',
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    },
    { apiKey },
  )
  if (result.errorMessage) throw new Error(result.errorMessage)
  recordUsage(db, {
    model: model.id,
    purpose: 'background',
    promptTokens: result.usage?.promptTokens ?? 0,
    completionTokens: result.usage?.completionTokens ?? 0,
  })
  return result.text.trim() || '（空输出）'
}
