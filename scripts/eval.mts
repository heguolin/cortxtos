#!/usr/bin/env node
/**
 * 检索评估（ADR 0008）：对 eval/eval-set.json 逐条跑「真实嵌入 + 混合检索」，
 * 输出文档级 Hit@1/@3/@6 与逐条命中明细。一切检索调参的前置与回归护栏。
 *
 * 用法：pnpm eval [--set eval/eval-set.json]
 * 需要 .env 里的嵌入配置（会消耗少量嵌入 token）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadDotEnv, loadConfig } from '../src/server/config.js'
import { openDb, ensureVecTable } from '../src/server/db.js'
import { migrate } from '../src/server/migrations.js'
import { createEmbedderFromEnv } from '../src/server/llm/embedder.js'
import { hybridSearch } from '../src/server/kb/search.js'

interface EvalEntry {
  query: string
  expectDocument: string
  note?: string
}

interface EvalSet {
  description?: string
  entries: EvalEntry[]
}

const args = process.argv.slice(2)
const setIdx = args.indexOf('--set')
const setPath = setIdx >= 0 ? args[setIdx + 1] : 'eval/eval-set.json'

loadDotEnv(path.resolve('.env'))
const dataDir = process.env.CORTEXT_DATA_DIR?.trim() || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.cortxt')
const { config } = loadConfig(dataDir)

const db = openDb(path.join(dataDir, 'cortxt.db'))
ensureVecTable(db, config.models.embedding.dimensions)
const embedder = createEmbedderFromEnv(config.models.embedding)

const set = JSON.parse(fs.readFileSync(path.resolve(setPath), 'utf8')) as EvalSet
// __none__ 期望 = 无答案类（观察检索是否被无关内容干扰），不计入 Hit@k
const scored = set.entries.filter((e) => e.expectDocument !== '__none__')
const noAnswer = set.entries.filter((e) => e.expectDocument === '__none__')
const entries = set.entries
if (entries.length === 0) {
  console.error(`评估集为空: ${setPath}`)
  process.exit(1)
}

const docs = db.prepare('SELECT id, title FROM documents').all() as Array<{ id: number; title: string }>
console.log(`语料: ${docs.length} 篇文档 · 评估条目: ${entries.length} 条\n`)

interface Result {
  query: string
  expect: string
  hitAt: Partial<Record<1 | 3 | 6, boolean>>
  rank: number | null
  topTitles: string[]
}

const results: Result[] = []
for (const entry of scored) {
  const hits = await hybridSearch(db, embedder, entry.query, { limit: 6 })
  const expectTitle = entry.expectDocument
  const rank = hits.findIndex((h) => h.title === expectTitle || h.source === expectTitle)
  const hitAt: Result['hitAt'] = {}
  for (const k of [1, 3, 6] as const) {
    if (rank >= 0 && rank < k) hitAt[k] = true
  }
  results.push({
    query: entry.query,
    expect: expectTitle,
    hitAt,
    rank: rank >= 0 ? rank + 1 : null,
    topTitles: hits.slice(0, 3).map((h) => h.title),
  })
  process.stdout.write(`${rank >= 0 ? `✦ top${rank + 1}` : '✗ 未命中'} ${entry.query}\n`)
}

const rate = (k: 1 | 3 | 6) => {
  const hit = results.filter((r) => r.hitAt[k]).length
  return `${hit}/${results.length} (${((hit / results.length) * 100).toFixed(0)}%)`
}

console.log('\n===== 基线 =====')
console.log(`Hit@1: ${rate(1)}`)
console.log(`Hit@3: ${rate(3)}`)
console.log(`Hit@6: ${rate(6)}`)

console.log('\n===== 未命中/靠后明细 =====')
for (const r of results) {
  if (r.rank === null || r.rank > 3) {
    console.log(`✗ [期望: ${r.expect} | 实际排名: ${r.rank ?? '未命中'}] ${r.query}`)
    console.log(`   top3: ${r.topTitles.join(' / ') || '(空)'}`)
  }
}
console.log(`\n调参门禁（ADR 0008）：top3 < 80% 才考虑接入 rerank；一切调参需附本次输出作前后对比。`)
