# Wordfall

Word-study cascades for crossword game players: build a quiz from a lexicon
with filters, study it offline, and let the misses fall into the next level.
PLAN.md is the specification.

| To | Run or read |
|---|---|
| Develop | `./scripts/dev.py` (PLAN.md § Development; `--help` for scenarios, real catalogs, two devices) |
| Test | `make test`, `make test-scale`, `make infra-validate`, `make ops-check` (PLAN.md § Running the tests) |
| Walk the site by hand before a launch | JOURNEYS.md |
| Operate production | docs/runbook.md: one-time setup, `scripts/deploy.sh`, rollback, alarms, backups |
| Resume development work | docs/progress.md and docs/plan-index.md |
