FROM node:24-bookworm-slim AS dependencies

ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

FROM dependencies AS source

COPY --chown=node:node src ./src
COPY --chown=node:node views ./views
COPY --chown=node:node public ./public

RUN mkdir -p /app/data/videos/.tmp /app/data/videos/.pending \
    && chown -R node:node /app/data

FROM node:24-bookworm-slim AS validator-runtime

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

FROM validator-runtime AS validator

COPY --from=source --chown=node:node /app /app

USER node

HEALTHCHECK NONE

CMD ["node", "src/validator-worker.js"]

FROM validator-runtime AS app

COPY --from=source --chown=node:node /app /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/healthz').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["npm", "start"]
