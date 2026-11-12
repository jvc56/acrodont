# Test targets (PLAN.md § Running the tests). Each runs with no arguments.
SHELL := /bin/bash
.ONESHELL:
.SHELLFLAGS := -e -o pipefail -c

# Node 20+ is needed: the one on PATH, else NODE_BIN, else an `n` install under
# $N_PREFIX.
NODE_BIN ?= $(if $(N_PREFIX),$(wildcard $(N_PREFIX)/bin))
ifneq ($(NODE_BIN),)
export PATH := $(NODE_BIN):$(PATH)
endif

# Playwright has no build for Ubuntu 20.04; its Ubuntu 22.04 Chromium runs there.
ifneq ($(shell grep -s '^VERSION_ID="20.04"' /etc/os-release),)
export PLAYWRIGHT_HOST_PLATFORM_OVERRIDE ?= ubuntu22.04-x64
endif

# Queries are compile-checked against the committed .sqlx data, so no
# database is needed to build.
export SQLX_OFFLINE := true

# Uncapped, cargo's release build of the AWS SDK froze a 16 GB machine
# (birdtest); CI raises it.
export CARGO_BUILD_JOBS ?= 2

.PHONY: infra-validate ops-check test test-quick test-unit test-unit-backend test-unit-frontend \
        test-integration test-e2e test-e2e-core test-e2e-main test-e2e-seeding test-scale test-parity \
        frontend-deps e2e-deps e2e-binary e2e-pass-full e2e-pass-ttl e2e-pass-purge e2e-pass-answers \
        e2e-pass-budget sqlx-db sqlx-prepare

test: test-unit test-integration test-e2e

frontend-deps:
	cd frontend && { [ -d node_modules ] || npm ci; }

## cargo test --lib, npm run check, Vitest. No services.
test-unit: test-unit-backend test-unit-frontend

test-unit-backend:
	cd backend && cargo test --lib

test-unit-frontend: frontend-deps
	cd frontend && npm run check && npx vitest run --passWithNoTests

## The unit layer, its backend and frontend halves side by side: the first
## check of a change (PLAN.md § Running the tests).
test-quick:
	$(MAKE) --no-print-directory -j2 --output-sync=target test-unit-backend test-unit-frontend

## Every integration test binary's tests in one pool (cargo-nextest), against
## a throwaway Postgres it starts itself. Each test has its own database
## (#[sqlx::test]); 16 at a time keep well inside max_connections=400.
## Without nextest, cargo test runs the binaries one after another.
## The tests that measure time (registration's equal branches, the reset
## request's answer, the 130,000-question finish budget) run afterwards on
## their own: in the pool, the other tests' Argon2 and zxcvbn work skews them.
NEXTEST_THREADS ?= 16
TIMED_TESTS = test(=registration_branches_take_the_same_time) | test(=password_reset) | test(=a_130000_question_finish_and_reset)
test-integration:
	cid=$$(docker run -d --rm -e POSTGRES_PASSWORD=acrodont -p 127.0.0.1::5432 \
	  --tmpfs /var/lib/postgresql/data postgres:16 \
	  -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=400)
	trap 'docker rm -f $$cid >/dev/null' EXIT
	port=$$(docker port $$cid 5432/tcp | head -1 | sed 's/.*://')
	for i in $$(seq 1 120); do
	  docker exec $$cid pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
	  sleep 0.5
	done
	cd backend
	export TEST_DATABASE_URL=postgres://postgres:acrodont@127.0.0.1:$$port/postgres
	# #[sqlx::test] reads DATABASE_URL; each test gets its own database.
	export DATABASE_URL=$$TEST_DATABASE_URL
	if cargo nextest --version >/dev/null 2>&1; then
	  cargo nextest run --locked --test '*' --test-threads $(NEXTEST_THREADS) -E 'not ($(TIMED_TESTS))'
	  cargo nextest run --locked --test '*' --test-threads 1 -E '$(TIMED_TESTS)'
	else
	  echo "cargo-nextest not installed (cargo install cargo-nextest --locked): running the binaries one after another" >&2
	  cargo test --locked --test '*'
	fi

