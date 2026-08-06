# Progress

## What works

- `pnpm dev` runs both apps together via Turborepo (backend `3001`, frontend `3000`).
- `apps/backend` — NestJS starter, with its default unit and e2e tests.
- `apps/frontend` — `create-next-app` scaffold.
- Workflow hooks: memory bank loads on session start; record-step and cap nudges fire (each pipe-tested against its trigger and non-trigger states).

## What's left

_Not yet established — no feature scope defined._

## Known issues

- Root `package.json` declares the pnpm version in both `packageManager` and `devEngines.packageManager`, which warns on every install. Harmless; keep one if it's ever cleaned up.
- The frontend has no test runner configured.
