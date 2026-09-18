import type { AppConfig } from '../config.js'

export interface EmbedResult {
  vectors: number[][]
  promptTokens: number
}

export interface EmbeddingClient {
  readonly model: string
  embed(texts: string[]): Promise<EmbedResult>
}

export class LlmNotConfiguredError extends Error {}

/** 聚合平台 OpenAI 兼容 /v1/embeddings */
export class OpenAICompatibleEmbedder implements EmbeddingClient {
  constructor(
    readonly model: string,
    private readonly baseUrl: string | undefined,
    private readonly apiKey: string | undefined,
  ) {}

  async embed(texts: string[]): Promise<EmbedResult> {
    if (!this.baseUrl || !this.apiKey) {
      throw new LlmNotConfiguredError(
        '嵌入未配置：请在 .env 设置 LLM_API_KEY 与 LLM_BASE_URL（或在 embedding profile 单独配 baseUrl）',
      )
    }
    const url = `${this.baseUrl.replace(/\/+$/, '')}/embeddings`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      throw new Error(`嵌入 API ${res.status}: ${body}`)
    }
    const data = (await res.json()) as {
      data: { index: number; embedding: number[] }[]
      usage?: { prompt_tokens?: number }
    }
    const vectors = [...data.data].sort((a, b) => a.index - b.index).map((d) => d.embedding)
    return { vectors, promptTokens: data.usage?.prompt_tokens ?? 0 }
  }
}

export function createEmbedderFromEnv(profile: AppConfig['models']['embedding']): EmbeddingClient {
  return new OpenAICompatibleEmbedder(
    profile.model,
    profile.baseUrl ?? process.env.LLM_BASE_URL,
    process.env.LLM_API_KEY,
  )
}
