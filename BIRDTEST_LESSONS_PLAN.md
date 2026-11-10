# Lessons from birdtest: a plan for acrodont

**Date:** 2026-11-08
**Status:** implemented on 2026-11-09, apart from the steps that need an AWS
account (see "Implementation status" below). The decisions D1–D6 were taken
as recommended.

## Implementation status (2026-11-09)

After this plan was written, the owner set the scale: one user at first, up to
about ten within months, **at most about 50 accounts, 20 cascades each, and
130,000 questions per quiz**. It was implemented with those limits, and with
these extra cost savings on top of section 2:

| Change | Why it is safe at this scale | Saves |
|---|---|---|
| App task 0.5 vCPU / 2 GiB (not 1 vCPU / 4 GB) | With 50 accounts the server is idle; `EXPORT_CONCURRENCY=1` bounds memory to the catalog plus one export; `SEARCH_TIMEOUT_MS` raised to 4 s for the half core | ~$21 → see next row |
| **Fargate Spot** for the app task (`use_fargate_spot`, default true) | Acrodont is local-first: studying never needs the server and sync retries, so a Spot interruption's minute or two without the API goes unnoticed. Birdtest rejected Spot only because its API is its product | ~$21 → ~$7 |
| `MAX_ACCOUNTS=50` closes registration | Bounds database growth and the SES bounce rate a visitor could drive | — |
| `db.t4g.micro`, 20 GiB, 7-day PITR | As COST-3 | ~$53 → ~$14 |

**Result:** about **$53 a month** (about $67 with Spot off), against ~$290
for the original Terraform defaults. The remaining floor is the load balancer,
its public addresses and RDS, about $43 together. The only way below it is a
different architecture: one small EC2 instance running Postgres and the app,
with no ALB and no RDS, at about $15–25 a month. That gives up managed
backups, point-in-time recovery and gapless deploys, and means rewriting the
deploy, backup and ops tooling. It was not done; it is the owner's call.

| Item | Status | Notes |
|---|---|---|
| DEV-1 dev.py v2 | Done, phases A–D | `scripts/dev.py`, `scripts/scenarios.py`, `stack.py` (outbox, `ensure_user`, fast failure when the backend stops). Scenarios seed through the API, reading quiz state with SQL as the integration tests do. They did not need `reference.py`: the server computes each next level itself |
| DEV-2 snapshots | Done | `--snapshot` / `--restore`, `scripts/scrub.sql` |
| DEV-3 loopback | Done | `BIND_HOST` |
| DEV-4 build caps | Done | Dockerfile, compose and Makefile; CI uses 4 |
| DEV-5 outbox | Done | `MAIL_BACKEND=file`; `stack.py` and the e2e helper read it, falling back to the log |
| DEV-6 JOURNEYS.md | Done | |
| COST-1 | Done | Export semaphore; 0.5 vCPU / 2 GiB; one task. `dev.py --stats` measures the catalog |
| COST-2 | Done | No NAT; tasks in public subnets |
| COST-3 | Done | Micro, 20 GiB, `db_backup_retention_days` 7, `apply_immediately` |
| COST-4 | Done | Container Insights off, 30-day logs, ECR keeps 40 images |
| COST-5 | Done | `infra/budget.tf`: budget $70, anomaly ≥ $10, `cost_scope` for a shared account |
| DEP-1 | Done | `scripts/deploy.sh`; one `image_tag` variable; `deploy.yml` and `github.tf` removed |
| DEP-2 | Done | Circuit breaker, deploy-failed rule, rollout check of image, CPU and memory |
| DEP-3 | Done | 100/200, deregistration 15 s, `stopTimeout` 120 |
| DEP-4 | Done | `migrator()` with `ignore_missing`, an integration test, and `scripts/rollback.sh` (release history from ECR) |
| EDGE-1–4 | Done | `frontend/src/lib/nginx-config.test.ts` pins them; export tokens kept out of the access log |
| MIG-1–2 | Done | `backend/build.rs`; files touched before the cached cargo build |
| MIG-3 | Done | Policy in PLAN.md § Schema; `deploy.sh` refuses changed migrations; `make sqlx-db` applies every migration |
| MIG-4 | Done | `load_ms` logged; `health_check_start_period` (240 s) in Terraform. The measurement is in the commit message |
| MON-1–3 | Done | `alarm_email` required; `scripts/check-alerts.sh`; the alarm table in docs/runbook.md; a failed nightly opens an issue; images and actions pinned |
| MAIL-1–4 | Done | Queue and rate, suppression, reputation and failure alarms, MAIL FROM and DMARC outputs, hashed addresses, `scripts/confirm-user.sh` |
| SEC-1 | Done | SSM by ARN; `scripts/init-db-roles.sh` creates the parameters |
| SEC-2 | Done | Exec logging off, Exec off on the app, ops task; the broken runbook command is gone |
| SEC-3 | Done | 17 offline `terraform test` cases |
| SEC-4 | Done | ALB drops invalid headers, the backups bucket requires TLS, actions pinned by SHA, base images by digest |
| OPS-1–3 | Done | The ops scripts over `scripts/lib/ops.sh`, 24 harness cases; docs/runbook.md rewritten around the two-phase first apply |
| BAK-1 | Done | `scripts/drill.py`, monthly, on the ops image |
| BAK-2 | Done | Failure rules; the backup role reads only `daily/` (to copy monthly dumps); SIGTERM handled |
| CI-1 | Mostly | Parallel jobs and clippy. **Not done:** caching the e2e job's Docker builds across runs (needs a CI experiment) and nextest partitions (the integration job runs in about 7 minutes as is) |
| CI-2 | Done | `make infra-validate` runs fmt, validate and `terraform test` |
| PROC-1 | Ready | The template is in this plan, for after launch |
| PROC-2 | Partly | Field errors, server-matching validation and dates were already right. The phone-width check of the remaining pages and the wording pass are items in JOURNEYS.md for a person to do |

**Not testable without AWS**, so not yet run for real: the first apply,
`deploy.sh` against ECS, `init-db-roles.sh` against RDS (its SQL was checked
against a Postgres 16 with a non-superuser master), and SES. The operator
scripts are exercised end to end against fakes in `make ops-check`.
**Sources:**
- birdtest at `58762a0`. It has been live since 2026-10-05/06, on the same stack as acrodont: Rust/Axum, a SvelteKit SPA behind Nginx, Postgres 16 on RDS, ECS Fargate, an ALB, SES, Terraform and Playwright.
- birdtest's `scripts/`, `infra/`, `COST_REDUCTION_PLAN.md`, `LAUNCH_PLAN.md`, the `UPDATES_PLAN_*.md` files, `RUNBOOK.md`, `TESTING.md`, the `KL-*` known limits in `PLAN.md`, and its 434 commits.
- acrodont at `0c1c6a3`: Phase 8 is prepared, and no AWS account has been applied yet.

## How to read this

Each item has four parts:
- **Problem:** what is wrong or missing in acrodont today, and what birdtest learned about it.
- **Options:** the possible solutions.
- **Recommendation:** the one to pick.
- **Effort:** S (an hour or two), M (a day), or L (several days).

Priorities:

| Priority | Meaning |
|---|---|
| **P0** | Do before the first `terraform apply`. These are cheap now, and afterwards they cost an outage, a leaked secret or a migration. |
| **P1** | Do before real users arrive. |
| **P2** | Do after launch, or when convenient. |

Birdtest found most of its infrastructure bugs in two ways: 33 automated audit passes before launch, and its first real applies and deploys. The bugs below that acrodont shares are the cheapest to fix before acrodont's first apply.

Section 13 lists the things that look like they should come over from birdtest but should not. Section 14 lists what acrodont already does right, so you can see it was checked.

---

## Summary

