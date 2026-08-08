# Project Brief

Foundation document. Source of truth for scope — when the other files disagree, this one wins.

## What this is

A learning repo. I build one app across a long series of drills, each drill breaking something on purpose and measuring it, so the understanding is real rather than read.

## The app

A multi-tenant customer-feedback platform — orgs, users, conversations, messages, tags, ingest, background jobs. It grows drill by drill; no schema is built up front.

## What I'm learning

Postgres past CRUD (indexes, plans, locks, migrations at scale), concurrency and atomicity, caching and invalidation, failure and resilience, running a backend myself (pooling, shutdown, replicas, load testing), observability, and the Next App Router.

Also, I'm new to these tech/tools, so after implementation make sure to give me to-the-point guides on
how to do the things you just did and why.

## Non-goals

No auth (identity is stubbed on purpose), no UI polish.
