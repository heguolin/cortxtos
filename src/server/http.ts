import fs from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { publicAuthRouter } from './routes/auth.js'
import { authGuard, guardedRouter } from './routes/guarded.js'
import type { ServerDeps } from './types.js'

export const SERVER_VERSION = '0.1.0'
const WEB_DIST_DIR = path.resolve('dist/web')

export function createApp(deps: ServerDeps): Hono {
  const app = new Hono()

  app.onError((err, c) => {
    console.error('[http]', err)
    return c.json({ error: err.message }, 500)
  })

  app.get('/healthz', (c) => c.json({ ok: true, version: SERVER_VERSION }))

  // 注册顺序即语义：公开认证路由 → /api/* 鉴权守卫 → 受保护 API → SPA 兜底
  app.route('/', publicAuthRouter(deps))
  app.use('/api/*', authGuard(deps))
  app.route('/', guardedRouter(deps))

  // /api 未匹配的走 JSON 404，绝不落进 SPA 兜底
  app.notFound((c) => {
    if (c.req.path.startsWith('/api')) return c.json({ error: 'not found' }, 404)
    if (fs.existsSync(path.join(WEB_DIST_DIR, 'index.html'))) {
      return c.html(fs.readFileSync(path.join(WEB_DIST_DIR, 'index.html'), 'utf8'))
    }
    return c.text(
      'CortxtOS daemon 运行中。前端产物未构建：先执行 pnpm build（开发模式用 pnpm dev:web 走 Vite 5173）。',
      200,
    )
  })

  if (fs.existsSync(WEB_DIST_DIR)) {
    const webRoot = path.relative(process.cwd(), WEB_DIST_DIR).split(path.sep).join('/')
    app.use('*', serveStatic({ root: webRoot }))
  }

  return app
}

export function startServer(app: Hono, port: number): ReturnType<typeof serve> {
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[cortxt] daemon 就绪: http://127.0.0.1:${info.port} (v${SERVER_VERSION})`)
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[cortxt] 端口 ${port} 已被占用——CortxtOS 是单实例守护进程，拒绝二次启动。确需重启请先停掉旧进程。`,
      )
    } else {
      console.error('[cortxt] HTTP 服务错误:', err)
    }
    process.exit(1)
  })
  return server
}
