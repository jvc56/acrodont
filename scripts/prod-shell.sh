#!/usr/bin/env bash
# An interactive shell in an ops task inside the VPC: psql and pg_restore 16,
# python3 and boto3, DATABASE_URL, BACKUP_DATABASE_URL, acrodont-master-psql.
#
#   scripts/prod-shell.sh [--attach TASK_ARN]
#
# The task stops itself after SHELL_HOURS (default 4). Leaving the shell does
# not stop it: an ECS Exec session ends after 20 idle minutes or when a laptop
# sleeps, and stopping the task then would kill a long restore. Run long work
# under `setsid nohup ... > /tmp/x.log 2>&1 &`, and come back with --attach.
# Exec sessions are not logged (the cluster's exec logging is NONE).
set -euo pipefail
# shellcheck source=scripts/lib/ops.sh
source "$(dirname "$0")/lib/ops.sh"

usage() { sed -n '5p' "$0" >&2; exit 2; }

attach_to=""
case ${1:-} in
  "") ;;
  --attach) [[ -n "${2:-}" && $# == 2 ]] || usage; attach_to=$2 ;;
  *) usage ;;
esac

ops_init
ops_need aws terraform jq session-manager-plugin
ops_load_env
ops_login
ops_stack

attach() {
  aws ecs execute-command --cluster "$OPS_CLUSTER" --task "$1" --container ops \
    --interactive --command /bin/bash || true
  printf '\n' >&2
  ops_say "the task runs on until it stops itself (SHELL_HOURS). To come back:"
  ops_say "  scripts/prod-shell.sh --attach $1"
  ops_say "to stop it:  aws ecs stop-task --cluster $OPS_CLUSTER --task $1"
}

if [[ -n "$attach_to" ]]; then
  attach "$attach_to"
  exit 0
fi

hours=${SHELL_HOURS:-4}
[[ "$hours" =~ ^[1-9][0-9]?$ ]] || ops_die "SHELL_HOURS must be a whole number of hours (1-99)"
overrides=$(jq -cn --arg s "sleep $((hours * 3600))" \
  '{containerOverrides: [{name: "ops", command: ["bash", "-c", $s]}]}')
task_arn=$(ops_run_task "$overrides" --enable-execute-command)
# Stopped if this fails before the shell opens: a task nobody can get into
# should not sit holding DATABASE_URL for hours.
trap 'rm -rf "$OPS_TMP"; aws ecs stop-task --cluster "$OPS_CLUSTER" --task "$task_arn" >/dev/null 2>&1 || true' EXIT
ops_say "starting $task_arn"
ready=""
for _ in $(seq 120); do
  js=$(ops_describe_task "$task_arn" 2>/dev/null) || js='{}'
  status=$(jq -r '.tasks[0].lastStatus // ""' <<<"$js")
  agent=$(jq -r '[.tasks[0].containers[]? | select(.name == "ops") | .managedAgents[]?
                  | select(.name == "ExecuteCommandAgent") | .lastStatus][0] // ""' <<<"$js")
  [[ "$status" != STOPPED ]] || ops_die "the task stopped: $(jq -r '.tasks[0].stoppedReason // ""' <<<"$js")"
  if [[ "$status" == RUNNING && "$agent" == RUNNING ]]; then ready=1; break; fi
  sleep 5
done
[[ -n "$ready" ]] || ops_die "the task or its ECS Exec agent did not start within ten minutes"
trap 'rm -rf "$OPS_TMP"' EXIT
attach "$task_arn"
