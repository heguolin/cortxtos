import DOMPurify from 'dompurify'
import { marked } from 'marked'

/** Markdown → 消毒后 HTML（对话/查看器/简报/任务/知识库详情共用） */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }))
}
