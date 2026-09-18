# CortxtOS daemon —— 构建阶段装依赖 + 构建前端，运行阶段直接复用（bookworm glibc 保证 better-sqlite3 预编译二进制可用）
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# 国内网络加速：pnpm 走 npmmirror
RUN pnpm config set registry https://registry.npmmirror.com/
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    CORTEXT_IS_DOCKER=1
COPY --from=build /app ./
EXPOSE 3000
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "bin/cortxt.mjs"]
