# Faster tests: a plan

**Date:** 2026-11-11
**Status:** implemented 2026-11-11, as decided: T1 yes, T2 yes, T3 C1, T4
yes, T5 yes, T6 no; with D, F, G, H, I and the `deploy.sh --branch main` fix.
The ten-runs-in-a-row check below was cut short at five clean runs, after
fixing the flakes it found. From now on the owner's rule applies instead:
flakiness is fixed when it shows up, and nothing waits on repeated runs. What was measured locally is under
[Measured](#measured); what only CI can show is listed there too.

## The problem

A change to this project takes too long to verify:

- **CI on every push:** about **18 minutes** wall clock. The end-to-end job is
  the critical path.
- **Nightly scale run:** about **40 minutes**, on `main` only.
- **Verifying a change locally**, the way changes have been checked so far
  (`make test-unit`, `make test-integration`, the full `make test-e2e`,
  sometimes `make test-scale`): **30 to 75 minutes**. A failure in one
  environment pass means rerunning the whole suite.

For a project of this size, a push should be checked in **5 minutes or
less**, with the slow, rarely-failing checks moved to where they cost nobody a
wait.

## Where the time goes

Measured on CI run 43089142394 (a push to `preferences-scopes`, all green)
and the nightly run 43017027997.

| Job | Time | Inside it |
|---|---|---|
| **e2e** | **17.6 min** | Checkout, Node and Chromium: 0.5 min |
| | | Docker build of the backend (release Rust) and frontend images, cold: **5.6 min** |
| | | Main pass, 39 tests on **1 worker**: 4.8 min, including `update.spec.ts` bringing the stack up twice more |
| | | Five environment passes (`@ttl`, `@purge`, `@limits`, `@answers`, `@budget`), one after another, each on its own stack: 4.0 min. `@budget` alone is 2.2 min |
| | | "Seeding under a two-a-minute upload limit": **2.6 min**, most of it waiting out the rate limit by design |
| integration | 7.0 min | Compile: 0.6 min. Then **16 test binaries run one after another**, about 5.5 min. Each binary runs its own tests in parallel, but the next binary waits. The slowest binaries take 43–57 s, partly from tests that wait out real time (sessions, rate windows) |
| unit | 3.5 min | `cargo test --lib`, svelte-check and 609 Vitest tests, in one job and in sequence |
| lint, terraform, scripts | under 1 min each | |
| scale (nightly) | 39.8 min | The server half at 300,000 questions (the push step alone has a 600 s budget), then the device half in Chromium |

Locally, the same suites take about as long or longer: a developer machine
builds the same images and runs the same single-worker passes. The scale
suite's device half takes over 20 minutes alone.

## The options

### A. Run only some checks on every push (tiers)

| Tier | When | What |
|---|---|---|
| **Push** | Every push, every branch | lint, unit, integration, and the **core** end-to-end pass: the main suite without the environment passes, the seeding check or `update.spec.ts` |
| **Main** | Push to `main` (and a manual run on any branch) | Everything above, plus the five environment passes, `update.spec.ts` and the seeding check: today's full push suite |
| **Nightly** | 04:30 UTC on `main` (and a manual run) | `make test-scale`, plus the Main tier, so a flaky test shows up once a day without blocking anyone |

- **Saves:** about 7 minutes of the push tier's e2e job on its own: the
  environment passes, the seeding wait and the update spec's rebuilds.
- **Risk:** a branch can be green and still fail on `main`. Deploys are
  unaffected:
  - `scripts/deploy.sh` refuses a commit whose CI run is not green
  - deploys are made from `main`
  - `main` runs the full tier, so the deploy gate is unchanged
- **One catch for the deploy gate:** a commit pushed to a branch and then
  fast-forwarded to `main` has the same SHA, so it has two runs, the
  branch's Push tier and `main`'s Main tier. `deploy.sh` reads the latest run
  for the commit (`gh run list --commit … --limit 1`). It should ask for the
  run on `main` (`--branch main`), so a green Push-tier run alone never clears
  a deploy.
- **Cost:** a few `if:` lines and a `--grep-invert` in the workflow; the
  Makefile gets `test-e2e-core` beside `test-e2e`.

### B. Run the end-to-end tests in parallel

The suite runs `workers: 1, fullyParallel: false`. Most journeys already
isolate themselves: each makes its own user with `newUser`. Four workers
against the one stack could take the main pass from about 5 minutes to under 2.

What has to be handled first:
- **Tests that change shared state**, which run in a serial group of their own:
  - `admin.spec.ts`, which uploads catalog items
  - `update.spec.ts`, which restarts the stack
  - anything that logs in as the seeded `dev` admin
- **The per-IP auth limit:** every browser comes from 127.0.0.1, and
  `AUTH_RATE_PER_IP_PER_MINUTE` is 30. The e2e stack needs a higher value;
  `@limits` and the rate-limit tests that need the real figure keep their
  own stacks.
- **Timing-sensitive journeys** (`plane.spec.ts`, `two-devices.spec.ts`, the
  Trash and export journeys) have needed waits added before. They would be
  run 10 times in a row with 4 workers before parallel is turned on.

**Saves:** about 3 minutes on every push.

### C. Stop rebuilding the images from scratch

The cold Docker build is 5.6 minutes on every CI run, because its cache mounts
(cargo registry, `target/`, npm) do not survive between runs. Two ways out:

1. **Build outside Docker, copy in.** The runner already caches Rust with
   `Swatinem/rust-cache` for the unit and integration jobs. Build the release
   binary and `frontend/build` on the runner, then use a thin `test` stage in
   each Dockerfile that only copies them in. The production images keep their
   own full build.
2. **Docker layer cache in GitHub's cache** (`docker buildx` with
   `cache-from/to: type=gha`). This is less work, but a Rust change still
   recompiles every crate in the image, because layer caching does not keep
   incremental build state.

