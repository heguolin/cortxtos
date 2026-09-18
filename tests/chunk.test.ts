import { describe, expect, it } from 'vitest'
import {
  chunkPages,
  estimateTokens,
  splitMarkdownSections,
  TARGET_TOKENS,
  type RawPage,
} from '../src/server/kb/chunk.js'

describe('estimateTokens', () => {
  it('CJK ≈ 1 字 1 token', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })
  it('ASCII ≈ 4 字符 1 token', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
  })
  it('混合文本', () => {
    // 4 CJK + 8 ascii = 4 + 2
    expect(estimateTokens('你好世界abcdefgh')).toBe(6)
  })
})

describe('splitMarkdownSections', () => {
  it('嵌套标题 → heading_path 层级路径', () => {
    const md = '# 入门\n\n介绍正文。\n\n## 安装\n\n安装正文。\n\n## 配置\n\n配置正文。'
    const sections = splitMarkdownSections(md)
    expect(sections.map((s) => s.headingPath)).toEqual(['入门', '入门 > 安装', '入门 > 配置'])
    expect(sections[1]!.body).toBe('安装正文。')
  })

  it('同级标题正确出栈', () => {
    const md = '# A\n\na\n\n## B\n\nb\n\n# C\n\nc'
    const sections = splitMarkdownSections(md)
    expect(sections.map((s) => s.headingPath)).toEqual(['A', 'A > B', 'C'])
  })

  it('无标题文档 → 单段 null 路径', () => {
    expect(splitMarkdownSections('只有正文').map((s) => s.headingPath)).toEqual([null])
  })
})

describe('chunkPages', () => {
  const mdPage = (text: string): RawPage => ({ page: null, text })

  it('小文档 → 单 chunk 且带标题路径', () => {
    const drafts = chunkPages([mdPage('# 笔记\n\n这是内容。')], true)
    expect(drafts.length).toBe(1)
    expect(drafts[0]!.headingPath).toBe('笔记')
    expect(drafts[0]!.text).toBe('这是内容。')
  })

  it('超目标长度 → 多 chunk，且携带重叠', () => {
    const para = '这是一个用来撑长度的段落，包含中文标点和重复句式。'.repeat(30) // ≈ 760 tokens
    const drafts = chunkPages([mdPage(`# 长文\n\n${para}\n\n${para}`)], true)
    expect(drafts.length).toBeGreaterThan(1)
    for (const d of drafts) {
      expect(d.tokens).toBeLessThanOrEqual(TARGET_TOKENS * 1.6)
    }
    // 重叠：第二个 chunk 的开头应出现在第一个 chunk 的结尾附近
    const tail = drafts[0]!.text.slice(-80)
    expect(drafts[1]!.text).toContain(tail.slice(0, 40))
  })

  it('PDF 逐页保留页码', () => {
    const pages: RawPage[] = [
      { page: 1, text: '第一页内容。'.repeat(10) },
      { page: 2, text: '第二页内容。'.repeat(10) },
    ]
    const drafts = chunkPages(pages, false)
    expect(drafts.some((d) => d.page === 1)).toBe(true)
    expect(drafts.some((d) => d.page === 2)).toBe(true)
    expect(drafts.every((d) => d.headingPath === null)).toBe(true)
  })
})
