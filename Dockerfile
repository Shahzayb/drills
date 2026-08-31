FROM node:22-alpine

WORKDIR /app

RUN npm install -g pnpm

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

COPY apps apps
COPY packages packages

RUN pnpm install --frozen-lockfile

EXPOSE 3001 3002

CMD ["pnpm", "dev"]
