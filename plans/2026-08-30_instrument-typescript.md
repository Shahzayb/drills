# Instruments in TypeScript

Every file in `scripts/`, `k6/` and `apps/backend/db/` becomes TypeScript. Seventeen
files, ~5,000 lines, three runtimes. No behaviour changes.

## Why this is not just `git mv`

The three directories run in three different places, and each one has its own rule
about what a TypeScript file may look like and how it must be imported. Getting any
of the three wrong fails silently or fails at the wrong time.

| Directory | Runs in | Today | Becomes | Why that extension |
|---|---|---|---|---|
| `scripts/` | host Node 24 | `.mjs` + one `.sh` | `.ts` | root `package.json` is `"type": "module"`, so `.ts` is ESM |
| `apps/backend/db/` | container Node 22 | `.mjs` | `.mts` | `apps/backend/package.json` has **no** `type` field, so a `.ts` there would be **CommonJS** — no top-level `await`, no `import.meta.url` |
| `k6/` | `grafana/k6:2.1.0` | `.js` | `.ts` | k6 transpiles TypeScript itself since 0.57 |

### No transpiler, no new runtime dependency

Node strips types natively — `--experimental-strip-types` is on by default from
22.18.0, and both runtimes are past it:

```bash
node -v                                  # v24.11.1  (host)
docker run --rm node:22-alpine node -v   # v22.23.2  (container, from the Dockerfile)
```

So `node scripts/load.ts` and `node db/explain.mts` just work. No `tsx`, no
`ts-node`, no build step, and every root `package.json` script keeps its shape.

The price is **erasable syntax only**: no `enum`, no `namespace`, no constructor
parameter properties. None of these files uses any of them. `erasableSyntaxOnly`
in the tsconfig is what keeps it that way.

### Import specifiers must carry `.ts` / `.mts`

Node's type stripping does not rewrite specifiers, and neither does k6. Measured:

```bash
docker run --rm -v /tmp/k6ts:/scripts grafana/k6:2.1.0 run /scripts/t.ts
```

- `import … from './lib/sc.ts'` → runs
- `import … from './lib/sc.js'` → `The moduleSpecifier "./lib/sc.js" couldn't be found on local disk`
- `import … from './lib/sc'` → same error

So imports are written with the real on-disk extension, and
`allowImportingTsExtensions` in the tsconfig makes `tsc` accept it.

## The names that must not move

`k6/reports/` holds ~60 recorded run directories and the plans cite them by name.
`scripts/load.mjs` builds that name with `script.file.replace(/\.js$/, '')`, so the
rename is only safe if that regex is changed in the same commit.

- `conversations-baseline.js` → `conversations-baseline.ts`, and the report
  directory stays `…-conversations-baseline-org1-vus10-60s`.
- `messages-search.js` → `messages-search.ts`, same.
- `apps/backend/db/reports/` names come from string literals passed to `record()`
  (`'explain'`, `'paging'`, …), not from filenames — unaffected.

## `nest build` must not compile `db/`

`apps/backend/tsconfig.json` has no `exclude`, and `tsconfig.build.json` excludes
only `node_modules`, `test`, `dist` and specs. `.mjs` is invisible to TypeScript;
`.mts` is not. Left alone, `pnpm build` would start emitting `dist/db/` and the
instruments' type errors would fail the application build.

Both files get `db` added to `exclude`. This is the one change here that has
nothing to do with the conversion reading well and everything to do with it not
breaking the app.

## Typechecking, or the types are decoration

A `.ts` file nothing checks is a `.mjs` file with extra words in it. Two configs,
because k6 and Node have disjoint globals — a k6 script has `__ENV` and no
`process`, a host script has `process` and no `__ENV`:

- `tsconfig.json` (root) — `scripts/**/*.ts` + `apps/backend/db/**/*.mts`, `types: ["node"]`
- `k6/tsconfig.json` — `k6/**/*.ts`, `types: ["k6"]`

Both are `strict`, `noEmit`, `erasableSyntaxOnly`, `verbatimModuleSyntax`
(so a type-only import that is not marked `type` is an error rather than a runtime
crash) and `allowImportingTsExtensions`.

`pnpm typecheck` runs both. This adds two root devDependencies — `typescript` and
`@types/node`, both already present under `apps/backend` but not resolvable from the
root. `@types/k6` is already a root devDependency.

`pg-copy-streams` ships no types, so `types/pg-copy-streams.d.ts` declares the one
export the seeder uses.

## What gets typed

Types where they carry a fact, not everywhere:

