FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY config/ ./config/

USER node

CMD ["node", "dist/index.js"]