**Recommendation:** option 1. **Saves:** about 4 minutes on every push.

### D. Run the environment passes side by side

The five passes already use separate ports and project names, so they can be
brought up and run at the same time, for example `make -j5` over five targets.
The time becomes the slowest pass, `@budget` at 2.2 minutes, instead of the
sum, 4 minutes. A 4-core runner holds five small stacks.

Some passes could also stop needing a stack of their own:
- **`@limits`** could use the new per-account `users.storage_limit_bytes`
  override, set with SQL for its own user, on the main stack.
- **`@ttl`, `@purge`, `@answers` and `@budget`** change server timing or
  client build constants, so they keep their stacks.

**Saves:** about 2 minutes where they run (Main and Nightly under option A).

### E. Run integration test binaries together

The integration job runs `cargo test --test '*'`, which runs the 16 test
binaries one after another. `cargo nextest run` schedules every test from
every binary in one pool. Each test already gets its own database
(`#[sqlx::test]`), so no test changes are needed. Postgres runs with
`max_connections=400`, and nextest's test threads may need a cap
(`--test-threads=16`) to stay under it.

**Saves:** about 3 to 4 minutes, from 5.5 down to the slowest single test
plus scheduling, about 1.5 to 2 minutes.

The tests that wait out real time could also use the clock the backend
already has (`clock.rs`) instead of sleeping. That is a separate, smaller
gain: do it only if a test is still the long pole after nextest.

### F. Split the unit job

Run `cargo test --lib`, svelte-check and Vitest as three parallel jobs, or two
(Rust, frontend). The job is not on the critical path today, but it would be
once e2e drops to about 5 minutes. **Saves:** about 1.5 minutes of wall clock.

### G. The seeding check

"Seeding under a two-a-minute upload limit" mostly waits: 7 uploads at 2 a
minute is about 3 minutes by construction. It checks that the dev seeding
script respects the upload limit, which only changes when the script does.
**Move it to Nightly**, and run it on push only when `scripts/` changes
(`paths` filter).

### H. Scale stays nightly, and leaves the local loop

The scale suite is already nightly-only in CI. It should also never be part
of an ordinary local check. To check a branch before merging, run CI's scale
job by hand (`workflow_dispatch`, which works on any branch) and keep
working while it runs.

### I. A short local loop

| Target | What it runs | About |
|---|---|---|
| `make test-quick` | `cargo test --lib`, svelte-check, Vitest | 2 min |
| `make test-e2e-core` | The core end-to-end pass (option A), parallel (option B), reusing a running stack if one is up (`E2E_KEEP_STACK`) | 3 min |
| `make test-e2e SPEC=typed` | One spec file | under 1 min |
| `make test-integration` | As today, with nextest (option E) | 2–3 min |

The rule for local verification, written into PLAN.md § Running the tests:
- run `test-quick`, the integration tests and the e2e specs the change
  touches
- push, and let CI's tiers run the rest
- never run `make test-scale` locally, except to investigate a scale failure

## Where this lands

| | Today | With A, B, C, E, F, G |
|---|---|---|
| Push to a branch | 18 min | **about 5 min**: e2e core 0.5 + 1.5 build + 2 tests + slack; integration about 2.5 |
| Push to `main` | 18 min | about 8 min, adding the environment passes side by side (D) |
| Nightly | 40 min | 40 min plus the Main tier, about 48. Nobody waits on it |
| Local check of a change | 30–75 min | about 5–10 min: quick, touched specs, integration |

