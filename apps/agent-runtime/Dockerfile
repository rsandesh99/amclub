# Agent runtime image. BUILD FROM THE REPO ROOT (pnpm workspace needs the whole
# tree to resolve the source packages @amclub/agent-core + @amclub/shared):
#
#   fly deploy --config apps/agent-runtime/fly.toml \
#     --dockerfile apps/agent-runtime/Dockerfile .
#
# agent-core / shared are "source" packages (main -> src/index.ts), so the image
# runs the TypeScript directly via tsx — no separate build step to keep in sync.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# pnpm deploy produces a self-contained dir with the app + its workspace deps.
RUN pnpm --filter @amclub/agent-runtime deploy --legacy /out

FROM node:22-alpine AS run
RUN corepack enable
WORKDIR /app
COPY --from=build /out /app
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
# tsx runs the source packages directly (they ship TS, not compiled JS).
CMD ["node", "--import", "tsx", "src/main.ts"]
