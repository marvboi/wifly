# Wifly API (Hono on Node). Stateless: sessions are signed cookies, shared state lives in DATABASE_URL + REDIS_URL.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm i -g tsx@4.23.15 && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
# fonts for the link-preview images (og.ts); resvg loads no system fonts
COPY assets ./assets
EXPOSE 8787
# Railway injects PORT. /healthz checks the database.
CMD ["tsx", "src/server.ts"]
