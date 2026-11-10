# Acrodont

Word-study cascades for crossword game players: build a quiz from a lexicon
with filters, study it offline, and let the misses fall into the next level.
PLAN.md is the specification.

| To | Run or read |
|---|---|
| Develop | `./scripts/dev.py` (PLAN.md § Development; `--help` for scenarios, real catalogs, two devices) |
| Load CSW24 (definitions, leaves) by default in dev.py | once per machine: `python3 scripts/build-licensed-catalog.py --name CSW24 --definitions ~/Dropbox/WordGameMisc/csw24.tsv --playability ~/Dropbox/WordGameMisc/CSW19-Playability.txt --leaves ~/Dropbox/WordGameMisc/CSW24.csv` (writes the gitignored `fixtures/licensed/`) |
| Test | `make test`, `make test-scale`, `make infra-validate`, `make ops-check` (PLAN.md § Running the tests) |
| Walk the site by hand before a launch | JOURNEYS.md |
| Operate production | docs/runbook.md: one-time setup, `scripts/deploy.sh`, rollback, alarms, backups |
| Resume development work | docs/progress.md and docs/plan-index.md |
