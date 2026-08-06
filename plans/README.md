# Plans

One file per feature, written before implementation: `YYYY-MM-DD_short-name.md`, dated the day it was written.

Each plan opens with a status line under its title:

    **Status:** planned | in progress | shipped | abandoned — <reason>

That line is the only part edited after the fact, and it's what makes this directory readable later — `grep -l 'Status:.*shipped' plans/*.md`. The body stays as written: the gap between what was planned and what shipped is the useful part. Divergence gets recorded in `memory-bank/`, which is maintained separately.
