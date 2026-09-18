# CortxtOS daemon —— 构建阶段装依赖 + 构建前端，运行阶段直接复用（bookworm glibc 保证 better-sqlite3 预编译二进制可用）
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
# 国内网络加速：pnpm 走 npmmirror；better-sqlite3 预编译二进制也指到 npmmirror
RUN pnpm config set registry https://registry.npmmirror.com/
ENV npm_config_better_sqlite3_binary_host=https://registry.npmmirror.com/-/binary/better-sqlite3
# node-gyp 兜底工具链（镜像源不可用时本地编译 sqlite）；apt 换腾讯内网源
RUN sed -i 's|deb.debian.org|mirrors.cloud.tencent.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.cloud.tencent.com|g' /etc/apt/sources.list 2>/dev/null; \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
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
