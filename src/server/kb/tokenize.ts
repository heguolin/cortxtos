import { Jieba } from '@node-rs/jieba'
import { dict } from '@node-rs/jieba/dict.js'

const jieba = Jieba.withDict(dict)

/**
 * ADR 0004：FTS5 中文分词，索引与查询两侧统一走 cutForSearch
 * （搜索模式会同时产出 知识 / 知识库 这类长短粒度，召回更友好）。
 *
 * 每个 token 用双引号包成 FTS5 短语：防止用户文本里的 - : ( ) 等字符
 * 被当成 FTS5 查询语法（实测 "sqlite-vec" 会报 no such column: vec）。
 */
export function tokenizeForFts(text: string): string {
  return jieba
    .cutForSearch(text)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' ')
}
