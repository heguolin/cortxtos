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

/**
 * 自定义定时任务：跑用户填写的提示词（background 档），产物落任务记录。
 * withKb = 执行前用提示词当检索词查知识库，把命中片段注入上下文（DESIGN v2.2）。
 */
export async function runPromptTask(
  db: DB,
  model: ChatModel,
  apiKey: string | undefined,
  prompt: string,
  opts: {
    withKb?: boolean
    retrieve?: (query: string) => Promise<Array<{ title: string; page: number | null; headingPath: string | null; text: string }>>
  } = {},
): Promise<string> {
  let finalPrompt = prompt
  if (opts.withKb && opts.retrieve) {
    try {
      const hits = await opts.retrieve(prompt)
      if (hits.length > 0) {
        const block = hits
          .map((h, i) => {
            const where = [h.page != null ? `第${h.page}页` : null, h.headingPath].filter(Boolean).join(' · ')
            return `[${i + 1}] （${h.title}${where ? ` · ${where}` : ''}）\n${h.text}`
          })
          .join('\n\n')
        finalPrompt = `检索到的知识库片段：\n${block}\n\n---\n\n任务：${prompt}`
      }
    } catch (err) {
      // 检索失败不阻断任务，带错误说明跑纯提示词
      console.error('[prompt-task] 检索失败，降级为纯提示词:', err)
    }
  }
  const result = await streamChat(
    model,
    {
      systemPrompt: '你是用户自托管工作台里的定时任务执行器。直接完成任务，用简体中文输出。',
      messages: [{ role: 'user', content: finalPrompt, timestamp: Date.now() }],
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
