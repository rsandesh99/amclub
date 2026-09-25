# Agent runtime image. BUILD FROM THE REPO ROOT (pnpm workspace needs the whole
# tree to resolve the source packages @amclub/agent-core + @amclub/shared):
#
#   fly deploy --config apps/agent-runtime/fly.toml \
#     --dockerfile apps/agent-runtime/Dockerfile .
#
# agent-core / shared are "source" packages (main -> src/index.ts), so the image
# runs the TypeScript directly via tsx — no separate build step to keep in sync.
#
# The root .dockerignore keeps the context to the workspace manifests,
# apps/agent-runtime and packages/* (no .git, .env*, node_modules, docs or other
# apps — audit M26).
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# pnpm deploy produces a self-contained dir with the app + its workspace deps.
# corepack runs the root packageManager (pnpm 9.15), whose `deploy` is the classic
# one: pnpm 9 rejects `--legacy` ("Unknown option"); add it back only with pnpm 10.
# Not `--prod`: tsx (a devDependency) runs the TypeScript at start.
RUN pnpm --filter @amclub/agent-runtime deploy /out

FROM node:22-alpine AS run
RUN corepack enable
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
# Never run as root (audit M26): the official image ships the unprivileged `node`
# user. The app only reads /app; tsx's compile cache goes to the OS temp dir.
USER node
# tsx runs the source packages directly (they ship TS, not compiled JS). The runtime package is
# CommonJS on purpose: as ESM, Node cannot see the named exports the CommonJS-compiled source
# packages re-export (`export *`), and this CMD died at the first import (docs/agents/RUNTIME.md).
CMD ["node", "--import", "tsx", "src/main.ts"]
