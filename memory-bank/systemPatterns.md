# System Patterns

The shape of the system as it stands now. Why it's shaped this way is in `decisions.md`.

## Architecture

pnpm workspace monorepo (`pnpm-workspace.yaml`: `apps/*`, `packages/*`), orchestrated at the root by Turborepo (`turbo.json`). `packages/` exists but is empty.

- `apps/backend` — NestJS API (TypeScript). Listens on `process.env.PORT ?? 3001`.
- `apps/frontend` — Next.js 16 (App Router, React 19, Tailwind v4). No lockfile or workspace file of its own; installs are governed entirely by the root `pnpm-workspace.yaml` and `pnpm-lock.yaml`.

The two apps are independent. No cross-app architecture exists yet — notably, the frontend has no established pattern for calling the backend. The first feature that needs one sets the precedent; log it in `decisions.md` and describe the resulting shape here.

## Component relationships

_Not yet established._
