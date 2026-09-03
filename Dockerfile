FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm --filter synapse-os build

FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable && useradd --create-home --shell /usr/sbin/nologin synapse
COPY --from=build /app /app
RUN mkdir -p /data && chown -R synapse:synapse /app /data
USER synapse
ENV NODE_ENV=production PORT=8787 SYNAPSE_HOST=0.0.0.0 SYNAPSE_DB=/data/synapse.db
EXPOSE 8787
CMD ["pnpm", "--filter", "synapse-os", "start:remote"]
