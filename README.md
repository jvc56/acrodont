# Acrodont

Word-study cascades for crossword game players: build a quiz from a lexicon
with filters, study it offline, and let the misses fall into the next level.
PLAN.md is the specification.

| To | Run or read |
|---|---|
| Develop | `./scripts/dev.py` (PLAN.md § Development; `--help` for scenarios, real catalogs, two devices) |
| Load CSW24 (definitions, leaves) in dev.py | nothing: the first `./scripts/dev.py` downloads it into the gitignored `fixtures/licensed/` (`python3 scripts/build-licensed-catalog.py` rebuilds it), from [CrowdsourcedDefs](https://github.com/jvc56/CrowdsourcedDefs/tree/main/editions/2) and [MAGPIE-DATA](https://github.com/jvc56/MAGPIE-DATA/tree/main/data) at pinned commits |
| Test | `make test-quick`, `make test-integration`, `make test-e2e SPEC=<spec>` while working; push, and CI runs the rest. `make test`, `make infra-validate`, `make ops-check`, `make contract-check` (PLAN.md § Running the tests) |
| Walk the site by hand before a launch | JOURNEYS.md |
| Operate production | docs/runbook.md: one-time setup, `scripts/deploy.sh`, rollback, alarms, backups |
| Resume development work | docs/progress.md and docs/plan-index.md |
