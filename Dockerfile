# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app

# Copy production dependencies and build output
COPY --from=base /app/node_modules ./node_modules
COPY package.json ./package.json
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production \
    GENERECT_API_BASE=https://api.generect.com \
    GENERECT_TIMEOUT_MS=60000

EXPOSE 3000

CMD ["node", "dist/server.js"]