| ID | Item | Priority | Effort |
|---|---|---|---|
| [DEV-1](#dev-1-scriptsdevpy-v2) | `scripts/dev.py` v2, a birdtest-grade dev environment | P1 | L, in four phases |
| [DEV-2](#dev-2-local-snapshots-and-scrubbed-restores) | Local snapshots and scrubbed restores | P2 | M |
| [DEV-3](#dev-3-compose-publishes-ports-on-every-interface) | Compose publishes ports on every interface | P0 | S |
| [DEV-4](#dev-4-cap-build-parallelism) | Cap build parallelism (birdtest's builds froze this machine) | P1 | S |
| [DEV-5](#dev-5-a-mail-outbox-instead-of-log-scraping) | A mail outbox instead of log scraping | P2 | M |
| [DEV-6](#dev-6-journeysmd-a-manual-launch-checklist) | `JOURNEYS.md`, a manual launch checklist | P1 | M |
| [COST-1](#cost-1-the-task-is-sized-for-a-guess-not-a-measurement) | Size the ECS task from a measurement | P0 | M |
| [COST-2](#cost-2-the-nat-gateway) | The NAT gateway (about $37/month) | P0 | S |
| [COST-3](#cost-3-rds-class-storage-and-pitr-window) | RDS class, storage and PITR window | P0 | S |
| [COST-4](#cost-4-the-small-recurring-charges) | Small recurring charges | P1 | S |
| [COST-5](#cost-5-budget-and-anomaly-alerts) | Budget and anomaly alerts, in Terraform | P0 | S |
| [DEP-1](#dep-1-two-sources-of-truth-for-what-is-running) | Two sources of truth for what is running | P0 | M |
| [DEP-2](#dep-2-a-release-whose-task-cannot-start) | A release whose task cannot start | P0 | S |
| [DEP-3](#dep-3-ecs-and-target-group-settings) | ECS and target-group settings | P0 | S |
| [DEP-4](#dep-4-rolling-back) | Rolling back | P1 | M |
| [EDGE-1](#edge-1-nginx-closes-connections-the-alb-still-uses) | Nginx closes connections the ALB still uses (502s) | P0 | S |
| [EDGE-2](#edge-2-a-missing-chunk-is-cached-for-a-year) | A missing chunk is cached for a year | P0 | S |
| [EDGE-3](#edge-3-static-assets-are-not-compressed) | Static assets are not compressed | P1 | S |
| [EDGE-4](#edge-4-smaller-nginx-hardening-and-a-config-test) | Smaller Nginx hardening, and a test that pins the config | P1 | S |
| [MIG-1](#mig-1-a-new-migration-can-ship-without-being-compiled-in) | A new migration can ship without being compiled in | P0 | S |
| [MIG-2](#mig-2-the-docker-build-can-ship-a-stale-binary) | The Docker build can ship a stale binary | P0 | S |
| [MIG-3](#mig-3-the-schema-policy-after-the-first-deploy) | The schema policy after the first deploy | P0 | S (decision) + M (tooling) |
| [MIG-4](#mig-4-startup-time-against-the-health-checks) | Startup time against the health checks | P1 | S |
| [MON-1](#mon-1-alarms-that-go-nowhere) | Alarms that go nowhere | P0 | S |
| [MON-2](#mon-2-missing-alarms) | Missing alarms | P0 | M |
| [MON-3](#mon-3-nightly-failures-nobody-sees) | Nightly failures nobody sees | P1 | S |
| [MAIL-1](#mail-1-a-burst-of-registrations-exceeds-sess-send-rate) | A burst of registrations exceeds SES's send rate | P1 | M |
| [MAIL-2](#mail-2-ses-reputation-and-failed-sends) | SES reputation and failed sends | P1 | S |
| [MAIL-3](#mail-3-ses-setup-that-terraform-does-not-cover) | SES setup that Terraform does not cover | P1 | S |
| [MAIL-4](#mail-4-email-addresses-in-production-logs) | Email addresses in production logs | P1 | S |
| [SEC-1](#sec-1-secrets-in-terraform-state) | Secrets in Terraform state | **P0** | S |
| [SEC-2](#sec-2-ecs-exec-into-the-serving-task) | ECS Exec into the serving task, and a broken runbook command | P0 | M |
| [SEC-3](#sec-3-variable-validations-and-terraform-test) | Variable validations and `terraform test` | P1 | M |
| [SEC-4](#sec-4-the-hardening-checklist-birdtest-wrote-too-late) | The hardening checklist birdtest wrote too late | P1 | S |
| [OPS-1](#ops-1-running-sql-in-production) | Running SQL in production | P0 | M |
| [OPS-2](#ops-2-procedures-as-tested-scripts) | Procedures as tested scripts | P1 | M–L |
| [OPS-3](#ops-3-the-first-apply) | The first apply | P0 | S |
| [BAK-1](#bak-1-the-restore-drill-is-manual) | The restore drill is manual | P2 | M |
| [BAK-2](#bak-2-a-failed-backup-only-alarms-36-hours-later) | A failed backup only alarms 36 hours later | P1 | S |
| [CI-1](#ci-1-one-serial-ci-job) | One serial CI job | P1 | M |
| [CI-2](#ci-2-terraform-is-not-checked-in-ci) | Terraform is not checked in CI | P1 | S |
| [PROC-1](#proc-1-dated-update-plans) | Dated update plans | P2 | S |
| [PROC-2](#proc-2-ux-lessons-from-birdtests-first-week) | UX lessons from birdtest's first week | P2 | S each |

---

## 1. Development environment

### DEV-1. `scripts/dev.py` v2

**Problem.**

Acrodont already has a `scripts/dev.py` (95 lines), a thin layer over `scripts/stack.py`. It runs `compose up -d --build`, registers and promotes a `dev` user, uploads the fixture catalog, opens the browser and exits.

Birdtest's `scripts/dev.py` (1,031 lines) is what made birdtest pleasant to develop. The features acrodont's lacks are these:

| Birdtest dev.py does | Acrodont dev.py today |
|---|---|
| Runs in the foreground: Ctrl-C stops everything, unless `--keep-up` | Detaches and exits; the stack runs until `--down` |
| Opens the site **already signed in** (`/api/dev/login`, `--login-as USER`, `--no-login`) | Opens the site signed out and prints a password |
| Job flags (`--games-job`, `--pairs-job`, …) seed the states you want to work on, and they stack | Seeds only the catalog and one user |
| `--fresh` starts as a brand-new deployment does, and prints the first-admin steps | No equivalent |
| Checks prerequisites up front and fails naming what is missing | Fails part-way through |
| `explain_failed_start()`: a changed migration means "run `--reset-db`"; otherwise a host port in use means "use `--web-port`"; it points at compose's own error | Prints a Python traceback, or the backend log after a 15-minute health deadline |
| `--reset-db` **stops the backend first**, so migrations rerun on the empty schema (6327571) | `--reset` drops the volume, which is also correct, but slower |
| Reads `.env`, so a port set there applies to both compose and the script (939c439) | Ignores `.env` |
| Holds a lock so a second run cannot drop the database under the first (acb79dc) | No lock |
| `--rebuild` is opt-in | Always builds. With cache mounts this is mostly incremental, but every restart pays for it |
| Keeps running the background work production's scheduler would do | Not needed: acrodont's purge runs in-process |
| Shares `scripts/seed.py` with the tests, so dev cannot drift from what the tests exercise | Already true: `stack.py` is shared, and it is the right design |

**Options.**
1. Leave dev.py as it is and document workflows in the README.
2. Port birdtest's dev.py wholesale. Most of it is worker and MAGPIE plumbing that acrodont does not have (section 13).
3. Grow acrodont's dev.py into a supervisor with acrodont-shaped features. Keep `stack.py` as the one definition of "a working Acrodont", and add the new capabilities to `stack.py` as entry points, so the e2e and scale suites can use them too.

**Recommendation: option 3.**

Proposed command line. Existing flags stay; new ones are marked ★.

```text
./scripts/dev.py                         build, up, seed fixtures and the dev admin, open the browser
                                         signed in, stream a filtered log; Ctrl-C stops the stack
  --keep-up ★                            leave the stack running on Ctrl-C
  --detach ★                             today's behaviour: up, seed, open, exit (stack.py users keep this)
  --no-build ★                           restart without rebuilding images (fast iteration on config)
  --reset                                drop the database (stopping the backend first) and the built frontend
  --fresh ★                              a new deployment: --reset, then no user, no catalog; prints the
                                         first-admin steps for local and for production (OPS-1's prod-sql.sh)
  --real-catalog [DIR] ★                 also upload licensed files listed in DIR/manifest.json
                                         (default $ACRODONT_CATALOG_DIR); never committed
  --scenario NAME ★ (repeatable)         seed a study state through the real API (see below)
  --users N ★                            N extra confirmed users (dev2, dev3, …) for multi-account work
  --login-as USER ★ / --no-login ★       which account the browser opens signed in as
  --two-devices ★                        open two isolated Chromium profiles signed in as the same user,
                                         the quickest way to watch sync (PLAN.md § Day to day)
  --stats ★                              after the catalog loads, print each index's size and the backend
                                         container's resident memory (feeds COST-1)
  --snapshot NAME ★ / --restore NAME ★   see DEV-2
  --hot-reload, --project, --port, --env KEY=VALUE, --no-browser, --quiet, --down [--volumes]
```

**Scenarios.** These are the acrodont equivalent of birdtest's job flags. Each one creates a state you would otherwise click your way into.

| Scenario | What it seeds |
|---|---|
| `studying` | An Anagram cascade on EN-FIX, part way down its ladder: Level 1 finished with misses, Level 2 in progress, some grades on the server |
| `finished` | A cascade whose last level is complete, so it shows the completion screen |
| `segments` | A cascade with segments, one segment finished and the next started |
| `typed` | An Anagram cascade with typed mode on |
| `trash` | A trashed cascade and a cleared quiz, with `TRASH_RETENTION_DAYS` short enough to watch the purge |
| `limits` | The user at the cascade-limit warning (90 of 100), and near the saved-search limit |
| `big` | One 300,000-question cascade from `--real-catalog`, to feel the scale budgets in a real browser |
| `saved-searches` | A handful of saved searches, including a large In Word List |

**How scenarios are seeded.**
- Through the real API, never through SQL: `POST /api/cascades`, then `POST /api/sync` with grade, move and finish operations. This keeps the "seeding is a smoke test" property both projects rely on.
- The operations come from `contract-fixtures/tools/reference.py`, the independent Python model of the cascade rules. It can already step a cascade, so it can produce a valid operation sequence for "Level 2, 40% through", and the server checks those operations as it would any device's.
- Scenarios are idempotent: each one finds its cascade by name and reuses it.

**Behaviour to carry over from birdtest:**
- **Preflight before touching anything:** Docker and compose v2 are present; the ports are free (5432 on this machine belongs to another project, per `docs/progress.md`); the `--real-catalog` files exist and have the right column counts. If anything is missing, fail and name it.
- **Explain a failed start.** If the backend log contains SQLx's `previously applied but has been modified`, say "run with `--reset`". If a port is in use, name the flag that moves it. Otherwise point at compose's own error, not the backend log.
- **The foreground log watcher.** Stream the backend's JSON log, filtered:
  - errors and warnings;
  - `sync operation rejected` lines (the PLAN's divergence signal);
  - for each console mail, a ready-to-click confirm or reset link built from `PUBLIC_URL` and the code. Birdtest prints a `grep` command for this; acrodont can print the link itself.
  - Show the "mail is in the log" hint only when `MAIL_BACKEND=console` (0cbbe1b).
- **One lock per `--project`**, taken before any reset.
- **Read `.env`** for `ACRODONT_PORT` and similar; a variable already set in the environment wins.
- **After `--reset`**, keep today's reminder to clear the browser's site data. With `--two-devices`, delete the two profiles' directories for the user.

**Dev sign-in needs more than birdtest's version.** Birdtest's `/api/dev/login` only sets a cookie, and that works because birdtest's SPA asks `/api/me` on load. Acrodont's SPA signs in from its own IndexedDB pointer (`frontend/src/lib/auth/session.svelte.ts`, `initSession`): a cookie it did not create through `login()` is ignored, and a cookie for a different user sets `needsLogin`. So the plan is:
- **Backend:** add `DEV_LOGIN` (accepts only `true` or `false`, default `false`). Startup **refuses** `DEV_LOGIN=true` together with `SECURE_COOKIES=true`, exactly as birdtest's `config.rs` does, so a misconfigured deployment cannot start. The route exists only when the flag is on, so production answers 404. Unit tests pin both rules.
- **Endpoint:** `POST /api/dev/login {username}` answers with the same body as `/api/auth/login` and sets the same cookies.
- **SPA:** a `/dev-login?username=…&next=…` page posts to it, then runs the same bookkeeping as `login()`. Refactor that into an `adoptSession(me)` helper so the two paths cannot drift. In production the POST gets 404 and the page says so.
- **`next`:** validate it as a same-site path, rejecting `//`, `\` and anything outside visible ASCII. Birdtest's first version let `/<tab>/host` through (audit pass 4).
- **Compose** sets `DEV_LOGIN=true` in `docker/backend.defaults.env` only.

**Real catalog files.** Your licensed files in `~/Dropbox/WordGameMisc` mostly need no changes, with one exception:
- `CSW24.csv` (914,624 leaves, `leave,value`) already matches the leave values file format.
- `csw24.tsv` has two columns (`word⇥definition`), and acrodont requires three (`word⇥playability⇥definition`, PLAN.md § Lexicon file). Either produce a three-column file once, or let the local manifest name a playability file that dev.py joins in. Keep the converter, the manifest and the files out of the repository.

**Implementation phases.** Each phase leaves dev.py working:

| Phase | Contents | Effort |
|---|---|---|
| A | Foreground supervisor and log watcher, `--keep-up` / `--detach`, `--no-build`, `.env`, the lock, preflight, explained failures, `--fresh`, `--real-catalog`, `--stats` | M |
| B | `DEV_LOGIN` (backend, SPA `/dev-login`, `adoptSession`), `--login-as` / `--no-login`, `--users`, `--two-devices` | M |
| C | Scenarios through the API and `reference.py`, as `stack.seed_scenario()` so e2e can use them too | M–L |
| D | Snapshot and restore (DEV-2) | M |

Update PLAN.md § Development alongside, since it is the spec dev.py follows.

### DEV-2. Local snapshots and scrubbed restores

**Problem.** `backup.py` and `restore.py --replace` already work locally. Birdtest found three ways this goes wrong:
1. A snapshot written over an existing one while Postgres was down left it empty.
2. A restore in place emptied the database when it failed part-way.
3. A restore that swapped databases with two renames outside one transaction lost the database.

Its fixes:
- Write snapshots to `.partial` and rename them into place.
- Restore into a new database, then swap with both renames in **one** transaction under an advisory lock.
- **Scrub** production dumps (`scrub.sql`): replace email addresses, reset password hashes to the dev password, and drop sessions. The scrub refuses to run without `-v dev_copy=1`, and puts its guard inside `BEGIN` so pasting it into a production psql cannot commit.

**Options.** (a) Leave it as it is. (b) Add birdtest's `dev-dump.sh` / `dev-restore.sh` as separate scripts. (c) Fold the same safeguards into `dev.py --snapshot` / `--restore` on top of `backup.py` / `restore.py`.

**Recommendation: (c).**
- A production dump can only be restored locally if it is scrubbed: no override.
- After restoring a production dump, also run `restore.py --bump-only`, so browser profiles left from earlier local work resync instead of diverging.

### DEV-3. Compose publishes ports on every interface

**Problem.** `docker-compose.yml` publishes `"${ACRODONT_PORT:-5173}:80"` and the Vite port without a host address, so they bind to `0.0.0.0`. Docker's published ports bypass the host firewall. Birdtest found its stack, with fixed credentials and a restored dump, open to the LAN (audit pass 23).

**Options.** Bind `127.0.0.1` only, or add a `BIND_HOST` variable that defaults to `127.0.0.1`.

**Recommendation:** `"${BIND_HOST:-127.0.0.1}:${ACRODONT_PORT:-5173}:80"`, and the same for Vite. Set `BIND_HOST=0.0.0.0` when you deliberately want to test from a phone on the LAN.

### DEV-4. Cap build parallelism

**Problem.** Birdtest's uncapped `cargo` and Docker Rust builds froze this same 16 GB machine (load 70+, a power cycle). The AWS SDK's release build alone needs several GB. Acrodont's Dockerfile and Makefile run cargo uncapped, and acrodont links the same AWS SDK.

**Options.** Cap with build args, or rely on remembering to.

**Recommendation:**
- Add `ARG CARGO_BUILD_JOBS=2` to `docker/backend.Dockerfile`, passed by compose and stack.py.
- `export CARGO_BUILD_JOBS ?= 2` in the Makefile.
- CI overrides it upward (birdtest uses 4 there).

### DEV-5. A mail outbox instead of log scraping

**Problem.** `stack.seed` finds confirmation codes by scraping `docker compose logs backend`.
- That gets slower as the log grows.
- It cannot tell parallel registrations apart.

Birdtest considered the alternatives and rejected them:
- Mailpit, because production uses the SES SDK, not SMTP, so the test would follow a path that never ships.
- A test-only "latest code" endpoint, which is a permanent auth bypass.

It added a third mail backend, `file`, which writes one file per message, named for the recipient. Each file is written under a temporary name and renamed, so a reader never sees half a message. `e2e/lib/mail.ts` has `waitForMail` and `linkIn`.

**Options.** Keep scraping, or add `MAIL_BACKEND=file` with `MAIL_OUTBOX_DIR`.

**Recommendation:** add the `file` backend. Use it in e2e and in `stack.seed`. dev.py's log watcher (DEV-1) can keep using the console backend.

### DEV-6. `JOURNEYS.md`, a manual launch checklist

**Problem.** Acrodont's Playwright journeys are thorough, but nothing walks a person through the whole site before launch.

Birdtest's `JOURNEYS.md` (1,337 lines) is a checkbox list run against a local `dev.py` instance:
- Format: `- [ ] **Do** … **Expect** …`, with quoted UI text, refusals included, and one pass at 390 px phone width.
- Sections: visitors, users, admins, command line, "what a local instance cannot show", and known quirks.
- It is the document whose completion means "this can go live", and failures are reported by journey ID.

**Options.** Rely on Playwright, or write the checklist.

**Recommendation:** write `JOURNEYS.md` once dev.py's scenarios (DEV-1 phase C) exist, since they are its setup. Include:
- offline studying on :5173;
- two devices;
- the update prompt;
- an export;
- a purge (`--env TRASH_RETENTION_DAYS=0`);
- the cascade limit;
- the admin uploads;
- one phone-width pass.

Update it with every feature batch.

---

## 2. Cost and sizing

Birdtest's main cost lesson: **"Birdtest pays for always-on infrastructure, not for use: the web task costs the same at 1% CPU as at 100%."**
- Its 1 vCPU task ran at 1% CPU or less on 20,000–66,000 requests a day, with a lifetime peak of 45.5% and memory at 10.9%.
- Its bill came in at about $148 a month against an estimate of $110–130, and was cut to about $94 without removing a feature.

Acrodont's current Terraform defaults are much larger than birdtest's:

| Item | Acrodont today | Approx./month | Proposed | Approx./month |
|---|---|---|---|---|
| ECS tasks | 2 × (2 vCPU, 8 GB) | ~$170 | 1 × (1 vCPU, 4 GB): measure first (COST-1) | ~$43 |
| NAT gateway, its EIP, data processing | yes | ~$37+ | none (COST-2) | $0 |
| RDS | `db.t4g.medium`, 50 GB gp3 | ~$53 | `db.t4g.micro` (or `small`), 20 GB | ~$14 (~$26) |
| ALB | 1 | ~$18 | 1 | ~$18 |
| Public IPv4 | ALB (2) | ~$7 | ALB (2) + task (1) | ~$11 |
| Container Insights, 90-day logs, PITR beyond the database size | on | a few $ | off / 30 days / 7 days | ~$1–3 |
| **Total** | | **~$290** | | **~$90–100** |

The figures are approximations at us-east-1 on-demand rates, using the per-unit prices birdtest's bill showed. They exclude the domain and email volume.

### COST-1. The task is sized for a guess, not a measurement

**Problem.**
- `infra/variables.tf` sets 2 vCPU and 8 GB per task, and `desired_count = 2`. The 8 GB comes from "the catalog must fit", but the real catalog has never been loaded and measured.
- Acrodont is local-first: the player reads only IndexedDB, so the server does even less per user than birdtest's. Its heavy moments are search (bounded by `SEARCH_CONCURRENCY`), cascade creation, exports, and catalog uploads.
- The scale suite measured **ten concurrent exports with definitions at a peak of 2.4 GiB resident**. Memory needs are set by concurrent exports, and nothing limits them across users: `EXPORT_RATE_PER_MINUTE` is per user.
- Two tasks also double every in-memory rate limit (the runbook notes the login limit becomes twenty failures a minute per username).

**Options.**
1. Keep 2 × 2 vCPU / 8 GB.
2. 1 × 1 vCPU / 4 GB, after measuring.
3. 1 × 0.5 vCPU. This is risky: a search is single-threaded, so half a vCPU could push ordinary searches past the 2-second `SEARCH_TIMEOUT_MS` into `search_too_broad`.

**Recommendation: option 2, gated on a measurement.**
1. Run `dev.py --real-catalog --stats` (DEV-1) with the catalog you will launch with, for example CSW24 with leaves plus NWL. Record each index's `approx_bytes` and the backend's resident memory.
2. Add a **global export semaphore** (`EXPORT_CONCURRENCY`, default 2) beside `search_permits` in `backend/src/app.rs`. Peak memory is then the catalog plus two exports, whatever the number of users. A waiting request gets `503` with `Retry-After`, as search does. This mirrors birdtest's KL-44 rule: bound heavy work with a semaphore.
3. Set `task_memory` to (catalog + two exports) × 1.5, rounded up to a Fargate size: 3, 4, 5 or 6 GB at 1 vCPU. Set `task_cpu = 1024` and `search_concurrency = 1`.
4. Set `desired_count = 1`. Acrodont can run two tasks during a deploy, so a single task still deploys with no gap (DEP-3). One task also makes the rate limits exact.
5. Add the CPU and **memory** alarms in MON-2, so the measurement is watched from then on.

Losing AZ redundancy for the web tier is acceptable: RDS is single-AZ anyway, and Fargate replaces a failed task in a minute or two. Raise `desired_count` back to 2 only after a shared rate limiter exists.

### COST-2. The NAT gateway

**Problem.** `infra/network.tf` puts the tasks in private subnets and gives them a NAT gateway: about $33 for the gateway, $3.65 for its address, and $0.045 per GB, including every ECR image pull.
- Birdtest runs its tasks in **public subnets with `assign_public_ip = true`**, and a security group that admits only the ALB. Its whole public-IPv4 line, for the ALB and its tasks, is about $15.
- VPC interface endpoints would cost more than the NAT. ECR (two), Logs, SSM, SSM messages, Secrets Manager and SES come to six or seven endpoints × 2 AZs × ~$7.30.

**Options.** Keep the NAT; use VPC endpoints; or move the tasks to public subnets.

**Recommendation: public subnets for the tasks and the backup task.**
- RDS stays in private subnets.
- The tasks' security group admits only port 80 from the ALB, as it does now.
- Delete the NAT, its EIP and the private route table.
- This is easiest before the first apply. Afterwards, changing a service's subnets is an in-place update, but the backup schedule and the runbook have to move with it.

### COST-3. RDS class, storage and PITR window

**Problem.** `db.t4g.medium` (4 GB) with 50 GB allocated and a hard-coded 30-day PITR window.
- Birdtest serves a heavier write load (worker results, leave-generation merges) on a micro.
- It cut PITR from 30 to 7 days because PITR backup storage beyond the database size is billed, and the nightly dumps cover anything older.
- RDS storage autoscaling steps never shrink, and an instance under 20 GiB is refused (after the rest of the stack is built).

**Options.** micro (1 GB), small (2 GB) or medium (4 GB), with storage of 20 GB or more, and PITR of 7, 14 or 30 days.

**Recommendation:**
- **Class:** `db.t4g.micro`, but only after running the server half of `make test-scale` against a Postgres container limited to the micro's size (`--cpus=2 --memory=1g`, `shared_buffers=256MB`). If the 300,000-question budgets fail there, use `small`.
- **Orderability:** check with `aws rds describe-orderable-db-instance-options` on the day of the first apply. Birdtest's first apply failed half-way because `db.t4g.micro` was not orderable that day; it was again a month later.
- **Storage:** `db_allocated_storage = 20`.
- **PITR:** move it into a `db_backup_retention_days` variable (default 7, validated to 1–35 so 0 cannot switch PITR off).
- **`apply_immediately`:** add `db_apply_immediately = true`, so scaling up under the CPU alarm happens at once rather than in the weekly maintenance window.
- **Windows:** keep `backup_window` clear of the 03:15 dump.

### COST-4. The small recurring charges

**Problem.**
- `containerInsights = enabled` bills custom metrics. Birdtest runs without it; the service-level `CPUUtilization` and `MemoryUtilization` metrics, which are free, are enough for alarms.
- Logs are kept 90 days, and they contain personal data (MAIL-4); birdtest keeps 30.
- ECR has no lifecycle policy, so every deploy's images accumulate.

**Recommendation:**
- Turn Container Insights off.
- Set `retention_in_days = 30`.
- Add an ECR lifecycle rule that keeps the last 30 images per repository. That is enough to roll back months.

### COST-5. Budget and anomaly alerts

**Problem.** Acrodont has none.
- Birdtest set its budget in the console and later changed it by CLI, so its settings now live only in a plan document.
- It also found that AWS's default anomaly subscription ("$100 and 40%") would rarely fire on a $100 bill.

**Recommendation:** put both in Terraform:
- `aws_budgets_budget`: monthly, with a limit about 30% above the expected bill. Alerts at 85% actual, 100% actual and 100% forecast, to `alert_email`.
- `aws_ce_anomaly_monitor` and `aws_ce_anomaly_subscription` with `ANOMALY_TOTAL_IMPACT_ABSOLUTE >= 20`.
- Expect a budget alert in the month the domain renews.

---

## 3. Deploy and rollback

### DEP-1. Two sources of truth for what is running

**Problem.** `.github/workflows/deploy.yml` registers new task-definition revisions with `jq`, outside Terraform, and `aws_ecs_service.app` has `ignore_changes = [task_definition]`. The consequences:
- **Environment changes do not apply.** An environment change applied with Terraform registers a new revision but does not reach the service until the next image deploy, and nothing says so.
- **The nightly dump can run an old image.** The backup task definition takes `var.backend_image`, which must be passed by hand on every apply. Any apply that touches the backup task definition registers a revision with whatever image was passed, and the scheduler runs the family's **latest** revision. Pass an old image, or the runbook's first-apply `x` placeholder, and the nightly dump runs it.
- **Nobody can tell what is live.** Terraform's state does not say which image is running.

Birdtest's answer is that **Terraform deploys.**

`scripts/deploy.sh` runs from the operator's laptop under AWS SSO. In order, it:
1. Refuses a dirty tree, a HEAD not on `origin/main`, or a commit whose CI run is not green (`gh run list --commit`), with an emergency `--skip-ci-check`.
2. Checks the account.
3. Refuses if ECS has rolled back and disagrees with tfvars.
4. Refuses changed (not added) migrations.
5. Builds only the images ECR lacks: immutable tags by commit SHA, `--platform linux/amd64`, capped build jobs.
6. Writes the tags into `prod.tfvars`.
7. Runs a **plan gate**: it refuses any plan that deletes, replaces or forgets an `aws_db_instance`, `aws_s3_bucket*`, `aws_vpc`, `aws_subnet` or `aws_kms_key`, unless an override variable is set **and** you type `destroy`.
8. Applies the saved plan.
9. Waits for the rollout and for healthy targets.
10. Curls `/health`.

Prompts read from `/dev/tty`, so nothing piped in can answer them.

**Options.**
1. Keep GitHub Actions and the jq revisions, and accept the drift.
2. Make GitHub Actions run `terraform apply` with the image variables. This needs a near-admin OIDC role and state access from CI.
3. Adopt birdtest's laptop `deploy.sh` with Terraform as the only deployer. Delete `deploy.yml` and the OIDC deploy role, or keep the role only for pushing images.

**Recommendation: option 3.**
- You already operate birdtest this way, and its `scripts/lib/ops.sh` (plan gate, tfvars handling, `/dev/tty` prompts, rollout wait) ports almost unchanged. Acrodont's version is simpler: one service, two containers, so always build both images.
- Keep `prod.tfvars` out of git and its authoritative copy in the state bucket, with birdtest's fetch-and-compare. That guard costs about 20 lines and protects against a second deployer, or yourself on a second machine.
- Keep `APP_BUILD` monotonic. Today it is `github.run_number`; use `git rev-list --count HEAD`, which `stack.py`'s `app_build()` already uses locally. `MIN_APP_VERSION` compares against it, so it must never go backwards.

### DEP-2. A release whose task cannot start

**Problem.** `aws_ecs_service.app` has no deployment circuit breaker.
- A release with a bad setting, a missing SSM parameter or a failing migration is retried forever. With `minimum_healthy_percent = 50`, one of the two old tasks is already gone while it retries.
- `aws ecs wait services-stable` gives up at 10 minutes, and it can report success over a crash-looping task.
- Birdtest added the circuit breaker (fe701c8) and then found two follow-on gotchas:
  1. Terraform's state still names the failed release, so the next apply of any kind redeploys it.
  2. Nothing announces a rollback. It added an EventBridge rule on `SERVICE_DEPLOYMENT_FAILED` to SNS whose message states the remedy (6c6c191).
- A deploy that compares images says "deployed" even when the circuit breaker reverted a CPU or environment change. Check the running task definition, not the image.

**Recommendation:**
- Add `deployment_circuit_breaker { enable = true, rollback = true }`.
- Add the `SERVICE_DEPLOYMENT_FAILED` rule and target, with an input transformer that writes the remedy into the email.
- In `deploy.sh`, wait for every target to be healthy (`aws elbv2 wait target-in-service`, retried past its 10-minute limit). Then compare the running task definition's image **and** its CPU and memory with what was applied.

### DEP-3. ECS and target-group settings

**Problem.** These are acrodont's current values next to what birdtest learned on real deploys:

| Setting | Acrodont | Birdtest's lesson |
|---|---|---|
| `deployment_minimum_healthy_percent` / `maximum_percent` | 50 / 100 with 2 tasks | With 1 task (COST-1) this would stop the only task first. Use **100 / 200**, so the new task serves before the old one drains. Acrodont can run two at once; birdtest cannot (section 13). |
| `deregistration_delay` | 30 | The 300 s default happens *before* SIGTERM, so a deploy stays slow long after the new task is healthy. Birdtest uses 10 (f2fda4c). 30 is fine for a rolling deploy; 10–15 makes deploys faster. |
| Container `stopTimeout` | unset (30 s) | The 30 s default SIGKILLs graceful shutdown's in-flight work. Birdtest sets 120, Fargate's maximum. Acrodont's equivalents are a streaming export and a 300,000-row sync batch. |
| `health_check_grace_period_seconds` | 300 | Without one, ECS killed tasks mid-migration. 300 is fine, but see MIG-4 for the real catalog's load time. |

**Recommendation:**
- `desired_count = 1`, with 100 / 200.
- `deregistration_delay = 15`.
- `stopTimeout = 120` on both containers.
- Keep the target-group health check at 10 s × 2 healthy, as now.

### DEP-4. Rolling back

**Problem.** Acrodont has no rollback procedure. A rollback has three requirements:
1. The previous image must start on the **newer** schema. SQLx's migrator refuses by default: "migration N was previously applied but is missing in the resolved migrations". Birdtest's rollback crash-looped until it set `set_ignore_missing(true)` (`backend/src/db.rs:75`). Acrodont's `MIGRATOR.run(&db)` in `backend/src/app.rs:93` does not set it.
2. Migrations must be additive, so old code can run against them (MIG-3).
3. Terraform has to agree with whatever ECS is running after the rollback.

**Recommendation:**
- Run the migrator with `set_ignore_missing(true)`. Add an integration test that applies a fake `0002`, then starts the server built without it.
- Port birdtest's `rollback.sh`: by default it targets what ECS rolled back to, or else the previous release; it refuses a target whose migrations differ; it builds nothing (ECR's immutable tags guarantee the image is there); and it ships through the same plan gate.
- Keep a release log, but derive it from ECR tags and the deployed tfvars rather than a file on one laptop.

---

## 4. Nginx and the ALB

### EDGE-1. Nginx closes connections the ALB still uses

**Problem.** The ALB's `idle_timeout` is 120 s (`infra/alb.tf`). Nginx's `keepalive_timeout` is the image default, 65 s, because `docker/nginx.conf.template` does not set it. Nginx then closes pooled connections the ALB still considers open, and a request the ALB sends on one gets a **502**. AWS lists this as the first cause of ALB 502s. Birdtest shipped exactly this bug and fixed it with `keepalive_timeout 310s` against an `idle_timeout` of 300 (fe701c8).

**Recommendation:** set `keepalive_timeout 130s;` in the server block, or whatever the ALB's timeout is plus 10 s, and keep the rule pinned with EDGE-4's test.

### EDGE-2. A missing chunk is cached for a year

**Problem.** `location /_app/immutable/` sends `Cache-Control "public, max-age=31536000, immutable" always`. With `always`, a **404** for a chunk is also cached as immutable for a year. A browser that asks for a chunk the current image does not have, during a deploy or a rollback, then keeps it missing even after the chunk comes back. Birdtest hit this (d73e67f) and removed `always` from that header.

Acrodont's service worker precaches the build, which reduces the exposure, but its install fetches go through the same cache rules.

**Recommendation:**
- Use `add_header Cache-Control "public, max-age=31536000, immutable";` without `always`.
- Add an explicit `try_files $uri =404;` in that location, so a missing chunk can never fall through to `index.html`. Birdtest also hit that fall-through: a 200 of HTML that `nosniff` refuses to run, leaving a blank page.

### EDGE-3. Static assets are not compressed

**Problem.** The nginx image ships with `gzip` off, and the template does not turn it on, so the SPA's JavaScript and CSS go out uncompressed. That is most of a first visit's bytes and the whole service-worker precache. The API is already compressed by `tower-http`'s `CompressionLayer` (`backend/src/app.rs:73`).

**Recommendation:**
- `gzip on; gzip_types text/css application/javascript text/javascript image/svg+xml application/json application/manifest+json; gzip_vary on; gzip_proxied any;` at server level.
- `gzip off;` inside `location /api/`, so there is only one compression policy for API bytes. Birdtest's comment: "Nginx compressing too would be a second policy for the same bytes."

### EDGE-4. Smaller Nginx hardening, and a config test

**Problem.**
- `absolute_redirect` and `server_tokens` are on. Behind the ALB, a directory redirect named `http://localhost/…`.
- No `Referrer-Policy` header.
- Nothing stops these settings drifting back.

Birdtest's `frontend/src/lib/nginxConfig.test.ts` (F-NGINX-1..3) parses the template in Vitest and pins:
- keepalive longer than the `idle_timeout` it reads from `infra/ecs.tf`;
- the immutable rules;
- the security headers.

**Recommendation:**
- Add `absolute_redirect off; server_tokens off;` and `Referrer-Policy: same-origin` to `acrodont-headers.inc`.
- Port the Vitest test. It should also read `idle_timeout` from `infra/alb.tf` and check that `client_max_body_size` covers `ADMIN_UPLOAD_MAX_BYTES`.

---

## 5. Migrations and build correctness

### MIG-1. A new migration can ship without being compiled in

**Problem.** `sqlx::migrate!` embeds migration files at compile time. A new file under `backend/migrations/` with no Rust change leaves the crate "fresh" to cargo, so the binary ships without it. Birdtest shipped this (audit pass 15) and added `backend/build.rs` with `cargo:rerun-if-changed=migrations`, the build script SQLx's documentation recommends. Acrodont has no `build.rs`.

**Recommendation:** add the three-line `build.rs`.

### MIG-2. The Docker build can ship a stale binary

**Problem.** `docker/backend.Dockerfile` builds with `--mount=type=cache,target=/src/backend/target`. `COPY` keeps the source files' original modification times. A checkout whose files are older than the cached build's output looks "fresh" to cargo, and the image ships the other checkout's binary. This happens after switching branches, or when building from a worktree. Birdtest shipped this too (audit pass 15).

**Recommendation:** before `cargo build`, run `find src migrations build.rs Cargo.toml -type f -exec touch {} +`, as birdtest's Dockerfile does.

### MIG-3. The schema policy after the first deploy

**Problem.** PLAN.md already says `0001_initial.sql` "is edited in place until the first deployment, after which migrations are append-only". Birdtest had the same rule and **bent it after going live**. It kept editing `0001` "until the real launch", which meant:
- production database resets;
- deleting backups under Object Lock;
- everyone re-registering.

A week after launch it stopped ("changing the DB is now more costly", 102fbdc) and adopted these rules:
- Numbered migrations, never editing an applied one.
- **Additive only**: new tables, nullable or defaulted columns, indexes. Drops and renames wait a release.
- **A new enum or CHECK value is not additive**: ship the code that reads it one release before the code that writes it.
- Prefer designs that need no schema change.

Acrodont has an extra constraint birdtest does not: devices stay offline with an old app for up to `SYNC_RETENTION_DAYS` (90). Server-side schema changes must keep the sync API compatible for that long (PLAN.md § Deployment and Operations).

**Options.**
1. Follow PLAN.md exactly: append-only from the first `terraform apply`.
2. Birdtest's route: keep editing until "real launch", and build reset tooling.

**Recommendation: option 1.** Write birdtest's additive rules and the enum rule into PLAN.md § Schema. Add three checks:
- **`deploy.sh`** refuses any change to `backend/migrations/` from the live tag that is not an *added* file.
- **dev.py** explains SQLx's checksum error (DEV-1).
- **CI** applies every migration in order to an empty database and checks the result matches what the integration tests build. Birdtest's nightly restore round-trip applied only `0001` for a while and silently fell behind.

Before the first apply, take one last look at `0001` for anything you would later want to rename.

### MIG-4. Startup time against the health checks

**Problem.** The backend migrates, then builds every catalog index, before `/health` returns 200.
- The container health check has `startPeriod = 120`, `interval 10` and `retries 3`. If the real catalog takes longer than about 150 s to load on a 1 vCPU task, the container is marked unhealthy and replaced. Each replacement reloads from scratch, so it is killed again, a restart loop with nothing serving.
- Nginx waits on `dependsOn: HEALTHY`.
- Birdtest's version of this bug was a migration killed by the target-group check.

**Recommendation:**
- Measure the real catalog's load time with `dev.py --real-catalog --stats`, under `--cpus=1` if possible.
- Set `startPeriod` to at least twice that time; 300 s is Fargate's maximum. If it does not fit, the index build has to become faster or lazy.
- Log the total catalog-load time at startup.

---

## 6. Monitoring and alarms

### MON-1. Alarms that go nowhere

**Problem.** `alarm_email` defaults to `null`, so a forgotten value applies cleanly and every alarm goes to a topic with no subscriber. SNS email subscriptions also need a click to confirm. Birdtest:
- made `alert_email` required with no default, so the apply refuses without it;
- validated it as one plain address;
- wrote `scripts/check-alerts.sh`, which forces an alarm into ALARM and back, and tests the EventBridge patterns, to prove the mail actually arrives.

**Recommendation:**
- Make `alarm_email` required and validated.
- Add a small `check-alerts.sh`: `aws cloudwatch set-alarm-state` on one alarm, plus `aws events test-event-pattern` for DEP-2's and BAK-2's rules.
- Run it once after the first apply, and after any change to alarms.

### MON-2. Missing alarms

**Problem.** Acrodont has four alarms:
- the dump is stale;
- the dump shrank;
- RDS free storage;
- a sync `error` rejection.

It has none of the ones birdtest needed once it was live. One of the existing four is also wrong: birdtest found a fixed `FreeStorageSpace` threshold meaningless under storage autoscaling. Free space is measured against the *current* allocation, and autoscaling keeps it near 10%, so the alarm either fires after the first growth or never. Birdtest replaced it with an RDS event subscription.

**Recommendation.** Add the following. It comes to about 12 alarms; the first 10 are free, and each one after that costs about $0.10 a month.

| Alarm | Watches | Threshold | Notes |
|---|---|---|---|
| `acrodont-down` | ALB `HealthyHostCount`, Maximum | < 1 for 10 × 1 min | missing data is breaching. 10 minutes so a deploy never pages; send OK too |
| `acrodont-api-5xx` | ALB `HTTPCode_ELB_5XX_Count` | ≥ 5 per 5 min, 3 periods | missing data not breaching. Would have caught EDGE-1 |
| `acrodont-backend-cpu-high` | ECS service `CPUUtilization` | ≥ 85% for 15 min | |
| `acrodont-backend-memory-high` ★ | ECS service `MemoryUtilization` | ≥ 85% for 10 min | **specific to acrodont**: the catalog lives in memory, so an OOM restart means a full reload |
| `acrodont-db-cpu-high` | RDS `CPUUtilization` | ≥ 80% for 15 min | a burstable class in unlimited mode is billed for surplus rather than throttled, so the credit balance says little |
| RDS event subscription | `low storage`, `failure`, `notification` | | replaces `acrodont-db-free-storage`; `notification` includes the allocation reaching 80% of the autoscaling ceiling |
| `acrodont-deploy-failed` | EventBridge `SERVICE_DEPLOYMENT_FAILED` | | DEP-2 |
| `acrodont-backup-failed` | EventBridge: backup task STOPPED with exit code ≠ 0 | | BAK-2 |
| SES bounce / complaint, `mail-failed` | | | MAIL-2 |

Keep the sync-rejection dashboard and its `error` alarm. Birdtest has nothing like them, and they are the right tool for acrodont's two-implementation design.

Optional (birdtest KL-90): log refused logins at `info` with a hashed username, so you can see whether the limiter is turning away guessers.

### MON-3. Nightly failures nobody sees

**Problem.** Birdtest's nightly failed for **weeks** without anyone noticing: first a vanished `minio/mc` image, later seven nights or more in one tier. Its deploys did not gate on it. Acrodont's nightly `make test-scale` is the same shape.

**Recommendation:**
- Add a final step to the scheduled job that opens or updates a GitHub issue on failure (`gh issue create`, or comment on an existing open one).
- Have `deploy.sh` warn when the last nightly on `main` failed. A warning, not a refusal.
- Pin base images by digest, or at least by full version. The vanished MinIO images show why `:latest` is a liability, and acrodont's `postgres:16` and `nginx:1.27-alpine` are moving tags.

---

## 7. Email (SES)

### MAIL-1. A burst of registrations exceeds SES's send rate

**Problem.** Acrodont sends each email in a task spawned after the response, with no limit on how fast. SES allows 1 message a second in the sandbox and typically 14 once production access is granted. Birdtest: "sent at once, a burst of registrations exceeded the rate and SES refused them". It added a bounded in-process queue drained at `MAIL_MAX_PER_SECOND`, a 30-second send timeout, and dropping of reset mails whose link would have expired before they went out.

Acrodont's own design expects bursts. PLAN.md sizes `CATALOG_RATE_PER_MINUTE` for "a club or tournament room behind one address", and a room registering together is the same burst.

**Recommendation:**
- Add a `MAIL_MAX_PER_SECOND` setting (Terraform variable, default 1; raise it to the account's rate after production access).
- Add a bounded `tokio::sync::mpsc` queue with a single sender task, keeping the existing "queued after the response, so the branches time alike" property.
- Use a 30-second timeout per send, and drop a mail whose link has expired.

### MAIL-2. SES reputation and failed sends

**Problem.** SES reviews an account at a 5% bounce or 0.1% complaint rate, and may pause it at 10% / 0.5%. When paused, every confirmation and reset fails, and the caller cannot tell, because the response is deliberately the same as a success. Registration mails any address a visitor types, so the bounce rate is something a visitor can drive. A failed send today is only an error line in the log (`backend/src/auth/routes.rs:77`).

**Recommendation.** Port birdtest's `infra/ses.tf` safeguards:
- `aws_sesv2_account_suppression_attributes` with `BOUNCE` and `COMPLAINT`;
- reputation alarms at 4% bounce and 0.08% complaint (`treat_missing_data = ignore`);
- the failed-send log line given a structured field, `alarm = "mail_failed"`;
- a metric filter on `{ $.fields.alarm = "mail_failed" }` that alarms on a single failure.

### MAIL-3. SES setup that Terraform does not cover

**Problem.** Acrodont declares only the domain identity. Birdtest's launch steps also needed:
- a custom MAIL FROM subdomain (`aws_sesv2_email_identity_mail_from_attributes`, with its MX and SPF records);
- a `_dmarc` record;
- production access, which took about a day and asks how bounces and complaints are handled. MAIL-2 is the answer.

Birdtest's launch-day rule: **do not announce before production access**, because confirmation mail reaches nobody else until then. While it waited, `scripts/confirm-user.sh` confirmed accounts by hand, writing the same audit row the route writes.

**Recommendation:**
- Add the MAIL FROM resource and output its records.
- Add DMARC and the production-access request to the runbook's one-time setup, with a note not to announce until access is granted.
- Write `confirm-user.sh` on top of OPS-1's `prod-sql.sh`.

### MAIL-4. Email addresses in production logs

**Problem.** `SesMailer::send` logs `mail_to = %email.to` on every send. That puts every user's address in CloudWatch, for 90 days today. Birdtest's rule for anything that reaches the logs: never personal columns.

**Recommendation:** log the mail kind and a hash of the address in production. Keep the full address in the console mailer only.

---

## 8. Security and secrets

### SEC-1. Secrets in Terraform state

**Problem.** `infra/ssm.tf` declares the three secrets as `aws_ssm_parameter` resources with `ignore_changes = [value]`. The AWS provider still **reads each value, decrypted, into state on every refresh**. Once you set them out of band, `DATABASE_URL`, `BACKUP_DATABASE_URL` and `SESSION_SIGNING_KEY` sit in plain text in the state file. A data source would do the same. Birdtest's thirty-second audit found exactly this (pass 17).

**Options.** (a) Accept it and lock down the state bucket. (b) Reference the parameters by an ARN built from their names, and create them out of band.

**Recommendation: (b), before the first apply.** That way there is no old state file holding the values to rotate. Concretely:
- Build `arn:${partition}:ssm:${region}:${account}:parameter/acrodont/production/<NAME>` in a `locals` block.
- Use it in the execution role's policy and the task's `secrets`.
- Have the runbook's one-time setup create the parameters with `aws ssm put-parameter --type SecureString`.

### SEC-2. ECS Exec into the serving task

**Problem.**
- **The runbook's command is broken.** It grants admin with `aws ecs execute-command … --command "psql \"$DATABASE_URL\""`. The double quotes expand `$DATABASE_URL` on the **operator's laptop**, where it is empty, and ECS Exec's `--command` is not run through a shell anyway.
- **The session is not set to stay out of the logs.** The cluster has no `execute_command_configuration`, so sessions log through the container's awslogs driver, and a transcript would include anything echoed, `DATABASE_URL` among it. Birdtest set `logging = "NONE"`.
- **It execs into the task serving users.** Acrodont needs Exec permissions on that task to do it.

**Recommendation:**
- Set `execute_command_configuration { logging = "NONE" }` on the cluster.
- Turn ECS Exec off on the app service.
- Move every SQL step to OPS-1's ops task.
- Delete the broken command from the runbook when OPS-1 lands.

### SEC-3. Variable validations and `terraform test`

**Problem.** Birdtest's first applies failed **half-way** several times, on values `terraform plan` accepted and AWS refused:
- a CPU and memory pair Fargate does not offer;
- an RDS instance under 20 GiB;
- a certificate or parameter ARN in another region;
- an apostrophe in a security group description;
- `dr_region == region` creating a KMS alias twice;
- a placeholder `*.example` domain that applied and then sent every mail to a domain nobody owns.

Each now has a `validation` block. `infra/tests/variables.tftest.hcl` runs `terraform test` against a **mock provider with no credentials**: 6 plans that must pass and 44 that must be refused, in CI.

Acrodont's `backup_region` description says "must differ from region", but no validation enforces it.

**Recommendation.** Add validations for:
- `backup_region != region`;
- Fargate CPU and memory pairs, for the app and backup tasks;
- `db_allocated_storage >= 20`;
- `desired_count`: widen the existing 1–2 check to 0–2, for OPS-3's first apply;
- `alarm_email` (MON-1);
- `domain_name` is a bare domain and not a placeholder.

Add a small `variables.tftest.hcl` and run it in CI (CI-2).

### SEC-4. The hardening checklist birdtest wrote too late

**Problem.** Birdtest's KL-63 and KL-64 list hardening it never got to. Acrodont can do it before launch, at almost no cost. Items marked ✓ are already true in acrodont.

| Item | Acrodont |
|---|---|
| ALB `drop_invalid_header_fields = true` | missing |
| Backups bucket policy denies `aws:SecureTransport = false` | missing |
| `ses:SendEmail` scoped to the identity | ✓ (`infra/iam.tf`) |
| GitHub Actions pinned by commit SHA, not by tag | not pinned |
| Base images pinned by digest | not pinned (MON-3) |
| Compose ports on 127.0.0.1 | DEV-3 |
| No tokens in query strings reaching logs | the export token is in the export URL and lands in Nginx's access log. It is single-use and expires in 60 s, so it is low risk, but `log_format` can drop the query string for `/api/…/export` |
| `TRUSTED_PROXY_HOPS` correct behind the ALB | ✓ (1). Birdtest's note: set it too high and every per-IP limit keys on the ALB, so the whole site shares one bucket, with no error |

**Recommendation:** do the first, second, fourth and seventh rows with the P0 work.

---

## 9. Operations tooling

### OPS-1. Running SQL in production

**Problem.** Acrodont's only way to run SQL in production is ECS Exec into a serving task, and the runbook's command for it is broken (SEC-2). The one-time setup also needs the **master** password to create roles, which RDS keeps in Secrets Manager. The task cannot read it, and the runbook does not say how to get it.

Birdtest has no bastion and no public RDS. It has an **ops task definition** (`infra/ops.tf`):
- the `postgres:16` image, so `psql` and `pg_restore` match the server;
- `DATABASE_URL` from SSM;
- the service's subnets and security group;
- read-only access to the backups;
- ECS Exec, with logging off;
- it runs only while an operator has one open.

Two scripts drive it:
- **`prod-sql.sh "SQL"`** runs one batch through `ecs run-task` (`psql -X -v ON_ERROR_STOP=1 --single-transaction`). It polls **with no time limit**, because the AWS waiter gives up at 10 minutes while the SQL keeps running, and a rerun would apply it twice. It then prints the task's log stream and exits with psql's code.
- **`prod-shell.sh`** opens an interactive shell in a task that stops itself after 4 hours. Leaving the shell does not stop the task, because ECS Exec sessions end after 20 idle minutes and that used to kill long restores.
- Rule: SQL sent this way reaches the logs, so never select personal columns, and never put a secret in it.

**Recommendation:** port the ops task and both scripts.
- Grant admin with `scripts/prod-sql.sh "UPDATE users SET is_admin = true WHERE username = '…' RETURNING username"`. Copy birdtest's `confirm-user.sh` trick of passing the username as hex, so no character can break the quoting.
- For the one-time role creation, give the ops task read access to the RDS-managed master secret, used once, or have the runbook fetch the secret and run `prod-shell.sh`.

### OPS-2. Procedures as tested scripts

**Problem.** Birdtest's audits kept finding defects in runbook commands that people were meant to paste, "pass after pass" (KL-66). Its fixes:
- Every multi-step procedure became a script that sources `scripts/lib/ops.sh`: deploy, rollback, set-setting, rotate-db-password, onboard-deployer, confirm-user, check-alerts, the restores.
- **`ops-scripts-check.sh`** tests them in CI. One Python fake is symlinked as `aws`, `terraform`, `gh`, `docker` and `curl`. It records every call, keeps state in files, and fails on cue through variables such as `FAKE_APPLY_RC`. Assertions check the order of calls and that some calls never happen.
- **`runbook-check.sh`** checks every fenced block in RUNBOOK and README: each must be labelled `bash`, `sql` or `text`; bash blocks must pass `bash -n`; and any block that runs `aws` must begin with `export AWS_PAGER=""`, because the pager swallowed the rest of pasted blocks.

**Options.** (a) A Markdown runbook only. (b) Scripts without tests. (c) Scripts plus birdtest's two checkers.

**Recommendation: (c), in two steps.**
1. Before launch: `deploy.sh`, `rollback.sh`, `prod-sql.sh`, `prod-shell.sh`, `check-alerts.sh` and `runbook-check.sh`.
2. Once there are three or more scripts, port `ops_fakes.py` and the first checks: plan gate refusal, refusing a changed migration, a docs-only commit doing nothing.

Also port `rotate-db-password.sh` (it writes SSM **first**, has `--resume`, and `--signing-key` signs everyone out) and `onboard-deployer.sh`, which must end with a plan showing **no changes**.

### OPS-3. The first apply

**Problem.** Birdtest's launch plan collected the gotchas of a first apply:
- **The RDS class** may not be orderable.
- **The ACM certificate** must be *Issued* before the apply. Acrodont's Terraform creates and waits on it, so the apply blocks until the DNS records exist.
- **Secrets** go in between two applies: first `desired_count = 0`, then the SSM values, then the real count.
- **Terraform:** install from the release zip, since HashiCorp's apt repository fails on Ubuntu 20.04 with `NO_PUBKEY`. Pin one version for everyone. Keep state in a versioned bucket in a **different region** with `use_lockfile = true`, which needs 1.11+ and makes a DynamoDB table unnecessary. Run `terraform providers lock -platform=linux_amd64` so CI and the laptop agree.
- **Zones:** pin the AZs the first apply chose into tfvars.
- **SNS:** confirm the email subscription.

**Recommendation:**
- Rewrite `docs/runbook.md` § One-time setup as birdtest's two-phase sequence, with the checks above as explicit steps.
- Add `desired_count = 0` support. Make the alarms that depend on a running service conditional on `desired_count > 0`, as birdtest does, so a stack with no tasks does not page.

---

## 10. Backups and restore

### BAK-1. The restore drill is manual

**Problem.** PLAN.md asks for a quarterly drill, done by hand. Birdtest runs it **monthly on a schedule**, restoring the newest dump into a Postgres started inside the drill task and never on the production instance. It once used production, and the drill could fill its storage, push autoscaling up permanently and burn CPU credits. A failed drill is its loudest alarm. `backup-drill-check.sh` also runs the backup and drill scripts locally, exactly as Fargate runs them, in CI.

**Recommendation:**
- After launch, add a scheduled drill task: restore into a local Postgres in the task, run `restore.py`'s checks, then compare row counts with a manifest that `backup.py` writes next to the dump.
- Keep PLAN.md's quarterly manual drill for the part a machine cannot do: a second browser profile resyncing after the sequence bump.

### BAK-2. A failed backup only alarms 36 hours later

**Problem.** If `backup.py` exits non-zero, the only signal is `acrodont-no-dump-36h`, a day and a half later.
- Birdtest adds an EventBridge rule: backup task STOPPED with exit code ≠ 0 → SNS, so a failure is reported within minutes.
- It also separates roles: the backup role can write but not read, and the drill role can read but not write, so no single compromised role can both read and replace backups.
- Its KL-80: a script running as PID 1 in a container ignores SIGTERM unless it installs a handler, so ECS's StopTask SIGKILLs it without cleanup.

**Recommendation:**
- Add the exit-code rule.
- Remove `s3:GetObject` from the backup role. `backup.py` already sizes the previous dump from `list_objects_v2`, so the role only needs `PutObject`, `PutObjectRetention` and `ListBucket`.
- Install a SIGTERM handler in `backup.py` that removes partial uploads.

---

## 11. CI

### CI-1. One serial CI job

**Problem.** Acrodont's `ci.yml` runs `make test` in one job with a 120-minute timeout: unit, integration, six end-to-end stacks, and a seeding rerun, all serially. There is no `cargo clippy`.

Birdtest's CI takes about 11.5 minutes:
- separate lint, build, test, frontend, images, e2e, terraform and scripts jobs;
- backend tests as a `cargo nextest archive` run in four `--partition count:N/4` jobs;
- nextest's `slow-timeout` kills a test after 10 minutes, so a hang fails instead of eating the timeout;
- the e2e job's Rust build, "nearly six of the job's nine minutes", cached through buildx `type=gha` and `buildkit-cache-dance`, which restores the Dockerfile's cargo cache mounts.

**Recommendation:** split `ci.yml` into these jobs:
- **lint:** `cargo clippy --all-targets -- -D warnings`, svelte-check;
- **unit;**
- **integration:** nextest, partitioned;
- **e2e:** the main pass and the configured passes as a matrix over `E2E_PROJECT`, with the image cache;
- **terraform:** CI-2;
- **scripts:** OPS-2.

Keep the Makefile targets as the single entry points, so a developer and CI run the same commands.

### CI-2. Terraform is not checked in CI

**Problem.** `make infra-validate` exists but CI never runs it. Birdtest runs `fmt -check`, `init -backend=false`, `validate` and `terraform test` on every PR.

One note from its cost plan: run `fmt -check` on `git ls-files 'infra/*.tf'`, not `-recursive`, which flags (and could rewrite) the git-ignored `prod.tfvars`.

**Recommendation:** add a terraform job running `make infra-validate` (with the file-list `fmt`) plus `terraform test`.

---

## 12. Process and UX

### PROC-1. Dated update plans

**Problem.** After launch, birdtest's changes came in batches, each with an `UPDATES_PLAN_YYYY-MM-DD.md`. Each plan has:
- the owner's numbered items;
- phases that each leave `main` green and deployable;
- a **Deploy** column for every phase: *frontend-only*, *no migration*, or a named migration;
- decisions tabled as D1…Dn, each with a recommendation;
- the lowest test tier that proves each phase;
- a "Not in this plan" section.

**Recommendation:** use the same template once acrodont is live. The Deploy column matters more for acrodont than for birdtest, because a sync API change also has to stay compatible with devices up to 90 days old.

### PROC-2. UX lessons from birdtest's first week

These changes came from the owner and users once birdtest was live. They are cheap to check in acrodont now:
- **Phone layout.** A three-row header became two rows. Tables wider than the screen became stacked blocks. Long names got `min-w-0 truncate` with a `title`. An e2e test at 393 px asserts nothing overflows. Acrodont's `touch.spec.ts` covers the player; add a no-overflow check for `/cascades`, `/trash`, `/account`, `/admin` and the builder.
- **Plain wording.** The owner rewrote the site's text in their own words. User-facing names changed ("player", not "config") while URLs and API fields kept their old names. Plan one wording pass over acrodont's pages before launch.
- **Dates show the year.** Status uses an icon as well as a colour. Field errors appear in red under the field. Form validation matches the server's exactly.
- **One control for one state.** Birdtest removed a separate "Activate" button once allocation became the only switch.
- **Decide early who each page is for.** Birdtest made saved positions public a week after launch.

---

## 13. Looks applicable, but should not come over

| Birdtest practice | Why it seems relevant | Why not for acrodont |
|---|---|---|
| **A single backend task with stop-first deploys** (`minimum_healthy_percent = 0`, `desired_count` validated to 0..1) | Same stack, and acrodont is moving to one task (COST-1) | Birdtest holds correctness-critical state in process: dispatch holds, the scheduler, SSE subscribers, imports. Two instances would be wrong, so it accepts a 2–8 minute API gap per deploy. Acrodont was designed for several instances: advisory-locked purge, `LISTEN/NOTIFY` catalog reload, no SSE. So it should **roll** (100/200, DEP-3), with no gap. Copying birdtest's settings would add an outage to every deploy. |
| **Splitting the frontend into its own ECS service** (8e7618a) | Birdtest says it made page deploys gapless | Birdtest split it *because* its backend deploys are stop-first. Acrodont's two-container task already rolls without a gap, so the split would add ~$9/month, a second target group and a second deploy unit for nothing. A frontend-only change will also restart the backend and reload the catalog, which is acceptable for a rolling deploy as long as MIG-4's startup budget holds. |
| **ALB routes `/api/*` straight to the backend; compression moved into Axum** | Birdtest's gzip-in-Nginx didn't help production | That was a consequence of the split above. Acrodont's Nginx proxies `/api`, and the API already compresses in Axum, which is right. Take only EDGE-3 (static gzip, `/api` gzip off). |
| **`/api/*` over HTTP answers 426 instead of redirecting** (KL-84) | It looks like general hygiene | It protects worker clients that send API keys in headers. Acrodont's only client is its own SPA, served over HTTPS with HSTS and Secure cookies, so a plain-HTTP API request carries no credential. The redirect is fine. |
| **RDS master password set by hand, because managed rotation locked the service out** | Acrodont uses `manage_master_user_password = true` | Birdtest's service connects **as the master user**, so the 7-day rotation broke its fixed `DATABASE_URL`. Acrodont's app and dump use their own roles (`acrodont_app`, `acrodont_backup`), so rotating the master password is harmless and a security gain. Keep it. Just give OPS-1 a way to read the master secret for one-time setup. |
| **The frequent scheduled builder, and the hourly-build cost fix** | The largest single saving in birdtest's cost plan | Acrodont has no scheduled compute besides the nightly dump, since the purge runs inside the backend. The only general lesson is that **Fargate bills at least a minute per task start**, so don't schedule small, frequent tasks. |
| **Post-launch database resets** (`reset-prod-db.sh`, `--reset-db` in deploy, deleting dumps under Object Lock) | Birdtest needed them | Needed only because birdtest kept editing `0001` after going live. Under MIG-3 acrodont never resets production. Don't build the tooling, and don't give any role `s3:BypassGovernanceRetention`. |
| **The `prod.tfvars` race check, a release log of tag pairs, `ops_path_components`** | They are part of `deploy.sh` | Partly. Keep the tfvars fetch-and-compare (DEP-1). Skip the per-service tag pairs and path-to-service mapping, since acrodont has one task definition, so a release is one tag. |
| **Region-loss rebuild** (`name_suffix`, a `dr` workspace, a twice-yearly scratch-account drill) | Birdtest's DR is thorough | Far heavier than acrodont needs at launch. Keep only the cheap part, which acrodont already has: dumps in a second region. A region loss means a manual rebuild from the dumps. |
| **Fake workers, MAGPIE pins, version floors, derived files, the GitHub data stand-in, worker windows, contributor identities** | They are most of birdtest's dev.py | Specific to birdtest's domain. Acrodont's equivalent of "seed a job" is "seed a cascade state" (DEV-1 scenarios). |
| **MinIO and the S3 artifact bucket in the local stack** | Part of birdtest's compose | Acrodont stores nothing as files in v1: catalog uploads become rows. Take only the lesson about vanished images (MON-3). |
| **Moving `sqlx::query!` to runtime queries plus tier-2 SQL tests** | Birdtest has no `.sqlx` offline data | Birdtest never used compile-checked queries, and two SQL bugs shipped because of it. Acrodont's compile-checked queries are better; don't copy birdtest here. |
| **ARM (Graviton) rejected for floating-point reasons** | Looks like a rule to copy | Birdtest's reason (MAGPIE's float results must hash identically) doesn't apply to acrodont: its shuffles are integer SplitMix64, and leave values are rounded decimals. ARM Fargate would save ~20% of the task line. It is a reasonable later option, but it needs ARM builds in the deploy, so it isn't recommended now. |
| **Its audit loop** (33 automated passes, `AUDIT_FINDINGS_N.md`) | It found most of birdtest's infra bugs | Worth one targeted pass on acrodont's `infra/`, `docker/` and `scripts/` after this plan lands, not a 33-pass loop. Most of what birdtest's audits found is already in this document. |
| **Birdtest's long code comments explaining each past incident** | They taught a lot | Useful history, but a style rather than a practice. The lessons are captured here and in tests (EDGE-4, SEC-3). |

## 14. Already right in acrodont (checked, no action)

| Birdtest lesson | Acrodont |
|---|---|
| Logout must clear the session cookie with `Path=/` (764abe0) | `backend/src/auth/session.rs` sets `/` on both set and removal |
| Sign out only on 401, not on a 503 during a deploy (deaacd8) | `initSession` sets `needsLogin` only on 401, and the app is local-first anyway |
| Optimize Argon2 in the dev/test profile (85d8d06) | `[profile.dev.package.argon2]` and `blake2` at `opt-level = 3` |
| `index.html` revalidated on every visit (`no-cache`) | Set on `/`, `/index.html` and `/service-worker.js` |
| Immutable ECR tags | `image_tag_mutability = "IMMUTABLE"` |
| `ubuntu-24.04` pinned for Playwright (c5013d8) | Both CI jobs pin `ubuntu-24.04` |
| Backups in a second region, versioned, Object Lock in GOVERNANCE mode | `infra/backups.tf` |
| Backup staleness alarm with missing data as breaching | `acrodont-no-dump-36h` |
| Log metric filters on JSON fields, not phrases (visitor-controlled Nginx lines) | The sync filters match `$.fields.*` |
| API compression in the backend, never for streams | `CompressionLayer` in `app.rs`; acrodont has no SSE |
| Graceful shutdown on SIGTERM | `with_graceful_shutdown(shutdown_signal())`; add DEP-3's `stopTimeout` |
| The dev environment and the tests share one stack definition | `scripts/stack.py` is used by dev.py, e2e, scale and CI |
| `TRUSTED_PROXY_HOPS = 1` behind the ALB | Set in `infra/ecs.tf` |
| `ses:SendEmail` scoped to the identity | `infra/iam.tf` |

---

## Suggested order

| Step | Items | Why together |
|---|---|---|
| 1. Before the first apply | SEC-1, COST-1 (measure, semaphore, resize), COST-2, COST-3, COST-5, DEP-2, DEP-3, EDGE-1, EDGE-2, MIG-1, MIG-2, MIG-3 (decision), MON-1, MON-2, SEC-2, OPS-3, DEV-3 | Terraform and image changes that are free now and need migrations, replacements or secret rotation later |
| 2. The deploy path | DEP-1, DEP-4, OPS-1, OPS-2 (first scripts), CI-2 | The first real deploy should go through the tool every later deploy uses |
| 3. dev.py phases A and B | DEV-1 A–B, DEV-4, MIG-4 (uses `--stats`) | Needed for COST-1's measurement and for working comfortably |
| 4. Before announcing | MAIL-1–4, EDGE-3, EDGE-4, SEC-3, SEC-4, BAK-2, MON-3, CI-1, DEV-6, PROC-2 | Launch hygiene; SES production access takes about a day |
| 5. After launch | DEV-1 C–D, DEV-2, DEV-5, BAK-1, PROC-1, OPS-2 (fakes) | Comfort and resilience |

## Decisions needed from you

| # | Decision | Recommendation |
|---|---|---|
| D1 | Deploy from your laptop with Terraform (birdtest's model), or keep GitHub Actions? (DEP-1) | Laptop `deploy.sh`, Terraform as the only deployer |
| D2 | One task or two? (COST-1) | One, with a rolling 100/200 deploy |
| D3 | Tasks in public subnets with no NAT? (COST-2) | Yes |
| D4 | RDS `micro` or `small`, and a 7-day PITR window? (COST-3) | `micro` if the constrained scale test passes; 7 days |
| D5 | Append-only migrations from the first apply, with no "until real launch" exception? (MIG-3) | Yes |
| D6 | Where real catalog files live for `dev.py --real-catalog`, and who makes the three-column CSW24 file? (DEV-1) | `$ACRODONT_CATALOG_DIR` pointing at `~/Dropbox/WordGameMisc`, with a local `manifest.json` outside the repo |
