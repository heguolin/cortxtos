# CortxtOS · 自托管个人 AI 工作台

本地优先改为**自托管**：跑在你自己的服务器上，单用户，数据 100% 自有。主轴 = 知识库问答（回答必须带出处），副轴 = 每日简报。深色霓虹二次元主题。

## 文档

- [DESIGN.md](./DESIGN.md) — 权威设计文档 v2.1
- [CONTEXT.md](./CONTEXT.md) — 术语表 + 禁用语纪律
- [docs/adr/](./docs/adr/) — 决策记录（0001–0004）
- [.scratch/cortxtos-v2/issues/](./.scratch/cortxtos-v2/issues/) — M0 工单（8 张 + 索引）

## 本地开发

```bash
pnpm install
pnpm dev:server   # daemon @ 127.0.0.1:3000（首次运行生成 ~/.cortxt/）
pnpm dev:web      # Vite @ 127.0.0.1:5173（/api 代理到 3000）
pnpm test         # vitest
pnpm typecheck    # tsc + vue-tsc
```

## 服务器部署

```bash
# 服务器上（CentOS Stream 9）：
git clone / 上传仓库到 /opt/cortxtos && cd /opt/cortxtos
cp .env.example .env   # 填 APP_PASSWORD / LLM_API_KEY / LLM_BASE_URL
bash deploy.sh         # 装 Docker + compose up + 防火墙 + swap
```

部署还需两件脚本做不了的事：腾讯云控制台防火墙放行 80/443；DNSPod 加 A 记录 `cortxt.hgl123.icu → 106.55.102.231`。

## 技术栈

Node 22 · TypeScript ESM · Hono · better-sqlite3(WAL+FTS5) + sqlite-vec · @node-rs/jieba · Vue 3 + Vite + Tailwind v4 · Pi Agent SDK（`@earendil-works/pi-agent-core` / `pi-ai`，M0 票 06 接入） · Docker Compose + Caddy
