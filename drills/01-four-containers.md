# 01 — Get four containers talking

2026-08-06 · not evenings, one continuous session (see note below) · setup tax not separately timed · delivery · portable backend · observability

> **On "evenings actually spent" and "setup tax":** this drill was built and
> verified by an agent in one sitting, not across the card's 2-evening
> timebox, so there's no honest evening count to give — recording one would
> be theater. What *is* true: the work happened in two passes — an initial
> implementation, then a second pass after checking it against the card,
> which added the `query()`/Redis chokepoints, the `/info` endpoint, the Next
> page, and this writeup. Setup tax (reading the existing scaffold and
> `memory-bank/` before the first line of database code) wasn't clocked
> separately either. Both are worth timing for real on the next card.

## What I predicted

Not journaled prospectively — implementation and measurement happened in the
same pass, so there's no true "before" snapshot to hold up against the
"after." Reconstructing honestly rather than inventing a clean prediction:

- Expected the `pg` Pool to be inert until first query and therefore safe to
  construct unconditionally. True, but incomplete — I didn't predict that an
  *idle* pooled client emits its own `error` event when Postgres restarts.
  I'd already reasoned through that exact failure mode for the Redis client
  (added an `on('error')` listener there from the start) and didn't carry the
  same reasoning over to Postgres. Found out by killing the container and
  watching the process die.
- Expected `lazyConnect` to be enough to keep the Jest suites green with no
  Docker running. Correct, verified.
- Expected Docker's build cache to make a second build meaningfully faster
  than a `--no-cache` one. Wrong — see below.

## What I measured

**Cold start, clean clone → first working page.** Copied the source tree to
a scratch directory the way a real clone would look (no `node_modules`, no
`.next`/`dist`, no `.git`, `.env` freshly copied from `.env.example`), ran it
as an isolated Compose project so it couldn't reuse this machine's cached
images, timed to the first page load that actually renders the Postgres
value. One run each, not averaged — noise floor unmeasured.

| | Layer cache warm | `--no-cache` |
|---|---|---|
| `docker compose build` | 88s | 90s |
| `up -d` → all containers healthy | 20s | 19s |
| First working page load | 4s | 4s |
| **Total** | **112s** | **113s** |

Per-step breakdown of the build (from the BuildKit log, warm run):

| Step | Time | % of build |
|---|---|---|
| `pnpm install --frozen-lockfile` | 64.6s | 73% |
| exporting both images (parallel) | 21.4s | 24% |
| base image, `WORKDIR`, `COPY` | ~2s | 2% |

**Time-to-unhealthy**, before and after tuning the healthcheck cadence
(`interval`/`retries`, one line each in `docker-compose.yml`): killed
Postgres, watched `docker inspect`. **48s → 7s.** Endpoint itself flips to
503 in ~1s either way — the 48s/7s is entirely the container-health polling
cadence, not detection latency.

**Memory**, steady state, four containers: 926 MiB used of 5,632 MiB
allocated (16.4%). Backend 37%, frontend 50%, Redis 2%, Postgres 1% of their
individual limits.

**Persistence**: wrote a Postgres row and a Redis key, ran `down && up`, both
came back. Postgres 18 moved `PGDATA` under the mounted volume
(`/var/lib/postgresql/18/docker`), so this wasn't a given — checked it
directly rather than trusting the mount path.

## What surprised me

**The cache didn't cache.** Warm (88s) and `--no-cache` (90s) landed within
2s of each other — meaning the thing I called "layer cache" wasn't doing
anything. `.dockerignore` deliberately excludes `node_modules` from the build
context (so a stale tree never gets baked into the image), which means
`pnpm install` re-resolves from the lockfile on *every* build regardless of
Docker's cache. The 65% of build time is a self-inflicted cost from a
decision made for a good reason, and I didn't connect the two until I saw
the numbers side by side.

**One `pnpm install`, not two.** `nest_server` and `next_app` build from the
identical `Dockerfile` and context. I expected two separate installs (one per
image) and the log shows one — BuildKit deduplicates the identical step
across both build targets automatically. The two images only diverge at the
export step, which is why exporting (21.4s × 2, in parallel) shows up
separately but installing doesn't.

**The crash**, covered under predictions — worth repeating here because it's
the actual finding, not a footnote: an unconditional-200 health endpoint
would have hidden a real process crash and made it look like a mystery
restart instead of a missing `error` listener.

