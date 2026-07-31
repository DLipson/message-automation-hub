# syntax=docker/dockerfile:1

# Build stage: install all workspace deps (including puppeteer's Chromium)
# and compile core to dist/.
FROM node:22-slim AS build
WORKDIR /app
ENV PUPPETEER_CACHE_DIR=/opt/puppeteer-cache

COPY package.json package-lock.json ./
COPY core/package.json core/package.json
COPY plugins/package.json plugins/package.json
RUN npm ci

COPY core/tsconfig.json core/tsconfig.json
COPY core/tsconfig.build.json core/tsconfig.build.json
COPY core/src core/src
RUN npm run build -w core

# Runtime stage: Chromium shared libraries + built output.
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    PUPPETEER_CACHE_DIR=/opt/puppeteer-cache

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/core/package.json ./core/package.json
COPY --from=build /app/core/dist ./core/dist
COPY --from=build /opt/puppeteer-cache /opt/puppeteer-cache

VOLUME ["/app/.wwebjs_auth", "/data"]

EXPOSE 8788

CMD ["node", "core/dist/index.js"]
