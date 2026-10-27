# Wifly web: static Vite build served by Caddy. Hashed /assets get a 1-year immutable cache, index.html no-cache.
# /api and /uploads are proxied to the API over Railway private networking, so the session cookie stays first-party.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit --no-fund
COPY . .
# Public build-time values only (never secrets).
ARG VITE_PRIVY_APP_ID
ARG VITE_WIFLY_ADDRESS
ARG VITE_WIFLY_AGENT_ADDRESS
ARG VITE_WIFLY_TEAM_WALLET
ARG VITE_NAMES_ADDRESS
ARG VITE_BADGES_ADDRESS
ARG VITE_TX_ENABLED
ARG VITE_DCA_ADDRESS
ARG VITE_WALLETCONNECT_PROJECT_ID
ARG VITE_ADMIN_ADDRESSES
ARG VITE_DEPLOY_PAGE
# Host split: the landing page on VITE_SITE_URL, the app on VITE_APP_URL. Any other host (the Railway URL, localhost)
# keeps the single-host layout. Override both with the same value, or set them empty, to turn the split off.
ARG VITE_SITE_URL=https://wifly.fun
ARG VITE_APP_URL=https://app.wifly.fun
RUN npm run build

FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 8080
