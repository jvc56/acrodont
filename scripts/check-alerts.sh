#!/usr/bin/env bash
# Check that the alarms reach someone: after the first apply (once the SNS
# email subscription is confirmed) and after any change to the alarms.
#
#   scripts/check-alerts.sh
#
#   1. the alarm topic has a confirmed subscription (not PendingConfirmation);
#   2. wordfall-no-dump-36h is forced to ALARM and back to OK: an ALARM mail
#      should arrive (it returns to its real state at its next evaluation);
#   3. the EventBridge rules wordfall-deploy-failed, wordfall-backup-failed and
#      wordfall-drill-failed match a sample failure and not a sample success
#      (aws events test-event-pattern: nothing is sent);
#   4. the RDS event subscription wordfall-db-events is active.
# Checking the inbox is yours.
set -euo pipefail
# shellcheck source=scripts/lib/ops.sh
source "$(dirname "$0")/lib/ops.sh"

[[ $# == 0 ]] || { sed -n '5p' "$0" >&2; exit 2; }

ops_init
ops_need aws terraform jq
ops_load_env
ops_login
ops_stack
failed=0
fail() { ops_say "FAILED: $*"; failed=1; }

# 1. The subscription.
topic=$(ops_out -raw alarm_topic_arn)
subs=$(aws sns list-subscriptions-by-topic --topic-arn "$topic" --output json) || subs='{}'
confirmed=$(jq '[.Subscriptions[]? | select(.SubscriptionArn | startswith("arn:"))] | length' <<<"$subs")
pending=$(jq -r '.Subscriptions[]? | select(.SubscriptionArn == "PendingConfirmation") | .Endpoint' <<<"$subs")
if ((confirmed > 0)); then
  ops_say "$topic has $confirmed confirmed subscription(s)"
else
  fail "$topic has no confirmed subscription: alarms go nowhere"
fi
[[ -z "$pending" ]] || ops_say "WARNING: not confirmed yet (click the link in the mail): $(paste -sd' ' <<<"$pending")"

# 2. A real mail. Setting the state an alarm is already in sends nothing, so
# an alarm already in ALARM goes to OK first.
alarm=wordfall-no-dump-36h
reason="testing the alert path (scripts/check-alerts.sh)"
state=$(aws cloudwatch describe-alarms --alarm-names "$alarm" --query 'MetricAlarms[0].StateValue' --output text) || state=""
if [[ -z "$state" || "$state" == None ]]; then
  fail "no alarm $alarm"
else
  if [[ "$state" == ALARM ]]; then
    aws cloudwatch set-alarm-state --alarm-name "$alarm" --state-value OK --state-reason "$reason"
  fi
  aws cloudwatch set-alarm-state --alarm-name "$alarm" --state-value ALARM --state-reason "$reason"
  sleep 5
  aws cloudwatch set-alarm-state --alarm-name "$alarm" --state-value OK --state-reason "$reason"
  ops_say "$alarm set to ALARM and back to OK: an ALARM mail should arrive"
fi

# 3. The EventBridge patterns, against events shaped like ECS's own.
ecs_arn="arn:aws:ecs:$OPS_REGION:$OPS_ACCOUNT"
event() {  # detail-type, resource ARN, detail JSON
  jq -cn --arg t "$1" --arg res "$2" --argjson d "$3" --arg r "$OPS_REGION" --arg a "$OPS_ACCOUNT" '{
    version: "0", id: "00000000-0000-0000-0000-000000000000", account: $a, source: "aws.ecs",
    time: "2026-01-01T00:00:00Z", region: $r, "detail-type": $t, resources: [$res], detail: $d}'
}
deploy_event() {  # eventName
  event "ECS Deployment State Change" "$ecs_arn:service/$OPS_CLUSTER/$OPS_SERVICE" \
    "$(jq -cn --arg n "$1" '{eventType: (if $n == "SERVICE_DEPLOYMENT_FAILED" then "ERROR" else "INFO" end),
      eventName: $n, deploymentId: "ecs-svc/0000000000000000000", reason: "scripts/check-alerts.sh"}')"
}
task_event() {  # family, exit code
  local task="$ecs_arn:task/$OPS_CLUSTER/0123456789abcdef0123456789abcdef"
  event "ECS Task State Change" "$task" "$(jq -cn --arg f "$1" --argjson code "$2" --arg task "$task" \
    --arg cluster "$ecs_arn:cluster/$OPS_CLUSTER" --arg td "$ecs_arn:task-definition/$1:1" \
    '{clusterArn: $cluster, taskArn: $task, taskDefinitionArn: $td, group: "family:\($f)",
      launchType: "FARGATE", lastStatus: "STOPPED", desiredStatus: "STOPPED",
      stopCode: "EssentialContainerExited", stoppedReason: "Essential container in task exited",
      containers: [{name: ($f | sub("^wordfall-"; "")), lastStatus: "STOPPED", exitCode: $code}]}')"
}
check_rule() {  # rule, expected True|False, event, description
  local pattern match
  pattern=$(aws events describe-rule --name "$1" --query EventPattern --output text 2>/dev/null) || pattern=""
  if [[ -z "$pattern" || "$pattern" == None ]]; then
    fail "no EventBridge rule $1"
    return 0
  fi
  match=$(aws events test-event-pattern --event-pattern "$pattern" --event "$3" --query Result --output text) || match=""
  case $match in True | true) match=True ;; False | false) match=False ;; esac
  if [[ "$match" == "$2" ]]; then
    ops_say "$1: $4 -> $match, as it should"
  else
    fail "$1: $4 -> ${match:-error}, expected $2"
  fi
}
check_rule wordfall-deploy-failed True "$(deploy_event SERVICE_DEPLOYMENT_FAILED)" "a failed deployment"
check_rule wordfall-deploy-failed False "$(deploy_event SERVICE_DEPLOYMENT_COMPLETED)" "a completed deployment"
check_rule wordfall-backup-failed True "$(task_event wordfall-backup 1)" "a backup task exiting 1"
check_rule wordfall-backup-failed False "$(task_event wordfall-backup 0)" "a backup task exiting 0"
check_rule wordfall-backup-failed False "$(task_event wordfall-drill 1)" "a drill task exiting 1"
check_rule wordfall-drill-failed True "$(task_event wordfall-drill 1)" "a drill task exiting 1"
check_rule wordfall-drill-failed False "$(task_event wordfall-drill 0)" "a drill task exiting 0"
check_rule wordfall-drill-failed False "$(task_event wordfall-backup 1)" "a backup task exiting 1"

# 4. RDS events.
status=$(aws rds describe-event-subscriptions --subscription-name wordfall-db-events \
  --query 'EventSubscriptionsList[0].Status' --output text 2>/dev/null) || status=""
if [[ "$status" == active ]]; then
  ops_say "the RDS event subscription wordfall-db-events is active"
else
  fail "the RDS event subscription wordfall-db-events is '${status:-missing}', not active"
fi

((failed == 0)) || ops_die "some checks failed (above)"
ops_say "done. Check alarm_email's inbox for the $alarm ALARM mail; if it is missing, find out why now."
