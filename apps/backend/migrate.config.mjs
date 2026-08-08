// Connection config for node-pg-migrate, wired in by the `migrate` script.
//
// Deliberately NOT a DATABASE_URL. `.env` already carries POSTGRES_* and is the
// single source of truth for how this stack connects; a second spelling of the
// same credentials is a thing that drifts. The fallbacks match
// src/postgres/postgres.service.ts exactly, so the runner and the app can never
// disagree about where the database is.
//
// These variables reach the process from Compose's `env_file`, which is why
// migrations run inside the container and not from the host — nothing loads
// `.env` into a host shell, so a host run would quietly use the fallbacks and
// migrate the wrong database, or none at all.
export default {
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? 'postgres',
  password: process.env.POSTGRES_PASSWORD ?? 'postgres',
  database: process.env.POSTGRES_DB ?? 'postgres',
};
