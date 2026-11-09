#!/usr/bin/env bash
# Change settings in prod.tfvars and apply them.
#
#   scripts/set-setting.sh KEY=VALUE... [--unset KEY]...
#   e.g. scripts/set-setting.sh mail_max_per_second=14 task_cpu=2048
#
# Fetches prod.tfvars from the state bucket, sets each KEY (a variable infra/
# declares; anything else is refused) to VALUE -- a number, true, false, null,
# a [list], a {map} or a "quoted string" as written, anything else as a string
# -- or removes it (back to the default), shows the change, runs the plan
# gate, applies, uploads prod.tfvars, and waits for the service if the plan
# touched it. image_tag belongs to deploy.sh and rollback.sh.
set -euo pipefail
# shellcheck source=scripts/lib/ops.sh
source "$(dirname "$0")/lib/ops.sh"

usage() { sed -n '4,5p' "$0" >&2; exit 2; }

sets=() unsets=()
while (($#)); do
  case $1 in
    --unset) [[ $# -ge 2 ]] || usage; unsets+=("$2"); shift ;;
    -*) usage ;;
    *=*) sets+=("$1") ;;
    *) usage ;;
  esac
  shift
done
((${#sets[@]} + ${#unsets[@]})) || usage
for kv in ${sets[@]+"${sets[@]}"} ${unsets[@]+"${unsets[@]}"}; do
  [[ "${kv%%=*}" != image_tag ]] || ops_die "image_tag is deploy.sh's and rollback.sh's to change"
done

ops_init
ops_need aws terraform jq curl
ops_load_env
ops_require STATE_BUCKET STATE_REGION SITE
ops_login
ops_stack
ops_tfvars_fetch

for kv in ${sets[@]+"${sets[@]}"}; do
  value=$(ops_hcl_value "${kv#*=}")
  ops_tfvars_set "${kv%%=*}" "$value"
done
for key in ${unsets[@]+"${unsets[@]}"}; do
  ops_tfvars_unset "$key"
done
if cmp -s "$OPS_TFVARS_BASE" "$OPS_TFVARS"; then
  ops_say "prod.tfvars already says that: nothing to do"
  exit 0
fi
ops_show_tfvars_diff
ops_ship if-ecs
ops_say "applied"
