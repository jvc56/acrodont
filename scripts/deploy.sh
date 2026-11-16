#!/usr/bin/env bash
# Deploy the checked-out commit of main to production. Terraform is the only
# deployer; this runs from the operator's laptop.
#
#   scripts/deploy.sh [--all] [--skip-ci-check] [--reset-database] [--set KEY=VALUE]...
#
# In order, stopping at the first thing wrong:
#   1. the checkout: clean, HEAD on origin/main, CI's run on main green on this
#      exact commit (--skip-ci-check for an emergency); a red scheduled CI run
#      on main warns, and so does one more than two days old;
#   2. login, Terraform outputs, prod.tfvars from the state bucket;
#   3. what is live: the backend image tag of the service's PRIMARY deployment,
#      which must equal prod.tfvars' image_tag (else ECS rolled back: run
#      scripts/rollback.sh first);
#   4. what changed since the live tag: backend/, frontend/, docker/,
#      contract-fixtures/ and the ops scripts baked into images -> rebuild;
#      infra/ -> plan and apply; anything else -> nothing (--all deploys anyway);
#   5. migrations: anything but an added file under backend/migrations/ is
#      refused (append-only; production is never reset) -- except with
#      --reset-database, which asks for `reset` typed and goes on;
#   6. the three images ECR lacks are built (linux/amd64, capped jobs) and
#      pushed; tags are immutable, so one already there is this commit;
#   7. image_tag and any --set written to prod.tfvars; with --reset-database,
#      first a plan gate and apply of the new release at desired count 0, a
#      wait until every task has stopped, and the database's schema dropped
#      and made again, empty; the plan gate; apply (with --reset-database,
#      setting the desired count back); prod.tfvars uploaded;
#   8. the wait: one COMPLETED deployment running this tag with the cpu and
#      memory applied, healthy targets, and https://$SITE/health.
#
# --reset-database is for before launch only, when 0001_initial.sql was edited
# in place (docs/migration-edits.md): it deletes every account and everything
# the app has stored, and the new backend migrates the empty database as it
# starts. Never once real users have accounts (docs/runbook.md).
set -euo pipefail
# shellcheck source=scripts/lib/ops.sh
source "$(dirname "$0")/lib/ops.sh"

usage() { sed -n '5p' "$0" >&2; exit 2; }

all=0 skip_ci=0 reset=0 sets=()
while (($#)); do
  case $1 in
    --all) all=1 ;;
    --skip-ci-check) skip_ci=1 ;;
    --reset-database) reset=1 ;;
    --set) [[ $# -ge 2 && "$2" == *=* ]] || usage; sets+=("$2"); shift ;;
    --set=*=*) sets+=("${1#--set=}") ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//' >&2; exit 0 ;;
    *) usage ;;
  esac
  shift
done
for kv in ${sets[@]+"${sets[@]}"}; do
  [[ "${kv%%=*}" != image_tag ]] || ops_die "image_tag is set by deploy.sh itself (or rollback.sh)"
done

ops_init
ops_need git gh aws terraform jq docker curl
cd "$OPS_ROOT"

# 1. The checkout.
[[ -z "$(git status --porcelain --untracked-files=no)" ]] \
  || ops_die "uncommitted changes: deploy a clean checkout (the image tag is the commit)"
# A file git does not track is still copied into an image whose tag says it
# is the commit (.dockerignore is not .gitignore).
untracked=$(git ls-files --others --exclude-standard -- backend frontend docker contract-fixtures scripts)
[[ -z "$untracked" ]] \
  || ops_die "untracked files where the images are built from: commit, ignore or move them first: $(tr '\n' ' ' <<<"$untracked")"
git fetch -q origin main || ops_die "git fetch origin main failed"
git merge-base --is-ancestor HEAD origin/main \
  || ops_die "HEAD is not on origin/main: deploy only from main (git checkout main && git pull)"
commit=$(git rev-parse HEAD)
tag=$(git rev-parse --short=12 HEAD)
[[ "$commit" == "$(git rev-parse origin/main)" ]] \
  || ops_say "note: HEAD ($tag) is behind origin/main ($(git rev-parse --short=12 origin/main))"

