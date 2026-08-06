# Progress

## What works

`pnpm dev` runs both apps via Turborepo. Backend is the NestJS starter with its default tests; frontend is the `create-next-app` scaffold.

## Status

Scaffolding only — nothing from the drill program has been built yet. Next up is drill 01 (Compose stack).

## Known issues

- Root `package.json` declares the pnpm version twice (`packageManager` and `devEngines.packageManager`), warning on every install. Harmless.
- Frontend has no test runner.

## Evolution of decisions
