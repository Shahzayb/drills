# Instrument run records

One directory per run of `db:explain`, `db:paging`, `db:search` or `db:bench`,
named the same way `k6/reports/` names its own: timestamp, optional `NAME`
label, instrument, subcommand, org.

Each holds:

- `run.json` — the resolved knobs with their provenance (`env` or `default`),
  the arm state the API reported, the git SHA the run was made at, and the
  result table where the instrument produces one.
- `output.txt` — everything the run printed.

Cite a directory from a plan or a drill instead of retyping a number. A number
copied out of scrollback leaves its conditions behind, which is how a `pageSize=50`
figure ended up in a sentence about a `pageSize=20` run.

`NAME=rls-on pnpm db:paging depths` labels the arm. Pruning is by hand, the same
as `k6/reports/`, because a deleted record is a deleted measurement.

See `plans/2026-08-30_instrument-hardening.md`.
