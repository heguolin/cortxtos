/**
 * 分块（DESIGN §4.1）：标题层级感知，目标 ~500 token、重叠 ~15%。
 * token 估算：CJK ≈ 1 字 1 token，其余 ≈ 4 字符 1 token（对 BGE 系足够近似）。
 */
export interface RawPage {
  page: number | null
  text: string
}

export interface ChunkDraft {
  text: string
  page: number | null
  headingPath: string | null
  tokens: number
}

export const TARGET_TOKENS = 500
export const OVERLAP_TOKENS = Math.round(TARGET_TOKENS * 0.15)

export function estimateTokens(text: string): number {
  let cjk = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
      (cp >= 0x3040 && cp <= 0x30ff) || // 日文假名
      (cp >= 0xac00 && cp <= 0xd7af) // 谚文
    ) {
      cjk++
    }
  }
  const other = text.length - cjk
  return cjk + Math.ceil(other / 4)
}

/** Markdown 标题层级 → 每个内容段挂上「标题 > 子标题」路径 */
export function splitMarkdownSections(text: string): { headingPath: string | null; body: string }[] {
  const lines = text.split(/\r?\n/)
  const sections: { headingPath: string | null; body: string }[] = []
  const stack: { level: number; title: string }[] = []
  let body: string[] = []

  const flush = () => {
    const content = body.join('\n').trim()
    if (content) {
      sections.push({
        headingPath: stack.length ? stack.map((s) => s.title).join(' > ') : null,
        body: content,
      })
    }
    body = []
  }

  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line)
    if (m) {
      flush()
      const level = m[1]!.length
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop()
      stack.push({ level, title: m[2]! })
    } else {
      body.push(line)
    }
  }
  flush()
  return sections.length > 0 ? sections : [{ headingPath: null, body: text }]
}

/** 超长单元按字符窗口硬切（带重叠） */
function charWindows(s: string, size = TARGET_TOKENS, overlap = OVERLAP_TOKENS): string[] {
  const out: string[] = []
  let start = 0
  while (start < s.length) {
    out.push(s.slice(start, start + size))
    if (start + size >= s.length) break
    start += size - overlap
  }
  return out
}

/** 贪心装箱：段落为单元，超长段落先按句切再装；flush 时携带 ~15% 重叠 */
function packUnits(units: string[]): string[] {
  const out: string[] = []
  let cur: string[] = []
  let curTokens = 0

  const flush = () => {
    if (cur.length === 0) return
    out.push(cur.join('\n\n'))
    // 计算下一段的重叠尾巴
    const carry: string[] = []
    let carryTokens = 0
    for (let i = cur.length - 1; i >= 0; i--) {
      const t = estimateTokens(cur[i]!)
      if (carryTokens + t > OVERLAP_TOKENS && carry.length > 0) break
      carry.unshift(cur[i]!)
      carryTokens += t
    }
    cur = carry
    curTokens = carryTokens
  }

  for (const unit of units) {
    const t = estimateTokens(unit)
    if (t > TARGET_TOKENS) {
      flush()
      // 超长段落：按句切分后重新装箱，仍然超长的句子按字符窗口硬切
      const sentences = unit.split(/(?<=[。！？!?；;\n])/).filter((s) => s.trim().length > 0)
      for (const piece of packUnits(sentences)) {
        if (estimateTokens(piece) > TARGET_TOKENS * 1.5) out.push(...charWindows(piece))
        else out.push(piece)
      }
      cur = []
      curTokens = 0
      continue
    }
    if (curTokens + t > TARGET_TOKENS && curTokens > 0) flush()
    cur.push(unit)
    curTokens += t
  }
  if (cur.length > 0) out.push(cur.join('\n\n'))
  return out
}

export function chunkPages(pages: RawPage[], isMarkdown: boolean): ChunkDraft[] {
  const drafts: ChunkDraft[] = []
  for (const page of pages) {
    const sections = isMarkdown
      ? splitMarkdownSections(page.text)
      : [{ headingPath: null, body: page.text }]
    for (const section of sections) {
      const paragraphs = section.body
        .split(/\n\s*\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      const units = paragraphs.length > 0 ? paragraphs : [section.body]
      for (const text of packUnits(units)) {
        const tokens = estimateTokens(text)
        if (tokens === 0) continue
        drafts.push({ text, page: page.page, headingPath: section.headingPath, tokens })
      }
    }
  }
  return drafts
}