## End-to-end (PLAN.md § End-to-end tests). Each pass on a stack runs the
## journeys side by side (Playwright project `parallel`, E2E_WORKERS of them),
## then the @serial ones alone (project `serial`), and takes the stack down
## after both unless E2E_KEEP_STACK is set; a kept stack is reused by the next
## run, whose `up` rebuilds only what changed. The backend image copies in the
## release binary built here (docker/backend.Dockerfile, backend-prebuilt);
## ACRODONT_BACKEND_TARGET=backend builds it inside Docker instead.
##
##   make test-e2e-core          every journey on one stack: CI's Push tier
##   make test-e2e-main          update.spec and the @env passes, each on its
##                               own stack, side by side: CI's Main tier adds it
##   make test-e2e               both: the whole suite
##   make test-e2e SPEC=typed    one spec file (or any Playwright file filter)
##                               on the suite's stack; not the @env journeys
##   make test-e2e-seeding       seeding under a two-a-minute upload limit
E2E_WORKERS ?= 4
export E2E_WORKERS
test-e2e test-e2e-core test-e2e-main test-e2e-seeding e2e-binary: export ACRODONT_BACKEND_TARGET ?= backend-prebuilt

e2e-deps: frontend-deps
	cd e2e && { [ -d node_modules ] || npm ci; } && npx playwright install chromium >/dev/null

e2e-binary:
	if [ "$$ACRODONT_BACKEND_TARGET" = backend-prebuilt ]; then
	  cd backend && cargo build --release --locked --bin acrodont
	fi

# One stack's two passes; $(1) is the Playwright filter. The second runs even
# when the first fails, so the stack still comes down and every failure shows.
define e2e_passes
	cd e2e
	status=0
	E2E_KEEP_STACK=1 npx playwright test $(1) --project parallel || status=$$?
	E2E_STACK_READY=1 npx playwright test $(1) --project serial --no-deps --output test-results/serial || status=$$?
	exit $$status
endef

test-e2e-core: e2e-deps e2e-binary
	$(call e2e_passes,--grep-invert '@env|@full')

test-e2e-main: e2e-deps e2e-binary
	$(MAKE) --no-print-directory -k -j5 --output-sync=target \
	  e2e-pass-full e2e-pass-ttl e2e-pass-purge e2e-pass-answers e2e-pass-budget

ifdef SPEC
test-e2e: e2e-deps e2e-binary
	cd e2e && npx playwright test --list --grep-invert @env $(SPEC) >/dev/null
	cd ..
	$(call e2e_passes,--grep-invert @env --pass-with-no-tests $(SPEC))
else
test-e2e: e2e-deps e2e-binary
	$(MAKE) --no-print-directory test-e2e-core
	$(MAKE) --no-print-directory test-e2e-main
endif

# test-e2e-main's passes, each on its own stack and port, run side by side.
# update.spec restarts its stack, so it has one of its own.
e2e-pass-full:
	cd e2e && E2E_PROJECT=acrodont-e2e-update E2E_PORT=5186 \
	  npx playwright test --project serial --no-deps --grep @full --output test-results/full
# The journeys that need the stack configured differently (PLAN.md § End-to-end
# tests: "through the same --env flag a developer would use").
e2e-pass-ttl:
	cd e2e && E2E_PROJECT=acrodont-e2e-ttl E2E_PORT=5181 E2E_ENV='SESSION_TTL_SECONDS=20' E2E_TTL_WAIT_MS=25000 \
	  npx playwright test --project parallel --grep @ttl --output test-results/ttl
e2e-pass-purge:
	cd e2e && E2E_PROJECT=acrodont-e2e-purge E2E_PORT=5182 E2E_ENV='TRASH_RETENTION_DAYS=0 PURGE_INTERVAL_SECONDS=3' \
	  npx playwright test --project parallel --grep @purge --output test-results/purge
# The storage journeys, on a frontend built with lowered client limits ("lowered with a test constant").
e2e-pass-answers:
	cd e2e && E2E_PROJECT=acrodont-e2e-answers E2E_PORT=5184 ACRODONT_TEST_LIMITS='{"AUTO_KEEP_OFFLINE_ROWS":30,"ANSWER_STORAGE_SOFT_LIMIT_BYTES":2000}' \
	  npx playwright test --project parallel --grep @answers --output test-results/answers
e2e-pass-budget:
	cd e2e && E2E_PROJECT=acrodont-e2e-budget E2E_PORT=5185 ACRODONT_TEST_LIMITS='{"AUTO_KEEP_OFFLINE_ROWS":30,"ROW_STORAGE_BUDGET":5000}' \
	  npx playwright test --project parallel --grep @budget --output test-results/budget

