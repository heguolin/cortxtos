import { KbError } from './service.js'
import type { RawPage } from './chunk.js'
import { extractText, getDocumentProxy } from 'unpdf'

/** pdf.js 常在 CJK 字符间插入空格/多余换行，先归一化 */
function normalizePdfText(text: string): string {
  return text
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
}

/** DESIGN §4.1：md/txt 单页直读；PDF 逐页抽取并保留页码 */
export async function extractPages(mime: string, bytes: Buffer): Promise<RawPage[]> {
  if (mime === 'application/pdf') {
    let text: string | string[]
    try {
      const doc = await getDocumentProxy(new Uint8Array(bytes))
      const result = await extractText(doc, { mergePages: false })
      text = result.text
    } catch (err) {
      throw new KbError(422, `PDF 解析失败：${err instanceof Error ? err.message : String(err)}`)
    }
    const pages = (Array.isArray(text) ? text : [text]).map((t, i) => ({
      page: i + 1,
      text: normalizePdfText(t),
    }))
    if (pages.length === 0 || pages.every((p) => p.text.trim().length === 0)) {
      throw new KbError(422, 'PDF 中没有可抽取的文本（可能是扫描件/纯图 PDF）')
    }
    return pages
  }
  return [{ page: null, text: bytes.toString('utf8') }]
}
