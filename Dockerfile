FROM node:20-alpine

RUN apk add --no-cache openssl netcat-openbsd bash

RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

COPY entrypoint.sh ./
COPY . .
COPY prisma ./prisma

RUN pnpm prisma:generate
RUN pnpm build

EXPOSE 3011

ENTRYPOINT ["bash", "/app/entrypoint.sh"]
CMD ["node", "dist/main"]
