# cc-server — normal cloud-server packaging (NestJS + SQLite + admin-next UI)
# Build:  docker build -t cc-server .
# Run:    docker compose up -d

FROM node:22-bookworm AS build
WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json package-lock.json ./
COPY admin-next/package.json admin-next/package-lock.json ./admin-next/
RUN npm ci && npm --prefix admin-next ci

COPY . .

# Build the admin UI into public/admin-next, then the NestJS server into dist/
RUN npm run admin-next:build && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

# SQLite database lives here; mount a volume for persistence
VOLUME ["/data"]
ENV PORT=3000 \
    CC_DB_PATH=/data/cc-server.sqlite

EXPOSE 3000
CMD ["node", "dist/main.js"]