if ((skip_ci)); then
  ops_say "WARNING: CI not checked (--skip-ci-check)"
else
  # On main: a branch's run of the same commit is only the Push tier
  # (.github/workflows/ci.yml), which must never clear a deploy alone.
  # The push's own run: the newest run of the commit may be the nightly, whose
  # green would clear a commit whose push run was red, and whose red only warns.
  ci=$(gh run list --workflow ci.yml --branch main --commit "$commit" --event push --limit 1 --json status,conclusion,url) \
    || ops_die "gh could not list CI runs (gh auth status?)"
  ci=$(jq -r '.[0] // empty | "\(.status) \(.conclusion // "") \(.url)"' <<<"$ci")
  [[ -n "$ci" ]] || ops_die "no CI run on main for $tag yet: wait for it, or --skip-ci-check in an emergency"
  read -r ci_status ci_conclusion ci_url <<<"$ci"
  [[ "$ci_status" == completed && "$ci_conclusion" == success ]] \
    || ops_die "CI for $tag is $ci_status/${ci_conclusion:-pending}: $ci_url"
  ops_say "CI green for $tag"
fi
# The nightly run covers what per-commit CI does not; red there only warns.
# So does an old one: GitHub stops a repository's scheduled workflows after
# sixty days without activity, and the last result then stays green for good.
# The age is worked out by jq (GNU and BSD `date` parse differently).
nightly=$(gh run list --workflow ci.yml --branch main --event schedule --limit 1 \
  --json conclusion,url,createdAt 2>/dev/null | jq -r '
    if length == 0 then "none"
    else .[0] | "\(.conclusion // "" | if . == "" then "running" else . end) \(.url) \(try (((now - (.createdAt | fromdateiso8601)) / 86400) | floor) catch "")"
    end' 2>/dev/null) || nightly=""
if [[ "$nightly" == none ]]; then
  ops_say "WARNING: no scheduled CI run on main was found: the nightly (the Main tier and the scale suite) has not checked this code. Is the schedule enabled (gh workflow view ci.yml)?"
elif [[ -n "$nightly" ]]; then
  read -r nightly_conclusion nightly_url nightly_age <<<"$nightly"
  # A run still going has no conclusion yet, and says nothing either way.
  if [[ "$nightly_conclusion" != success && "$nightly_conclusion" != running ]]; then
    ops_say "WARNING: the latest scheduled CI run on main is $nightly_conclusion: $nightly_url"
  fi
  if [[ "$nightly_age" =~ ^[0-9]+$ ]] && ((nightly_age > 2)); then
    ops_say "WARNING: the latest scheduled CI run on main is $nightly_age days old: $nightly_url. The nightly has stopped running, so its result says nothing about this code (GitHub disables schedules after 60 days without activity: gh workflow enable ci.yml)."
  fi
fi

# 2. The stack.
ops_load_env
ops_require STATE_BUCKET STATE_REGION SITE
ops_login
ops_stack
ops_ecr
ops_tfvars_fetch

# 3. What is live.
state_tag=$(ops_tfvar image_tag)
[[ -n "$state_tag" ]] || ops_die "prod.tfvars has no image_tag (the first apply sets a placeholder; docs/runbook.md)"
live=$(ops_live_tag) || ops_die "cannot read what the service $OPS_SERVICE runs"
if [[ "$live" != "$state_tag" && "$live" == "$tag" ]]; then
  # An apply of this very release that stopped part-way: the service was
  # updated, prod.tfvars was never uploaded. Not a rollback; this run ends it.
  ops_say "the service already runs $tag, which prod.tfvars does not name yet ($state_tag): an apply of this release stopped part-way. Finishing it"
  # Its images are in ECR already; the plan is whatever the apply left undone.
  all=1
elif [[ "$live" != "$state_tag" ]] && ((reset)); then
  # ECS rolled a release back (a reset whose old tasks migrated the emptied
  # database, say). The database is emptied again anyway, so this run
  # replaces whatever came back, rather than rollback.sh, which refuses a
  # release whose 0001 differs.
  ops_say "the service runs $live, but prod.tfvars names $state_tag: ECS rolled that release back. --reset-database deploys $tag over it"
  all=1
elif [[ "$live" != "$state_tag" ]]; then
  ops_show_events
  ops_die "the service runs $live, but prod.tfvars (and Terraform) name $state_tag: ECS rolled back. Run scripts/rollback.sh first, then deploy"
fi
ops_say "live: $live; HEAD: $tag"
# Settings first: a typo is refused before anything is built.
for kv in ${sets[@]+"${sets[@]}"}; do
  # Assigned first: a refusal inside "$(...)" as an argument would not stop it.
  value=$(ops_hcl_value "${kv#*=}")
  ops_tfvars_set "${kv%%=*}" "$value"
done

# 4. What changed.
images=0 infra=0 first=0
if ((all)); then
  images=1 infra=1
elif [[ "$live" != "$tag" ]]; then
  rc=0
  parts=$(ops_changed_components "$live" "$commit") || rc=$?
  if ((rc == 2)); then
    # A tag never pushed is the first apply's placeholder: nothing has run yet.
    if ops_image_exists "$OPS_REPO_BACKEND" "$live"; then
      ops_die "the live tag $live is not a commit in this checkout: git fetch, and check what is deployed"
    fi
    ops_say "the live tag $live was never pushed: treating this as the first deploy"
    images=1 infra=1 first=1
  else
    ! grep -qx images <<<"$parts" || images=1
    ! grep -qx infra <<<"$parts" || infra=1
  fi
fi
if ((images == 0 && infra == 0 && ${#sets[@]} == 0 && !reset)); then
  ops_say "nothing deployable changed since the live release $live (docs, tests, scripts): nothing to do (--all deploys anyway)"
  exit 0
fi
ops_say "deploying:$( ((images)) && printf ' images %s' "$tag")$( ((infra)) && printf ' infra')$( ((${#sets[@]})) && printf ' settings')"

# 5. Migrations: append-only.
if ((images && !first)) && [[ "$live" != "$tag" ]]; then
  rc=0
  changed=$(ops_migrations_changed "$live" "$commit") || rc=$?
  case $rc in
    0)
      printf '%s\n' "$changed" >&2
      ((reset)) || ops_die "these migrations were modified, renamed or deleted since the live release $live: migrations are append-only (sqlx refuses a changed one, and production is never reset). Add a new migration instead."
      ops_say "these migrations were modified since the live release $live: with --reset-database they are applied to an empty database" ;;
    2) ops_die "cannot compare migrations with the live tag $live (git fetch?)" ;;
  esac
  added=$(ops_migrations_added "$live" "$commit")
  [[ -z "$added" ]] || { ops_say "new migrations, applied as the backend starts:"; printf '%s\n' "$added" >&2; }
fi

if ((reset)); then
  ops_say "WARNING: --reset-database deletes every account and everything the app has stored, for good. The site is down from when the service stops until the new release is healthy"
  ops_confirm_typed reset "empty the production database"
fi

# 6. The images.
if ((images)); then
  missing=()
  while read -r repo t; do
    if ops_image_exists "$repo" "$t"; then
      ops_say "$repo:$t is already in ECR"
    else
      missing+=("$repo:$t")
    fi
  done < <(ops_release_images "$tag")
  if ((${#missing[@]})); then
    registry=${OPS_ECR_BACKEND%%/*}
    aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null \
      || ops_die "docker login to $registry failed"
    # Uncapped, a Rust build has frozen the machine.
    build=(docker build --pull --platform linux/amd64 --build-arg "CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-2}")
    for ref in "${missing[@]}"; do
      ops_say "building $ref"
      case $ref in
        "$OPS_REPO_BACKEND:$tag-ops")
          "${build[@]}" -f docker/backend.Dockerfile --target ops -t "$OPS_ECR_BACKEND:$tag-ops" . ;;
        "$OPS_REPO_BACKEND:$tag")
          "${build[@]}" -f docker/backend.Dockerfile --target backend -t "$OPS_ECR_BACKEND:$tag" . ;;
        "$OPS_REPO_FRONTEND:$tag")
          # APP_BUILD must never go backwards: MIN_APP_VERSION compares with it.
          "${build[@]}" --build-arg "APP_BUILD=$(git rev-list --count HEAD)" --build-arg "APP_COMMIT=$commit" \
            -f docker/frontend.Dockerfile -t "$OPS_ECR_FRONTEND:$tag" . ;;
      esac
    done
    for ref in "${missing[@]}"; do
      case $ref in
        "$OPS_REPO_FRONTEND":*) docker push "$OPS_ECR_FRONTEND:${ref#*:}" ;;
        *) docker push "$OPS_ECR_BACKEND:${ref#*:}" ;;
      esac
    done
    ops_say "pushed ${missing[*]}"
  fi
  ops_tfvars_set image_tag "\"$tag\""
fi

# --reset-database, in two applies. The first applies the new release at
# desired count 0, so the old release's deployment is gone with nothing
# running; then every task is waited on until it has stopped, draining
# included, and the schema is dropped and made again as the app role, which
# owns it. The second apply sets the desired count back, and only the new
# release can start. (One apply that both restored the count and changed the
# image let ECS start an old task to keep the service at its minimum healthy
# percent, and that task migrated the empty database with the old 0001.)
reset_wait_stopped() {
  local i arns left n
  for i in $(seq 61); do
    arns=$( { aws ecs list-tasks --cluster "$OPS_CLUSTER" --service-name "$OPS_SERVICE" --desired-status RUNNING --query taskArns --output text
              aws ecs list-tasks --cluster "$OPS_CLUSTER" --service-name "$OPS_SERVICE" --desired-status STOPPED --query taskArns --output text
            } | tr '\t' '\n' | grep -v -e '^None$' -e '^$') || arns=""
    left=0
    if [[ -n "$arns" ]]; then
      left=$(printf '%s\n' "$arns" | xargs -n 100 aws ecs describe-tasks --cluster "$OPS_CLUSTER" \
        --query 'tasks[?lastStatus!=`STOPPED`].taskArn' --output text --tasks | wc -w) || left="?"
    fi
    n=$(ops_describe_service | jq -r '.services[0].deployments | length') || n="?"
    [[ "$left" != 0 || "$n" != 1 ]] || return 0
    ((i < 61)) || ops_die "after 10 minutes the service still has ${left} tasks not stopped (${n} deployments): nothing was deleted. Run scripts/deploy.sh --reset-database again"
    ((i % 4 != 1)) || ops_say "waiting for every task to stop (${left} left, ${n} deployments)"
    sleep 10
  done
}

if ((reset)); then
  want=$(ops_tfvar desired_count)
  # A run that stopped after the first apply left 0 in the bucket's copy.
  [[ "$want" =~ ^[12]$ ]] || want=1
  ops_tfvars_set desired_count 0
  ops_say "first apply: the new release with no task running (desired count 0); the database is emptied after it"
  ops_show_tfvars_diff "the first apply"
  ops_ship
  reset_wait_stopped
  ops_say "every task has stopped: emptying the database"
  rc=0
  # shellcheck disable=SC2016
  ops_run_ops_script 'printf "%s" "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" | psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f -' || rc=$?
  # psql runs it as one transaction: a failed statement drops nothing. Exit 2
  # is ECS not knowing, so either may be true; emptying again is harmless.
  ((rc == 0)) || ops_die "the database was not emptied, or ECS cannot say (exit $rc). The service is stopped: run scripts/deploy.sh --reset-database again"
  ops_tfvars_set desired_count "$want"
  ops_say "second apply: the service started again at desired count $want, on the empty database. If it does not go through, run scripts/deploy.sh --reset-database again"
fi

# 7. Plan gate, apply, upload, and 8. the wait.
ops_show_tfvars_diff "this deploy"
ops_ship always
ops_say "deployed $(ops_tfvar image_tag)"