**Two lines cut healthcheck detection by 85%** (48s → 7s) with no other
change. Cheap enough that there's no reason the default should have been
slow.

## The three questions

**What does the health endpoint check, and what would a shallow one have
hidden?** `SELECT 1` through the same `pg` pool the app uses, `PING` through
the same Redis client — not side connections, not bare TCP dials. Real-pool
checks catch things a TCP check can't: wrong password or database name
(Postgres accepts the socket, then refuses the session), `requirepass` on
Redis (same shape), and pool exhaustion (a side connection connects
instantly and reports healthy while the real pool is starved). What it does
*not* check, on purpose: that queries against real tables work, that
migrations are applied, replication lag. This is reachability and liveness,
not correctness — and the clearest evidence for why it has to be a *real*
check is the crash above, which a shallow one would have hidden completely.

**What changed in the Next starter to talk to a service by name?** Four
things, one of which is the actual lesson. Added `BACKEND_INTERNAL_URL=
http://nest_server:3002` to `.env`/`.env.example` (no compose change needed —
`env_file` already reaches every service); `lib/api.ts` reads it and returns
a result object instead of throwing; `app/page.tsx` became an `async` server
component; no rewrite, no proxy, no `next.config.ts` change. The lesson is
*where the fetch runs*, not the URL string: `nest_server` only resolves on
the Compose network, so this fetch can only ever live in a server component
— a client component would need the published `localhost:3002` instead,
because the browser isn't on that network. Choosing service-name addressing
and choosing server-side rendering turned out to be the same decision, not
two. Side note verified rather than assumed: Next 16's `fetch` isn't cached
by default, so the `cache: 'no-store'` older Next needs here is unnecessary —
confirmed by watching the database timestamp on the page change every
reload.

**Pool `max`, and the reasoning?** `10`, with `connectionTimeoutMillis: 2000`
and `idleTimeoutMillis: 30000`. Grounded in a measured number, not a guess:
Postgres reports `max_connections = 100`, `superuser_reserved_connections =
3`, so 97 are actually available. 10 per API container leaves room for
roughly nine replicas before Postgres itself refuses connections, with
headroom for interactive `psql` sessions during later drills. Node is
single-threaded for JS, so pool size should track database capacity and
expected concurrency, not the container's CPU count (which reports 14 here —
that's the host leaking through, not a real limit). This is a starting
hypothesis with no load behind it yet; Card 12 is explicitly where it should
have to defend itself.

## What I'd do differently at 10x

Two things, in order of how much time they'd actually save. First, the build:
if this needed to iterate faster at scale, I'd stop treating "exclude
`node_modules` from the build context" and "cache installs across builds" as
the same constraint — a `pnpm fetch` step with a mounted store cache
(`--mount=type=cache,target=/pnpm-store`) would let every build skip the
network fetch without ever baking a stale tree into the image, which is the
actual thing `.dockerignore` was protecting against. That alone should cut
the dominant 65% of build time without giving up the property that made me
exclude `node_modules` in the first place. Second, the pool number: `max: 10`
is defensible today because I can point at `max_connections`, but at 10x
traffic it needs to be set from an actual load test against Card 12's
scenario, not from arithmetic on a config value — the difference between "a
number I can explain" and "a number I've watched hold under load" is exactly
the gap this drill can't close by itself.

## Loose ends

- `GET /info` returns Nest's default 500 on a Postgres failure, not 503 — the
  page still renders the outage correctly because `lib/api.ts` catches the
  non-OK response either way, but the status code isn't saying the right
  thing and I didn't fix it.
- The healthcheck cadence (`interval: 5s, retries: 2`) is a guess at a
  reasonable failure-detection speed, not measured against how often it'd
  false-positive on a transient blip under real load.
- `next dev`'s 4s compile-on-first-request cost is in every cold-start number
  above; haven't measured what a production `next build` changes that to.
- The `/health` 2s probe timeout, the pool's 2s connection timeout, and
  Redis's 2s `commandTimeout` all match by choice, not by a shared constant —
  if one of these needs to change later it'd be easy to change it in one
  place and forget the others are supposed to agree.
- No noise floor on any of the timing numbers above — everything is a single
  run. Worth knowing before trusting the 112s/113s comparison too far.