The estimates come from the measured times above; the parallel figures
(B, D, E) depend on contention and get confirmed in step 1.

## Decisions

| # | Decision | Recommendation |
|---|---|---|
| T1 | Tiers (A): environment passes, `update.spec.ts` and the seeding check only on `main`, manual runs and nightly | **Yes.** The deploy gate is unchanged, because deploys come from `main` |
| T2 | Parallel e2e (B), 4 workers, with a serial group | **Yes**, after the 10-runs-in-a-row check |
| T3 | Prebuilt binaries in a thin test image (C1) or the GHA layer cache (C2) | **C1** |
| T4 | Fold `@limits` into the main stack using the per-account override (D) | **Yes** |
| T5 | nextest for integration (E) | **Yes** |
| T6 | Also run the full tier on pull requests into `main` | **Only if pull requests get used.** Pushes to `main` cover it today |

## Order of work

1. **Measure locally first**, with no workflow change:
   - nextest on the integration suite
   - 4 Playwright workers on the main pass, ten runs
   - the environment passes side by side

   Record the times in this file.
2. **CI tiers (A) and the seeding check (G):** the biggest saving for the
   least risk.
3. **Prebuilt test images (C1):** the largest single step on every push.
4. **nextest (E) and the split unit job (F).**
5. **Parallel e2e (B)** once step 1's ten runs are clean, and `@limits` on the
   main stack (D).
6. **The local targets (I)**, and the rule in PLAN.md § Running the tests,
   with `.github/workflows/ci.yml`'s header comment updated to describe the
   tiers.

## Measured

Locally on 2026-11-11 (12 cores, Ubuntu 22.04), before and after, same tree.

| What | Before | After |
|---|---|---|
| `make test-integration` (164 tests) | 9 min 14 s: `cargo test`, 16 binaries one after another (compile 24 s) | **1 min 53 s** with `cargo nextest run --test-threads 16`. The long pole is `pull::the_first_page_fixes_the_ceiling_and_the_list`, 69 s |
| `make test-e2e-core` (38 side-by-side journeys + 2 `@serial`) | 4 min 49 s on 1 worker (`E2E_WORKERS=1`; journeys 4.3 min, serial 28 s) | **1 min 52 s to 2 min** on 4 workers (journeys 1.4–1.5 min, serial 27–30 s), stack up and down included |
| Backend image for the e2e stacks | A cold Docker build of release Rust (5.6 min on CI) | `backend-prebuilt`: 9.5 s cold for the image (apt layer), about 1 s cached; the stack up to a healthy `/health` in 15 s. The release binary is built on the host: 4 min 19 s incremental here at `CARGO_BUILD_JOBS=2` after a source change, seconds when nothing changed |
| `make test-quick` | (`make test-unit`, in sequence) | 2 min 0 s, backend and frontend halves side by side |

**The ten-runs check (T2), cut short at the owner's request:** the first two
series failed (run 1, then run 2) on three flakes: `player.spec.ts`,
`accounts.spec.ts` and `tabs.spec.ts`, each checking or navigating before the
real condition, which four workers' load exposed. Each was fixed by waiting
for that condition, with no added timeouts, and the same patterns in
`journeys.spec.ts` and `segments.spec.ts` with them:
- `player.spec.ts`: the answer's size was compared with the question's without
  the player's `--fit` factor; a shuffle that puts AEINRST's nine anagrams
  first shrinks the answer (1 in 18 runs, on 1 worker too). Now compared at
  the fit.
- `accounts.spec.ts`, `player.spec.ts`, `journeys.spec.ts`: left the player
  right after a press, before the grade and cursor move were saved (the screen
  moves first), as the plane journey once did. They now wait for the outbox
  (`outboxCount`, the new `cursorSaved`).
- `tabs.spec.ts`: pressed 40 times without waiting for the player to show its
  first card, or each card to be ready; now waits per card, as `playLevel`
  does. `segments.spec.ts`'s loop got the same wait.

After the fixes, the specs touched passed 40 and 18 repeated runs on 4
workers, and the final series ran **5 clean `make test-e2e-core` runs in a
row** (112–120 s each) before it was stopped.

**Not measured locally:** `make test-e2e-main` (update.spec and the four
`@env` passes side by side) and the full `make test-e2e` were skipped at the
owner's request; CI runs them on the first `workflow_dispatch` after the
push. The CI-only behaviour also still to be seen there: the tiers' `if:`
conditions, the paths filter for the seeding check, the shared `e2e-release`
Rust cache, nextest installed by `taiki-e/install-action`, and the push-tier
wall clock (estimated about 5 minutes).
