# Stage 1: Builder
FROM node:22-slim AS builder

# Install openssl dan tools penting
RUN apt-get update -y && apt-get install -y openssl

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build project
RUN npm run build


# Stage 2: Production
FROM node:22-slim

# Install openssl dan dependency Chromium (dependensi untuk WWebJS)
RUN apt-get update && apt-get install -y \
    openssl \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    wget \
    xdg-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Copy hasil build dan Prisma client
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/generated/prisma ./generated/prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Puppeteer env variables (biar gak install chromium lagi)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV WWEBJS_PUPPETEER_HEADLESS=true

EXPOSE 3000
ENV NODE_ENV=production

CMD ["node", "dist/main"]
