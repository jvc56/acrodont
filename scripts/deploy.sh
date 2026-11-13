#!/usr/bin/env bash
# Deploy the checked-out commit of main to production. Terraform is the only
# deployer; this runs from the operator's laptop.
#
#   scripts/deploy.sh [--all] [--skip-ci-check] [--set KEY=VALUE]...
#
# In order, stopping at the first thing wrong:
#   1. the checkout: clean, HEAD on origin/main, CI's run on main green on this
#      exact commit (--skip-ci-check for an emergency); a red scheduled CI run
#      on main warns;
#   2. login, Terraform outputs, prod.tfvars from the state bucket;
#   3. what is live: the backend image tag of the service's PRIMARY deployment,
#      which must equal prod.tfvars' image_tag (else ECS rolled back: run
#      scripts/rollback.sh first);
#   4. what changed since the live tag: backend/, frontend/, docker/,
#      contract-fixtures/ and the ops scripts baked into images -> rebuild;
#      infra/ -> plan and apply; anything else -> nothing (--all deploys anyway);
#   5. migrations: anything but an added file under backend/migrations/ is
#      refused (append-only; production is never reset);
#   6. the three images ECR lacks are built (linux/amd64, capped jobs) and
#      pushed; tags are immutable, so one already there is this commit;
#   7. image_tag and any --set written to prod.tfvars; the plan gate; apply;
#      prod.tfvars uploaded;
#   8. the wait: one COMPLETED deployment running this tag with the cpu and
#      memory applied, healthy targets, and https://$SITE/health.
set -euo pipefail
# shellcheck source=scripts/lib/ops.sh
source "$(dirname "$0")/lib/ops.sh"

usage() { sed -n '5p' "$0" >&2; exit 2; }

all=0 skip_ci=0 sets=()
while (($#)); do
  case $1 in
    --all) all=1 ;;
    --skip-ci-check) skip_ci=1 ;;
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
nightly=$(gh run list --workflow ci.yml --branch main --event schedule --limit 1 \
  --json conclusion,url 2>/dev/null | jq -r '.[0] // empty | "\(.conclusion // "") \(.url)"' 2>/dev/null) || nightly=""
if [[ -n "$nightly" && "${nightly%% *}" != success && -n "${nightly%% *}" ]]; then
  ops_say "WARNING: the latest scheduled CI run on main is ${nightly%% *}: ${nightly#* }"
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
if ((images == 0 && infra == 0 && ${#sets[@]} == 0)); then
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
      ops_die "these migrations were modified, renamed or deleted since the live release $live: migrations are append-only (sqlx refuses a changed one, and production is never reset). Add a new migration instead." ;;
    2) ops_die "cannot compare migrations with the live tag $live (git fetch?)" ;;
  esac
  added=$(ops_migrations_added "$live" "$commit")
  [[ -z "$added" ]] || { ops_say "new migrations, applied as the backend starts:"; printf '%s\n' "$added" >&2; }
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

# 7. Plan gate, apply, upload, and 8. the wait.
ops_show_tfvars_diff "this deploy"
ops_ship always
ops_say "deployed $(ops_tfvar image_tag)"