- The knob catalogs in `scripts/measure.ts` and `scripts/load.ts` — one `Knob`
  shape, so a catalog entry missing `env` or `def` is a compile error rather than a
  knob that silently does nothing. That is the exact bug the whole
  `instrument-hardening` branch was about.
- The `EXPLAIN … FORMAT JSON` node shape in `db/explain.mts` and `db/search.mts`.
  `plan.Plan['Node Type']` and `scan['Shared Hit Blocks']` are read by string key in
  four places; one interface names them once.
- k6's `handleSummary` data, minimally — `@types/k6` types `Options` but not the
  summary payload.

`pg`'s own typings return `QueryResult<any>`, so `rows[0].n` stays `any` and the SQL
result handling does not grow a cast per query.

## Files

```
scripts/setup.sh          → scripts/setup.ts       (CLAUDE.md: scripts are Node, not shell)
scripts/check-arms.mjs    → scripts/check-arms.ts
scripts/load.mjs          → scripts/load.ts
scripts/measure.mjs       → scripts/measure.ts
scripts/psql.mjs          → scripts/psql.ts

k6/conversations-baseline.js → .ts
k6/messages-search.js        → .ts
k6/lib/scenario.js           → .ts

apps/backend/db/bench-copy.mjs     → .mts
apps/backend/db/check-tenancy.mjs  → .mts
apps/backend/db/explain.mjs        → .mts
apps/backend/db/paging.mjs         → .mts
apps/backend/db/search.mjs         → .mts
apps/backend/db/seed.mjs           → .mts
apps/backend/db/stats.mjs          → .mts
apps/backend/db/lib/corpus.mjs     → .mts
apps/backend/db/lib/run.mjs        → .mts
```

New: `tsconfig.json`, `k6/tsconfig.json`, `types/pg-copy-streams.d.ts`.

Edited: root `package.json` (script paths, two devDeps, `typecheck`),
`apps/backend/package.json` (script paths), `apps/backend/tsconfig.json` and
`tsconfig.build.json` (exclude `db`), `apps/backend/eslint.config.mjs` (ignore
`.mts` alongside `.mjs`).

## `scripts/check-arms.ts` has to be edited, not just renamed

It reads the other files as *text*, so every path and extension in it is a literal
that the rename invalidates. Four of them:

- `walk('apps/backend/db', '.mjs')` → `'.mts'`
- `walk('k6', '.js')` → `'.ts'`
- `read('scripts/measure.mjs')` → `'scripts/measure.ts'`
- `read('scripts/load.mjs')` → `'scripts/load.ts'`

Its regexes over those files (`env: '…', def: '…'`, `__ENV.X || '…'`, `file: 'db/…'`)
must keep matching, so the catalogs keep their literal shape and the type
annotations go on the surrounding `const`, not inside the object literals.

`check:arms` going green is therefore the main functional test of this branch: it is
the one thing that reads all three directories and fails when a knob stops reaching
the code that reads it.

## Verification

Static:

```bash
pnpm typecheck
pnpm format && pnpm lint
pnpm build
pnpm check:arms
```

Live, against the existing seeded volume (`drills_drills_pgdata`):

```bash
pnpm docker:up
pnpm arms
pnpm db:migrate:status
pnpm db:log:status
pnpm check:tenancy
pnpm db:stats
pnpm db:explain stats
pnpm db:paging depths --depths 1,10 --rounds 1
pnpm load list --org 150 --warmup 5s --duration 10s --name ts-smoke
```

The k6 run is the one that proves the rename did not move the report directory
name. Its output directory must still read `…-ts-smoke-conversations-baseline-org150-vus10-page1-size20-10s`.

`pnpm db:seed` is **not** re-run: it is ~213s and would rewrite the volume every
instrument above is measuring against. `db/seed.mts` is covered by `pnpm typecheck`
and by `node --check`-equivalent module load, not by a full seed.

## Honest gaps

- **No behavioural test suite for these files.** There never was one — the
  instruments are checked by running them. This branch does not add one, so the
  evidence that the conversion is faithful is the verification list above and the
  diff being annotations only.
- **`strict` is new to this code.** Every place the checker forced a change
  (a `?.`, a null guard, a narrowed `catch`) is a place the `.mjs` version could
  have thrown at runtime. Those are fixes, but they are also the only lines in the
  diff that are not pure annotation, and they should be read as such.
- **Type stripping is still flagged experimental in Node.** It is on by default and
  needs no flag, but the feature is not frozen. If it were removed, the fix is one
  `tsx` devDependency and a `node --import tsx` in five package.json entries.
