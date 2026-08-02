# syntax=docker/dockerfile:1

# Build stage: install deps (including puppeteer's Chromium) and compile to dist/.
FROM node:22-slim AS build
WORKDIR /app
ENV PUPPETEER_CACHE_DIR=/opt/puppeteer-cache

COPY package.json package-lock.json ./
COPY tsconfig.json tsconfig.json
COPY tsconfig.build.json tsconfig.build.json
COPY src src
RUN npm ci

RUN npm run build

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
COPY --from=build /app/dist ./dist
COPY --from=build /opt/puppeteer-cache /opt/puppeteer-cache

VOLUME ["/app/.wwebjs_auth", "/data"]

EXPOSE 8788

CMD ["node", "dist/index.js"]
