import { Readability } from '@mozilla/readability'
import { JSDOM } from 'jsdom'
import TurndownService from 'turndown'
import dns from 'node:dns/promises'
import net from 'node:net'
import { KbError } from './service.js'

/**
 * 网页捕获管线（DESIGN §4.5 / ADR 0005）：
 * 裸 URL 识别 → SSRF 校验（含重定向逐跳）→ 抓取（30s/2MB）→ Readability 正文 → turndown 转 Markdown。
 * 只存文字不落图片；失败显式报错。
 */

const FETCH_TIMEOUT_MS = 30_000
const MAX_BYTES = 2 * 1024 * 1024
const UA = 'CortxtOS/0.1 (personal knowledge capture; +https://cortxt.hgl123.icu)'
const MAX_REDIRECTS = 3

export type CaptureStatus = 400 | 413 | 415 | 422 | 502 | 504

export class WebCaptureError extends Error {
  constructor(
    public readonly status: CaptureStatus,
    message: string,
  ) {
    super(message)
  }
}

/** 裸 URL 判定（CONTEXT.md：输入 trim 后整体即合法 http/https 链接才算，不猜意图） */
export function extractBareUrl(text: string): string | null {
  const t = text.trim()
  if (!/^https?:\/\/\S+$/i.test(t)) return null
  try {
    const u = new URL(t)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return u.toString()
  } catch {
    return null
  }
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true
  const [a, b] = parts as [number, number, number, number]
  void b
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b! >= 64 && b! <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b! >= 16 && b! <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

function isPrivateIPv6(ip: string): boolean {
  const v = ip.toLowerCase()
  if (v === '::' || v === '::1') return true
  if (v.startsWith('fe80')) return true // link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true // ULA fc00::/7
  if (v.startsWith('::ffff:')) return isPrivateIPv4(v.slice(7)) // v4-mapped
  return false
}

/** 本地 TUN 代理的 fake-ip 段（RFC 2544 基准段 + mihomo 默认 v6 段）：
 *  不会出现在真实内网，fetch 会经代理隧道去往真实目标 → 视为可放行。 */
function isFakeIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return a === 198 && (b === 18 || b === 19)
  }
  return ip.toLowerCase().startsWith('fdfe:dcba:9876:')
}

function isBlockedAddress(ip: string): boolean {
  return isPrivateAddress(ip) && !isFakeIp(ip)
}

function isPrivateAddress(ip: string): boolean {
  return net.isIPv4(ip) ? isPrivateIPv4(ip) : isPrivateIPv6(ip)
}

/** SSRF 防护：协议白名单 + 主机名/解析出的全部 IP 不得为内网/环回。
 *  CORTEXT_ALLOW_PRIVATE_FETCH=1 时跳过内网拦截（仅测试环境对本地 mock server 用）。 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new WebCaptureError(400, 'URL 不合法')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebCaptureError(400, '仅支持 http/https 链接')
  }
  const allowPrivate = process.env.CORTEXT_ALLOW_PRIVATE_FETCH === '1'
  const host = url.hostname
  if (
    !allowPrivate &&
    (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
  ) {
    throw new WebCaptureError(400, '拒绝抓取内网地址')
  }
  if (!allowPrivate && net.isIP(host) !== 0 && isBlockedAddress(host)) {
    throw new WebCaptureError(400, '拒绝抓取内网地址')
  }
  if (!allowPrivate && !net.isIP(host)) {
    try {
      const addrs = await dns.lookup(host, { all: true })
      if (addrs.length === 0) throw new WebCaptureError(502, `无法解析域名: ${host}`)
      for (const { address } of addrs) {
        if (isBlockedAddress(address)) throw new WebCaptureError(400, '域名解析到内网地址，拒绝抓取')
      }
    } catch (err) {
      if (err instanceof WebCaptureError) throw err
      throw new WebCaptureError(502, `无法解析域名: ${host}`)
    }
  }
  return url
}

function isPrivateTarget(url: URL): boolean {
  const host = url.hostname
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  return net.isIP(host) !== 0 && isBlockedAddress(host)
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

export interface CapturedPage {
  url: string
  siteName: string
  title: string
  markdown: string
}

/** 抓取 + 逐跳 SSRF 校验 + Readability 提取 + turndown 转 Markdown */
export async function captureUrlPage(rawUrl: string): Promise<CapturedPage> {
  let url = await assertPublicUrl(rawUrl)
  const allowPrivate = process.env.CORTEXT_ALLOW_PRIVATE_FETCH === '1'

  let res: Response
  for (let hop = 0; ; hop++) {
    if (!allowPrivate && isPrivateTarget(url)) throw new WebCaptureError(400, '重定向到内网地址，拒绝抓取')
    try {
      res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new WebCaptureError(504, '抓取超时（30 秒）')
      }
      throw new WebCaptureError(502, `无法访问目标页面: ${err instanceof Error ? err.message : String(err)}`)
    }
    // 重定向逐跳校验（ADR：手动跟随，最多 3 跳，每跳重新过 SSRF）
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new WebCaptureError(502, `目标返回 ${res.status} 重定向但没有 location`)
      if (hop >= MAX_REDIRECTS) throw new WebCaptureError(502, '重定向次数过多')
      url = new URL(location, url)
      continue
    }
    break
  }

  if (res.status === 403 || res.status === 401) {
    throw new WebCaptureError(422, '目标站点拒绝访问（防爬/需登录），无法抓取')
  }
  if (res.status >= 400) {
    throw new WebCaptureError(422, `目标返回 ${res.status}，抓取失败`)
  }
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('text/html') && !ct.includes('xhtml') && !ct.includes('text/plain')) {
    throw new WebCaptureError(415, `不支持的内容类型「${ct.split(';')[0]}」：仅支持网页`)
  }
  const lenHeader = Number(res.headers.get('content-length') ?? 0)
  if (lenHeader > MAX_BYTES) throw new WebCaptureError(413, '页面超过 2MB 上限')
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_BYTES) throw new WebCaptureError(413, '页面超过 2MB 上限')
  if (buf.byteLength === 0) throw new WebCaptureError(422, '页面内容为空')

  const html = new TextDecoder(charsetOf(ct)).decode(buf)
  const dom = new JSDOM(html, { url: url.toString() })
  const siteName =
    dom.window.document.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() ||
    url.hostname
  const article = new Readability(dom.window.document).parse()
  if (!article || !article.textContent || article.textContent.trim().length < 20) {
    throw new WebCaptureError(422, '未能提取到有效正文（可能是纯脚本渲染页）')
  }
  const markdown = turndown.turndown(article.content ?? '').trim()
  if (!markdown) throw new WebCaptureError(422, '正文转换失败')

  const title = (article.title?.trim() || siteName).replace(/[\\/:*?"<>|]/g, ' ').slice(0, 120)
  return { url: url.toString(), siteName, title, markdown }
}

function charsetOf(ct: string): string {
  const m = /charset=([\w-]+)/i.exec(ct)
  return m?.[1] ?? 'utf-8'
}

/** 元信息头 + 正文 → Markdown 产物（真相源文件内容） */
export function buildCaptureMarkdown(page: CapturedPage): string {
  const capturedAt = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: process.env.TZ || undefined })
  return [
    `> 🌐 来源：[${page.siteName}](${page.url})`,
    `> 抓取于 ${capturedAt} · CortxtOS 网页捕获`,
    '',
    `# ${page.title}`,
    '',
    page.markdown,
    '',
  ].join('\n')
}
