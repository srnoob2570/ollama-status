FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig*.json vite.config.ts index.html ./
COPY src ./src
RUN npm run build && npx tsc --noEmit -p tsconfig.node.json

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
COPY scripts/migrate-node.mjs ./scripts/migrate-node.mjs
COPY scripts/test-postgres.mjs ./scripts/test-postgres.mjs
COPY src/worker ./src/worker
COPY src/node ./src/node
EXPOSE 3000
CMD ["node", "src/node/server.ts"]
