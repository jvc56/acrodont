#!/usr/bin/env bash
# Run SQL against the production database, from an ops task inside the VPC.
#
#   scripts/prod-sql.sh [--as-master] "SQL"
#   scripts/prod-sql.sh [--as-master] < fix.sql
#
# NEVER select personal columns (email, password_hash, tokens) and NEVER put a
# secret in the SQL: it travels as an environment override that AWS keeps in
# the task's record, and what psql prints stays in CloudWatch Logs.
#
# One batch, psql -X -v ON_ERROR_STOP=1 --single-transaction: anything that
# fails rolls the whole batch back. As the app role (DATABASE_URL), or with
# --as-master as the RDS master user (acrodont-master-psql), for role and
# grant changes. The task is polled with no time limit, its log printed, and
# this exits with the container's exit code (psql: 3 for a failed statement).
# For anything interactive, scripts/prod-shell.sh.
set -euo pipefail
# shellcheck source=scripts/lib/ops.sh
source "$(dirname "$0")/lib/ops.sh"

usage() { sed -n '4,5p' "$0" >&2; exit 2; }

master=0
case ${1:-} in
  --as-master) master=1; shift ;;
  -h | --help) usage ;;
esac
(($# <= 1)) || usage
if (($#)); then
  sql=$1
else
  [[ ! -t 0 ]] || usage
  # Byte for byte, trailing newlines too.
  sql=$(cat; printf x)
  sql=${sql%x}
fi
[[ -n "$sql" ]] || usage
# ECS caps all overrides together at 8 KB.
bytes=$(printf '%s' "$sql" | wc -c)
((bytes <= 7168)) || ops_die "the SQL is $bytes bytes; overrides are capped near 8 KB, so at most 7 KB here: split it, or use scripts/prod-shell.sh"

ops_init
ops_need aws terraform jq
ops_load_env
ops_login
ops_stack

if ((master)); then
  # shellcheck disable=SC2016
  script='printf "%s" "$ACRODONT_SQL" | acrodont-master-psql -X -v ON_ERROR_STOP=1 --single-transaction -f -'
else
  # shellcheck disable=SC2016
  script='printf "%s" "$ACRODONT_SQL" | psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f -'
fi
env=$(jq -cn --arg sql "$sql" '[{name: "ACRODONT_SQL", value: $sql}]')
rc=0
ops_run_ops_script "$script" "$env" || rc=$?
exit "$rc"
