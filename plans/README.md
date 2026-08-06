# Plans

One file per feature, written before implementation: `YYYY-MM-DD_short-name.md`, dated the day it was written. Warranted for work spanning more than one file, adding a dependency, or setting a pattern — the bar is defined in `CLAUDE.md` step 2. Plan mode cannot write files, so the file is created immediately after the plan is approved, before any code.

Each plan opens with a status line under its title:

    **Status:** planned | in progress | shipped | abandoned — <reason>

That line is the only part edited after the fact, and it's what makes this directory readable later — `grep -l '^\*\*Status:\*\* shipped' plans/*.md`. The body stays as written: the gap between what was planned and what shipped is the useful part. Divergence gets recorded in `memory-bank/`, which is maintained separately.
