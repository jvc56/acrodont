#!/usr/bin/env bash
# Put an earlier release back.
#
#   scripts/rollback.sh [--to TAG]
#
# The default target: if ECS's circuit breaker already rolled back (the
# service runs another tag than prod.tfvars names), what ECS runs -- this then
# makes Terraform agree, so the next apply does not redeploy the broken one.
# Otherwise the previous backend tag in ECR (by push time), chosen from a
# numbered list.
#
# Nothing is built: all three images must already be in ECR. A target whose
# migrations were modified, renamed or deleted on the way to the live release
# is refused; one that merely lacks migrations added since is allowed after a
# warning (the backend runs its migrator with ignore_missing, and additive
# migrations keep older code working). Then the plan gate, apply, upload and
# rollout wait, as deploy.sh. The apply uses this checkout's infra/.
set -euo pipefail
# shellcheck source=scripts/lib/ops.sh
source "$(dirname "$0")/lib/ops.sh"

usage() { sed -n '4p' "$0" >&2; exit 2; }

target=""
while (($#)); do
  case $1 in
    --to) [[ $# -ge 2 ]] || usage; target=$2; shift ;;
    --to=*) target=${1#--to=} ;;
    *) usage ;;
  esac
  shift
done

ops_init
ops_need git aws terraform jq curl
cd "$OPS_ROOT"
[[ -z "$(git status --porcelain --untracked-files=no -- infra)" ]] \
  || ops_die "uncommitted changes in infra/: the rollback would apply them too"
ops_load_env
ops_require STATE_BUCKET STATE_REGION SITE
ops_login
ops_stack
ops_ecr
ops_tfvars_fetch

state_tag=$(ops_tfvar image_tag)
live=$(ops_live_tag) || ops_die "cannot read what the service $OPS_SERVICE runs"
default=""
if [[ "$live" != "$state_tag" ]]; then
  ops_say "ECS runs $live, but prod.tfvars (and Terraform) name $state_tag: the circuit breaker rolled back. Recent events:"
  ops_show_events
  default=$live
fi

if [[ -z "$target" ]]; then
  if [[ -n "$default" ]]; then
    printf 'Roll back to %s (what ECS runs)? Enter to accept, or type another tag: ' "$default" >&2
    ops_read target || target=""
    [[ -z "${OPS_TTY:-}" ]] || printf '%s\n' "$target" >&2
    target=${target:-$default}
  else
    # Backend tags newest first, -ops images left out; those pushed after the
    # live one were never live, so the list starts below it.
    listing=$(aws ecr describe-images --repository-name "$OPS_REPO_BACKEND" --output json) \
      || ops_die "could not list $OPS_REPO_BACKEND"
    tags=$(jq -r '[.imageDetails[] | . as $d | ($d.imageTags // [])[]
                   | select(endswith("-ops") | not) | {tag: ., at: $d.imagePushedAt}]
                  | sort_by(.at) | reverse | .[] | "\(.tag) \(.at)"' <<<"$listing")
    if grep -q "^$state_tag " <<<"$tags"; then
      tags=$(awk -v s="$state_tag" 'found { print } $1 == s { found = 1 }' <<<"$tags")
    fi
    [[ -n "$tags" ]] || ops_die "no earlier backend image in $OPS_REPO_BACKEND: give one with --to TAG"
    ops_say "live: $state_tag. Earlier releases in ECR, newest first:"
    n=0 choices=()
    while read -r t at; do
      n=$((n + 1))
      ((n <= 10)) || break
      choices+=("$t")
      subject=$(git log -1 --format=%s "$t" -- 2>/dev/null) || subject="(not a commit in this checkout)"
      printf '  %2d) %s  %s  %s\n' "$n" "$t" "$at" "$subject" >&2
    done <<<"$tags"
    printf 'Roll back to which? [1] ' >&2
    answer=""
    ops_read answer || answer=""
    [[ -z "${OPS_TTY:-}" ]] || printf '%s\n' "$answer" >&2
    answer=${answer:-1}
    [[ "$answer" =~ ^[0-9]+$ && "$answer" -ge 1 && "$answer" -le ${#choices[@]} ]] \
      || ops_die "not a choice: $answer"
    target=${choices[$((answer - 1))]}
  fi
fi
[[ "$target" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || ops_die "not an image tag: $target"
[[ "$target" != "$state_tag" ]] || ops_die "$target is already what prod.tfvars names"
ops_say "rolling back to $target"

while read -r repo t; do
  ops_image_exists "$repo" "$t" || ops_die "$repo:$t is not in ECR: nothing is built here"
done < <(ops_release_images "$target")

# The schema: whatever the newest release that ran left behind, which may be
# the one ECS abandoned (its migrations ran before it failed).
for from in $(printf '%s\n' "$state_tag" "$live" | sort -u); do
  [[ "$from" != "$target" ]] || continue
  rc=0
  changed=$(ops_migrations_changed "$target" "$from") || rc=$?
  case $rc in
    0)
      printf '%s\n' "$changed" >&2
      ops_die "these migrations differ between $target and $from beyond additions: $target's backend would refuse this database (sqlx checksums applied migrations)" ;;
    2) ops_die "$target or $from is not a commit in this checkout (git fetch), so the migrations cannot be compared" ;;
  esac
  added=$(ops_migrations_added "$target" "$from")
  if [[ -n "$added" ]]; then
    ops_say "$from added migrations that $target lacks:"
    printf '%s\n' "$added" >&2
    ops_say "$target's backend will run on this newer, additive schema (its migrator ignores migrations it does not know). Code that depends on them stops; the tables stay."
    ops_confirm "Roll back over them?" || ops_die "stopped: nothing changed"
  fi
done

ops_tfvars_set image_tag "\"$target\""
ops_show_tfvars_diff "rollback"
ops_ship always
ops_say "rolled back to $target"
