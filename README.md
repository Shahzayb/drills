# drills

pnpm monorepo with `apps/backend` (NestJS) and `apps/frontend` (Next.js), orchestrated by Turborepo. Postgres and Redis run alongside them under Docker Compose.

```bash
# first run — creates .env from .env.example, then starts everything
pnpm run setup

# start
pnpm docker:up

# stop
pnpm docker:down
```

`pnpm run setup`, not `pnpm setup` — pnpm has a built-in `setup` command that shadows the script.

Once up, `http://localhost:3002/health` reports whether the backend can reach Postgres and Redis.

See [CLAUDE.md](CLAUDE.md) for details.
