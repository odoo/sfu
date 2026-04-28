# ── Build ───────────────────────────────────────────────────────
FROM node:24-slim AS builder

WORKDIR /app

COPY package*.json .
RUN npm ci

COPY . .
RUN npm run build

# ── Production ──────────────────────────────────────────────────
FROM node:24-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY --from=builder /app/bundle ./bundle

# HTTP/WS - override with PORT env var
EXPOSE 8070
# RTC media - override with RTC_MIN_PORT and RTC_MAX_PORT env vars
EXPOSE 40000-49999/udp
EXPOSE 40000-49999/tcp

CMD ["npm", "run", "start"]
