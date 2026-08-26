# Multi-stage Docker build for the 21.gifts spend service.
#
# Build:
#   docker build -t 21gifts/spend:beta .
#   docker build -t 21gifts/spend:latest .
#
# Run (required: GIFTS_API_URL, GIFTS_API_TOKEN, LNDHUB_URI):
#   docker run -p 3000:3000 -v spend-state:/data \
#     -e GIFTS_API_URL -e GIFTS_API_TOKEN -e LNDHUB_URI -e SPEND_LIVE=true \
#     21gifts/spend:latest

FROM oven/bun:1.3-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun build src/server.ts --target=bun --outdir=dist

FROM oven/bun:1.3-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /data && chown app:app /data
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/recipients.tondo.json ./recipients.tondo.json
USER app

ENV BIND_ADDR=0.0.0.0:3000
ENV STATE_DIR=/data
ENV RECIPIENTS_FILE=/app/recipients.tondo.json
EXPOSE 3000

CMD ["bun", "run", "dist/server.js"]
