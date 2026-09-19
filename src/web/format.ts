/** DB 里的 'YYYY-MM-DD HH:MM:SS'(UTC) → 本地可读时间（今年内省略年份） */
export function fmtDbTime(v: string | null | undefined): string {
  if (!v) return ''
  const d = new Date(v.replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return v
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const md = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return sameYear ? md : `${d.getFullYear()}-${md}`
}
