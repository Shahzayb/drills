FROM node:22-alpine

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy workspace files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy all apps and packages
COPY apps apps
COPY packages packages

# Install dependencies
RUN pnpm install --frozen-lockfile

# Expose ports
EXPOSE 3001 3002

# Default command (will be overridden by docker-compose)
CMD ["pnpm", "dev"]