## PLAN.md § End-to-end tests → What the tests reuse: seeding once more with
## ADMIN_UPLOAD_RATE_PER_MINUTE=2, where it must wait out 429s and still finish.
## CI runs it on main, nightly, and when scripts/ change.
test-e2e-seeding: e2e-binary
	trap 'python3 scripts/stack.py down --project acrodont-ci-seed --volumes' EXIT
	python3 scripts/stack.py up --project acrodont-ci-seed --port 5190 --env ADMIN_UPLOAD_RATE_PER_MINUTE=2
	python3 scripts/stack.py seed --project acrodont-ci-seed --port 5190

## The 300,000-question budgets (PLAN.md § Scale tests): the server's half
## against a throwaway Postgres with production durability settings, in
## release mode, one test at a time; then the device's half in Vitest.
test-scale: frontend-deps
	cid=$$(docker run -d --rm -e POSTGRES_PASSWORD=acrodont -p 127.0.0.1::5432 postgres:16 \
	  -c max_connections=400 -c shared_buffers=512MB)
	trap 'docker rm -f $$cid >/dev/null' EXIT
	port=$$(docker port $$cid 5432/tcp | head -1 | sed 's/.*://')
	for i in $$(seq 1 120); do
	  docker exec $$cid pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
	  sleep 0.5
	done
	cd backend
	DATABASE_URL=postgres://postgres:acrodont@127.0.0.1:$$port/postgres \
	  cargo test --release --test scale -- --ignored --test-threads=1 --nocapture
	cd ../frontend && npx playwright install chromium >/dev/null && npx vitest run --config vitest.scale.config.ts

## Zyzzyva comparison; skipped with a notice unless the licensed files are present.
test-parity:
	python3 scripts/parity.py

## Development helpers for compile-checked queries: a Postgres on :55432
## holding the schema, and regeneration of backend/.sqlx.
sqlx-db:
	docker rm -f acrodont-sqlx >/dev/null 2>&1 || true
	docker run -d --name acrodont-sqlx -e POSTGRES_USER=acrodont -e POSTGRES_PASSWORD=acrodont \
	  -e POSTGRES_DB=acrodont -p 127.0.0.1:55432:5432 postgres:16 >/dev/null
	for i in $$(seq 1 120); do
	  docker exec acrodont-sqlx pg_isready -h 127.0.0.1 -U acrodont >/dev/null 2>&1 && break
	  sleep 0.5
	done
	# Every migration, in order: a schema built from the first file alone falls
	# behind once there is a second (birdtest's nightly did).
	for f in backend/migrations/*.sql; do
	  docker exec -i acrodont-sqlx psql -v ON_ERROR_STOP=1 -q -U acrodont -d acrodont < "$$f"
	done

sqlx-prepare:
	cd backend && SQLX_OFFLINE=false DATABASE_URL=postgres://acrodont:acrodont@127.0.0.1:55432/acrodont \
	  cargo sqlx prepare -- --all-targets

## Terraform's format, validity and the offline variable tests (a mock
## provider, no credentials), with the local terraform if it is 1.11 or later,
## else the pinned image. fmt checks the committed files only: -recursive would
## also flag the git-ignored prod.tfvars.
TERRAFORM_VERSION := 1.16.5
LOCAL_TF_OK := $(shell terraform version 2>/dev/null | head -1 | grep -qE 'v1\.(1[1-9]|[2-9][0-9])\.' && echo yes)
ifeq ($(LOCAL_TF_OK),yes)
TF := terraform -chdir=infra
else
TF := docker run --rm -u $$(id -u):$$(id -g) -v $(CURDIR)/infra:/infra -w /infra hashicorp/terraform:$(TERRAFORM_VERSION)
endif
infra-validate:
	$(TF) init -backend=false -input=false >/dev/null
	$(TF) validate
	$(TF) fmt -check $$(cd infra && git ls-files '*.tf' '*.tftest.hcl')
	$(TF) test

## Operator scripts: the runbook's fenced blocks (labelled, parsing, AWS_PAGER
## off), and scripts/*.sh against stand-ins for aws, terraform, gh and docker.
.PHONY: ops-check
ops-check:
	scripts/runbook-check.sh
	scripts/ops-scripts-check.sh
