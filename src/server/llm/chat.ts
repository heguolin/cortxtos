import { stream as openaiCompletionsStream } from '@earendil-works/pi-ai/api/openai-completions'
import type { Context, Model } from '@earendil-works/pi-ai'

/**
 * ADR 0002：Pi SDK 作为 LLM 调用底座。M0 固定管线直接用 pi-ai 的
 * openai-completions StreamFunction（自带 SSE 解析/用量归一/兼容层），
 * 不经 Models 注册表——聊天固定走 primary 档，无需动态选型。
 */

export type ChatModel = Model<'openai-completions'>

export function buildChatModel(
  profile: { model: string; baseUrl?: string },
  opts: { supportsImages?: boolean } = {},
): ChatModel {
  const baseUrl = (profile.baseUrl ?? process.env.LLM_BASE_URL ?? '').replace(/\/+$/, '')
  return {
    id: profile.model,
    name: profile.model,
    api: 'openai-completions',
    provider: 'cortxt',
    baseUrl,
    reasoning: false,
    input: opts.supportsImages ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    // 聚合平台普遍不支持 OpenAI 的 store 字段，显式关掉
    compat: { supportsStore: false },
  }
}

export interface ChatTurnOptions {
  apiKey?: string
  signal?: AbortSignal
  onDelta?: (text: string) => void
}

export interface ChatTurnResult {
  text: string
  usage: { promptTokens: number; completionTokens: number } | null
  aborted: boolean
  errorMessage?: string
}

export function requireApiKey(apiKey?: string): string {
  if (!apiKey) {
    throw new Error('未配置 LLM_API_KEY / LLM_BASE_URL：对话功能不可用（见服务器 .env）')
  }
  return apiKey
}

export async function streamChat(
  model: ChatModel,
  context: Context,
  opts: ChatTurnOptions,
): Promise<ChatTurnResult> {
  const events = openaiCompletionsStream(model, context, {
    apiKey: requireApiKey(opts.apiKey),
    signal: opts.signal,
  })

  let result: ChatTurnResult = { text: '', usage: null, aborted: false }
  for await (const event of events) {
    if (event.type === 'text_delta') {
      opts.onDelta?.(event.delta)
    } else if (event.type === 'done') {
      const text = event.message.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('')
      result = {
        text,
        usage: {
          promptTokens: event.message.usage?.input ?? 0,
          completionTokens: event.message.usage?.output ?? 0,
        },
        aborted: false,
      }
    } else if (event.type === 'error') {
      result = {
        text: result.text,
        usage: null,
        aborted: event.reason === 'aborted',
        errorMessage: event.error.errorMessage ?? `模型调用失败（${event.reason}）`,
      }
    }
  }
  result.text = result.text || ''
  return result
}
