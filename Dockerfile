# Production image: web app only (run `pnpm worker` / `pnpm agents` as separate processes from the same image).
# Mount a volume for data/ (SQLite database + avatar cache) or point DATABASE_URL at a libSQL server.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
# Inlined into the client bundle by `next build`: pass them as build args.
ARG NEXT_PUBLIC_SOLANA_CLUSTER
ARG NEXT_PUBLIC_SOLANA_RPC_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

CMD ["sh", "-c", "pnpm db:migrate && pnpm start"]
