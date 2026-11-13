#!/usr/bin/env bash
#
# The operator scripts against stand-ins for aws, terraform, gh, docker, curl
# and session-manager-plugin (scripts/lib/ops_fakes.py), in a throwaway git
# repository with a bare origin: nothing here reaches AWS, GitHub or Docker.
#
#   scripts/ops-scripts-check.sh
#
# Each case prints "ok: ..." or stops at the first "FAIL: ...", with the
# script's output.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/acrodont-ops-check.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
fail() { echo "FAIL: $*" >&2; [[ -s "$WORK/out" ]] && sed 's/^/  | /' "$WORK/out" >&2; exit 1; }
pass() { echo "ok: $*"; }

# ---------------------------------------------------------------------------
# Every script parses.
# ---------------------------------------------------------------------------
for s in "$ROOT"/scripts/*.sh "$ROOT"/scripts/lib/ops.sh; do
  bash -n "$s" || fail "$s does not parse"
done
python3 -c 'import ast, sys; ast.parse(open(sys.argv[1]).read())' "$ROOT/scripts/lib/ops_fakes.py" \
  || fail "ops_fakes.py does not parse"
pass "every script parses (bash -n), and ops_fakes.py"

# ---------------------------------------------------------------------------
# The stand-ins, the settings, and a repository with history.
# ---------------------------------------------------------------------------
unset AWS_PROFILE SITE STATE_BUCKET STATE_REGION ACCOUNT INFRA_DIR ACRODONT_ALLOW_DESTRUCTIVE_PLAN \
  AWS_REGION AWS_DEFAULT_REGION SHELL_HOURS CARGO_BUILD_JOBS
export REAL_PATH=$PATH
export FAKE_DIR="$WORK/fake"
mkdir -p "$WORK/bin" "$FAKE_DIR" "$WORK/home"
for t in aws terraform gh docker curl session-manager-plugin; do
  ln -s "$ROOT/scripts/lib/ops_fakes.py" "$WORK/bin/$t"
done
printf '#!/bin/sh\nexit 0\n' > "$WORK/bin/sleep"
chmod +x "$WORK/bin/sleep"
export PATH="$WORK/bin:$PATH"
export HOME="$WORK/home"
export ACRODONT_ENV="$WORK/home/.acrodont-env"
export OPS_TTY="$WORK/answers"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.org GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.org
REGISTRY=123456789012.dkr.ecr.us-east-1.amazonaws.com
write_env() {
  cat > "$ACRODONT_ENV" <<'EOF'
export AWS_PROFILE=acrodont
export SITE=acrodont.test
export STATE_BUCKET=state-bucket
export STATE_REGION=us-east-2
export ACCOUNT=123456789012
EOF
}
write_env

R="$WORK/repo"
git -c init.defaultBranch=main init -q --bare "$WORK/origin.git"
git -c init.defaultBranch=main init -q "$R"
mkdir -p "$R/scripts/lib" "$R/infra" "$R/docker" "$R/backend/migrations" "$R/backend/src" "$R/frontend"
cp "$ROOT"/scripts/*.sh "$R/scripts/"
cp "$ROOT"/scripts/lib/ops.sh "$R/scripts/lib/"
for v in image_tag desired_count task_cpu task_memory domain_name alarm_email mail_max_per_second \
         use_fargate_spot monthly_budget_usd; do
  printf 'variable "%s" {}\n\n' "$v"
done > "$R/infra/variables.tf"
printf 'CREATE TABLE users (id int);\n' > "$R/backend/migrations/0001_initial.sql"
printf 'fn main() {}\n' > "$R/backend/src/main.rs"
printf '<p>acrodont</p>\n' > "$R/frontend/index.html"
printf 'FROM scratch AS backend\nFROM scratch AS ops\n' > "$R/docker/backend.Dockerfile"
printf 'FROM scratch\n' > "$R/docker/frontend.Dockerfile"
printf 'readme\n' > "$R/README.md"
printf 'infra/prod.tfvars*\n' > "$R/.gitignore"
git -C "$R" add -A && git -C "$R" commit -q -m A
A=$(git -C "$R" rev-parse --short=12 HEAD)
# B: backend code and an added migration. C: docs only. D: infra only.
# E: an applied migration edited (refused).
printf 'fn main() { println!("b"); }\n' > "$R/backend/src/main.rs"
printf 'ALTER TABLE users ADD COLUMN games bigint;\n' > "$R/backend/migrations/0002_games.sql"
git -C "$R" add -A && git -C "$R" commit -q -m "B: backend and 0002"
B=$(git -C "$R" rev-parse --short=12 HEAD)
printf 'more readme\n' >> "$R/README.md"
git -C "$R" commit -q -am "C: docs"
C=$(git -C "$R" rev-parse --short=12 HEAD)
printf '# more\n' > "$R/infra/extra.tf"
git -C "$R" add -A && git -C "$R" commit -q -m "D: infra"
D=$(git -C "$R" rev-parse --short=12 HEAD)
printf 'CREATE TABLE users (id int, name text);\n' > "$R/backend/migrations/0001_initial.sql"
git -C "$R" commit -q -am "E: edits 0001"
E=$(git -C "$R" rev-parse --short=12 HEAD)
git -C "$R" remote add origin "$WORK/origin.git"
git -C "$R" push -q origin HEAD:refs/heads/main

PLAN_NORMAL='{"resource_changes": [
  {"address": "aws_ecs_task_definition.app", "type": "aws_ecs_task_definition", "change": {"actions": ["delete", "create"]}},
  {"address": "aws_ecs_service.app", "type": "aws_ecs_service", "change": {"actions": ["update"]}},
  {"address": "aws_db_instance.main", "type": "aws_db_instance", "change": {"actions": ["no-op"]}}]}'
PLAN_DB_REPLACE='{"resource_changes": [
  {"address": "aws_db_instance.main", "type": "aws_db_instance", "change": {"actions": ["delete", "create"]}}]}'
PLAN_LB_REPLACE='{"resource_changes": [
  {"address": "aws_lb.main", "type": "aws_lb", "change": {"actions": ["delete", "create"]}},
  {"address": "aws_lb_listener.https", "type": "aws_lb_listener", "change": {"actions": ["delete", "create"]}}]}'
PLAN_SNS_ONLY='{"resource_changes": [
  {"address": "aws_sns_topic.alarms", "type": "aws_sns_topic", "change": {"actions": ["update"]}}]}'
S3_TFVARS="$FAKE_DIR/s3/state-bucket/acrodont/prod.tfvars"
APP_URL='postgres://acrodont_app:oldpw@acrodont.abc.us-east-1.rds.amazonaws.com:5432/acrodont?sslmode=require'
BACKUP_URL='postgres://acrodont_backup:oldbk@acrodont.abc.us-east-1.rds.amazonaws.com:5432/acrodont?sslmode=require'

tfvars_with() {  # image tag
  cat <<EOF
image_tag     = "$1"
domain_name   = "acrodont.test"
alarm_email   = "ops@example.org"
desired_count = 1
EOF
}
ssm_put() { mkdir -p "$FAKE_DIR/ssm"; printf '%s' "$2" > "$FAKE_DIR/ssm/acrodont_production_$1"; }
ssm_get() { cat "$FAKE_DIR/ssm/acrodont_production_$1"; }
# A fresh world: prod.tfvars naming LIVE, the service running LIVE, ECR
# holding all three images of each further tag (pushed in that order), the
# database parameters in SSM, no local prod.tfvars, no calls yet.
fresh() {
  local live=$1 t i=0
  shift
  rm -rf "$FAKE_DIR" "$R"/infra/prod.tfvars* "$WORK/answers" "$WORK/out"
  mkdir -p "$FAKE_DIR/ecs" "$(dirname "$S3_TFVARS")"
  tfvars_with "$live" > "$S3_TFVARS"
  for t in "$@"; do
    i=$((i + 1))
    for r in "acrodont-backend/$t" "acrodont-backend/$t-ops" "acrodont-frontend/$t"; do
      mkdir -p "$FAKE_DIR/ecr/${r%/*}"
      printf '2026-10-%02dT00:00:00+00:00' "$i" > "$FAKE_DIR/ecr/$r"
    done
  done
  printf '{"tag": "%s", "cpu": "1024", "memory": "2048"}' "$live" > "$FAKE_DIR/ecs/running.json"
  echo 1 > "$FAKE_DIR/ecs/desired"
  printf '%s' "$PLAN_NORMAL" > "$FAKE_DIR/plan.json"
  ssm_put DATABASE_URL "$APP_URL"
  ssm_put BACKUP_DATABASE_URL "$BACKUP_URL"
  : > "$FAKE_DIR/calls.log"
  : > "$WORK/answers"
}
answers() { printf '%s\n' "$@" > "$WORK/answers"; }
run() { local rc=0; "$R/scripts/$1" "${@:2}" > "$WORK/out" 2>&1 < /dev/null || rc=$?; return "$rc"; }
called() { grep -qF -- "$1" "$FAKE_DIR/calls.log"; }
said() { grep -qF -- "$1" "$WORK/out"; }
# The calls matching each pattern happened in this order, each after the last.
in_order() {
  local last=0 n p
  for p in "$@"; do
    n=$(awk -v start="$last" -v pat="$p" 'NR > start && index($0, pat) { print NR; exit }' "$FAKE_DIR/calls.log")
    [[ -n "$n" ]] || fail "no call matching (after call $last): $p"
    last=$n
  done
}
s3_tag() { sed -n 's/^image_tag *= *"\(.*\)"$/\1/p' "$S3_TFVARS"; }
running_field() { jq -r ".$1" "$FAKE_DIR/ecs/running.json"; }
TF="terraform -chdir=$R/infra"

# ---------------------------------------------------------------------------
# What a path reaches.
# ---------------------------------------------------------------------------
mapping=$(printf '%s\n' backend/src/main.rs backend/migrations/0002_x.sql frontend/src/app.ts docker/nginx.conf.template \
    contract-fixtures/a.json scripts/backup.py scripts/restore.py scripts/ops_master_psql.py scripts/drill.py \
    infra/ecs.tf scripts/deploy.sh scripts/dev.py docs/runbook.md README.md e2e/x.spec.ts \
  | while read -r p; do printf '%s [%s]\n' "$p" "$(printf '%s\n' "$p" | (source "$ROOT/scripts/lib/ops.sh"; ops_path_components))"; done)
[[ "$mapping" == "backend/src/main.rs [images]
backend/migrations/0002_x.sql [images]
frontend/src/app.ts [images]
docker/nginx.conf.template [images]
contract-fixtures/a.json [images]
scripts/backup.py [images]
scripts/restore.py [images]
scripts/ops_master_psql.py [images]
scripts/drill.py [images]
infra/ecs.tf [infra]
scripts/deploy.sh []
scripts/dev.py []
docs/runbook.md []
README.md []
e2e/x.spec.ts []" ]] || fail "a path reaches the wrong thing:
$mapping"
pass "path mapping: app paths rebuild images, infra/ plans, the rest deploys nothing"

# ---------------------------------------------------------------------------
# deploy.sh
# ---------------------------------------------------------------------------
git -C "$R" checkout -q "$B"
fresh "$A" "$A"
# The ops image is already there: only the other two are built.
mkdir -p "$FAKE_DIR/ecr/acrodont-backend" && printf '2026-10-05T00:00:00+00:00' > "$FAKE_DIR/ecr/acrodont-backend/$B-ops"
answers y
run deploy.sh || fail "deploy.sh failed on the happy path"
in_order "aws ecr describe-images --repository-name acrodont-backend --image-ids imageTag=$B" \
         "docker build" "docker push" \
         "$TF plan -input=false -detailed-exitcode -var-file=prod.tfvars -out=" \
         "$TF show -json" \
         "$TF apply -input=false" \
         "aws s3 cp $R/infra/prod.tfvars s3://state-bucket/acrodont/prod.tfvars" \
         "aws ecs describe-services --cluster acrodont --services acrodont" \
         "aws ecs describe-task-definition" \
         "aws elbv2 wait target-in-service --target-group-arn arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/acrodont/abc" \
         "curl -fsS --max-time 20 https://acrodont.test/health"
called "docker build --pull --platform linux/amd64 --build-arg CARGO_BUILD_JOBS=2 -f docker/backend.Dockerfile --target backend -t $REGISTRY/acrodont-backend:$B ." \
  || fail "the backend image was not built as specified"
called "docker build --pull --platform linux/amd64 --build-arg CARGO_BUILD_JOBS=2 --build-arg APP_BUILD=$(git -C "$R" rev-list --count HEAD) --build-arg APP_COMMIT=$(git -C "$R" rev-parse HEAD) -f docker/frontend.Dockerfile -t $REGISTRY/acrodont-frontend:$B ." \
  || fail "the frontend image was not built with APP_BUILD and APP_COMMIT"
! called "--target ops" || fail "the ops image ECR already held was built again"
{ called "docker push $REGISTRY/acrodont-backend:$B" && called "docker push $REGISTRY/acrodont-frontend:$B" \
  && ! called "docker push $REGISTRY/acrodont-backend:$B-ops"; } || fail "the wrong images were pushed"
[[ "$(s3_tag)" == "$B" ]] || fail "the uploaded prod.tfvars does not name $B"
[[ "$(running_field tag)" == "$B" ]] || fail "the service does not run $B"
said "0002_games.sql" || fail "the added migration was not mentioned"
pass "deploy.sh: missing images built and pushed, then plan, show, apply, upload, rollout check, targets, /health"

# An image ECR lacks entirely: the first deploy, from the first apply's placeholder.
fresh bootstrap
printf '{"tag": "bootstrap", "cpu": "1024", "memory": "2048"}' > "$FAKE_DIR/ecs/running.json"
answers y
run deploy.sh || fail "deploy.sh failed on the first deploy"
said "first deploy" || fail "the first deploy was not recognised"
for r in "acrodont-backend:$B" "acrodont-backend:$B-ops" "acrodont-frontend:$B"; do
  called "docker push $REGISTRY/$r" || fail "the first deploy did not push $r"
done
pass "deploy.sh: the first deploy (a placeholder tag never pushed) builds everything"

git -C "$R" checkout -q "$C"
fresh "$B" "$B"
run deploy.sh || fail "deploy.sh failed with nothing to deploy"
said "nothing deployable changed" || fail "a docs-only commit was not said to deploy nothing"
{ ! called "docker" && ! called "$TF plan"; } || fail "a docs-only commit built or planned"
fresh "$B" "$B"
answers y
run deploy.sh --all || fail "deploy.sh --all failed"
for r in "acrodont-backend:$C" "acrodont-backend:$C-ops" "acrodont-frontend:$C"; do
  called "docker push $REGISTRY/$r" || fail "--all did not push $r"
done
[[ "$(s3_tag)" == "$C" ]] || fail "--all did not set image_tag"
pass "deploy.sh: a docs-only commit does nothing; --all builds and deploys anyway"

git -C "$R" checkout -q "$D"
fresh "$B" "$B"
answers y
run deploy.sh || fail "deploy.sh failed for an infra change"
! called "docker" || fail "an infra change built an image"
in_order "$TF plan" "$TF apply" "aws elbv2 wait"
[[ "$(s3_tag)" == "$B" ]] || fail "an infra change moved image_tag"
pass "deploy.sh: an infra change plans and applies, and keeps image_tag"

git -C "$R" checkout -q "$E"
fresh "$B" "$B"
answers y
if run deploy.sh; then fail "deploy.sh deployed an edited migration"; fi
said "0001_initial.sql" || fail "the refusal does not name 0001_initial.sql"
said "append-only" || fail "the refusal does not say why"
{ ! called "docker" && ! called "$TF plan" && ! called "ecr describe-images"; } || fail "deploy.sh built or planned before refusing"
pass "deploy.sh refuses a modified migration before any build or plan"

git -C "$R" checkout -q "$B"
fresh "$A" "$A" "$B"
printf '%s' "$PLAN_DB_REPLACE" > "$FAKE_DIR/plan.json"
answers y y
if run deploy.sh; then fail "a plan replacing the database was applied"; fi
{ said "refused" && said "aws_db_instance.main: delete then create"; } || fail "the gate does not say what it refused"
! called "$TF apply" || fail "the gate let an apply through"
cmp -s <(tfvars_with "$A") "$S3_TFVARS" || fail "a refused plan still uploaded prod.tfvars"
fresh "$A" "$A" "$B"
printf '%s' "$PLAN_DB_REPLACE" > "$FAKE_DIR/plan.json"
answers destroy y
ACRODONT_ALLOW_DESTRUCTIVE_PLAN=yes run deploy.sh || fail "the gate refused a plan it was told to let through"
called "$TF apply" || fail "the allowed plan was not applied"
fresh "$A" "$A" "$B"
printf '%s' "$PLAN_DB_REPLACE" > "$FAKE_DIR/plan.json"
answers nope y
if ACRODONT_ALLOW_DESTRUCTIVE_PLAN=yes run deploy.sh; then fail "a mistyped confirmation applied a destructive plan"; fi
! called "$TF apply" || fail "a mistyped confirmation applied"
fresh "$A" "$A" "$B"
printf '%s' "$PLAN_LB_REPLACE" > "$FAKE_DIR/plan.json"
answers y
if run deploy.sh; then fail "deploy.sh applied a plan that replaces the load balancer"; fi
said "aws_lb.main: delete then create" || fail "the load balancer's replacement is not named"
! called "$TF apply" || fail "a refused plan was applied"
pass "the plan gate refuses a database replacement (nothing applied); passes it only when allowed and typed; a load balancer's replacement too"

fresh "$A" "$A" "$B"
printf '{"tag": "0123456789ab", "cpu": "1024", "memory": "2048"}' > "$FAKE_DIR/ecs/running.json"
if run deploy.sh; then fail "deploy.sh deployed over an ECS rollback"; fi
said "scripts/rollback.sh first" || fail "the refusal does not send to rollback.sh"
{ ! called "docker" && ! called "$TF plan"; } || fail "deploy.sh built or planned before refusing"
fresh "$A" "$A" "$B"
answers y
if FAKE_ROLLBACK=1 run deploy.sh; then fail "a release ECS rolled back counted as deployed"; fi
said "ECS rolled the release back" || fail "the rollback during the deploy is not reported"
! called "curl" || fail "the site was checked after a rollback"
fresh "$A" "$A" "$B"
printf '{"tag": "%s", "cpu": "1024", "memory": "2048"}' "$B" > "$FAKE_DIR/ecs/running.json"
answers y
run deploy.sh || fail "deploy.sh did not finish a release whose apply had stopped part-way"
said "stopped part-way" || fail "the part-way apply is not recognised"
! said "rollback.sh first" || fail "a part-way apply was taken for a rollback"
[[ "$(s3_tag)" == "$B" ]] || fail "prod.tfvars was not uploaded after finishing the release"
pass "deploy.sh refuses when ECS already rolled back, and reports a rollback during the wait; a release applied part-way is finished"

fresh "$A" "$A" "$B"
answers y
FAKE_TG_FAIL_ROUNDS=2 FAKE_SETTLE_POLLS=3 run deploy.sh || fail "deploy.sh gave up within three target waits"
[[ "$(grep -c "elbv2 wait target-in-service" "$FAKE_DIR/calls.log")" == 3 ]] || fail "the target wait was not retried"
fresh "$A" "$A" "$B"
answers y
if FAKE_TG_FAIL_ROUNDS=3 run deploy.sh; then fail "deploy.sh passed with targets never healthy"; fi
said "never became healthy" || fail "unhealthy targets are not reported"
fresh "$A" "$A" "$B"
answers y
if FAKE_CURL_FAIL=1 run deploy.sh; then fail "deploy.sh passed with /health failing"; fi
pass "deploy.sh: a settling deployment is waited on; target waits retried three times; /health must answer"

fresh "$A" "$A" "$B"
if FAKE_CI="completed failure" run deploy.sh; then fail "deploy.sh deployed with CI red"; fi
said "failure" || fail "the CI refusal does not say why"
! called "aws" || fail "red CI still reached AWS"
fresh "$A" "$A" "$B"
if FAKE_CI=none run deploy.sh; then fail "deploy.sh deployed a commit with no CI run"; fi
fresh "$A" "$A" "$B"
answers y
FAKE_CI="completed failure" run deploy.sh --skip-ci-check || fail "--skip-ci-check did not skip"
said "WARNING: CI not checked" || fail "--skip-ci-check did not warn"
fresh "$A" "$A" "$B"
answers y
FAKE_CI_SCHEDULED="completed failure" run deploy.sh || fail "a red scheduled run refused the deploy"
said "WARNING: the latest scheduled CI run on main is failure" || fail "a red scheduled run did not warn"
called "gh run list --workflow ci.yml --branch main --commit $(git -C "$R" rev-parse HEAD) --event push" || fail "CI was not checked on main's push run of the exact commit"
echo stray > "$R/backend/src/stray.rs"
fresh "$A" "$A" "$B"
if run deploy.sh; then fail "deploy.sh built images from a tree holding an untracked file"; fi
said "untracked files" || fail "the untracked file is not named"
rm "$R/backend/src/stray.rs"
echo dirty >> "$R/README.md"
fresh "$A" "$A" "$B"
if run deploy.sh; then fail "deploy.sh deployed a dirty tree"; fi
said "uncommitted changes" || fail "the dirty tree is not named"
git -C "$R" checkout -q -- README.md
git -C "$R" checkout -q -b side "$B" && git -C "$R" commit -q --allow-empty -m side
fresh "$A" "$A" "$B"
if run deploy.sh; then fail "deploy.sh deployed a commit not on origin/main"; fi
said "not on origin/main" || fail "the off-main refusal does not say why"
git -C "$R" checkout -q "$B"
fresh "$A" "$A" "$B"
if FAKE_ACCOUNT=999999999999 run deploy.sh; then fail "deploy.sh ran in the wrong account"; fi
said "ACCOUNT=123456789012" || fail "the account refusal does not say why"
fresh "$A" "$A" "$B"
if FAKE_STS_FAIL=1 run deploy.sh; then fail "deploy.sh ran with an expired login"; fi
said "aws sso login --profile acrodont" || fail "an expired login does not say how to log in"
fresh "$A" "$A" "$B"
if run deploy.sh --set image_tag=x; then fail "deploy.sh took --set image_tag"; fi
fresh "$A" "$A"
if run deploy.sh --set mail_max_per_secnd=14; then fail "deploy.sh took an undeclared --set"; fi
! called "docker" || fail "an undeclared --set was refused only after building"
fresh "$A" "$A"
answers y
run deploy.sh --set mail_max_per_second=14 || fail "deploy.sh --set failed"
{ grep -qx 'mail_max_per_second = 14' "$S3_TFVARS" && [[ "$(s3_tag)" == "$B" ]]; } || fail "--set and the image did not ship together"
pass "deploy.sh refuses red or missing CI (with --skip-ci-check), warns on a red nightly, refuses a dirty tree, off-main HEAD, wrong account, expired login, an undeclared --set (before building)"

# ---------------------------------------------------------------------------
# set-setting.sh, and the tfvars upload race
# ---------------------------------------------------------------------------
fresh "$B" "$B"
answers y
run set-setting.sh mail_max_per_second=14 domain_name=acrodont.test use_fargate_spot=true || fail "set-setting.sh failed"
grep -qx 'mail_max_per_second = 14' "$S3_TFVARS" || fail "the setting was not uploaded"
grep -qx 'domain_name = "acrodont.test"' "$S3_TFVARS" || fail "a string was not quoted"
grep -qx 'use_fargate_spot = true' "$S3_TFVARS" || fail "a boolean was quoted"
in_order "$TF plan" "$TF apply" "aws s3 cp $R/infra/prod.tfvars" "aws elbv2 wait"
fresh "$B" "$B"
printf '%s' "$PLAN_SNS_ONLY" > "$FAKE_DIR/plan.json"
answers y
run set-setting.sh --unset desired_count || fail "set-setting.sh --unset failed"
! grep -q desired_count "$S3_TFVARS" || fail "--unset left the key"
! called "elbv2" || fail "a plan that does not touch ECS waited for the service"
fresh "$B" "$B"
if run set-setting.sh image_tag=x; then fail "set-setting.sh set image_tag"; fi
said "deploy.sh's and rollback.sh's" || fail "the image_tag refusal does not say whose it is"
if run set-setting.sh mail_max_per_secnd=14; then fail "an undeclared variable was set"; fi
said "declares no variable mail_max_per_secnd" || fail "the unknown variable is not named"
if run set-setting.sh 'domain_name=a"b'; then fail "an unquoted value with a quote was taken"; fi
! called "$TF plan" || fail "a refused setting was planned"
fresh "$B" "$B"
answers y
if FAKE_APPLY_TOUCH_S3=1 run set-setting.sh mail_max_per_second=14; then
  fail "prod.tfvars was uploaded over a copy changed during the apply"
fi
said "changed while this ran" || fail "the concurrent change is not reported"
grep -q "someone else" "$S3_TFVARS" || fail "the other deployer's copy was overwritten"
pass "set-setting.sh sets, quotes, unsets and uploads; refuses image_tag, undeclared keys, and an upload after a concurrent change"

# The circuit breaker undoing a cpu change keeps the image: still caught.
fresh "$B" "$B"
answers y
if FAKE_ROLLBACK=1 run set-setting.sh task_cpu=2048; then fail "a cpu change ECS rolled back counted as applied"; fi
said "ECS rolled the release back" || fail "the cpu rollback is not reported"
said "[$B 1024 2048]" || fail "the report does not show what runs"
pass "a circuit-breaker rollback of a cpu change (same image) is caught by comparing cpu and memory"

# Settings from the environment win over the file.
fresh "$B" "$B"
if SITE=other.test run set-setting.sh mail_max_per_second=14; then fail "a SITE from the environment was ignored"; fi
said "SITE=other.test, but the stack's site_host is acrodont.test" || fail "the environment's SITE did not win"
pass "variables already set in the environment win over ~/.acrodont-env"

# ---------------------------------------------------------------------------
# rollback.sh
# ---------------------------------------------------------------------------
git -C "$R" checkout -q "$E"
fresh "$B" "$A" "$B"
answers "" y y
run rollback.sh || fail "rollback.sh failed"
said "1) $A" || fail "the previous release was not offered first"
said "0002_games.sql" || fail "the added migration was not warned about"
! called "docker" || fail "rollback.sh built something"
for r in "acrodont-backend --image-ids imageTag=$A" "acrodont-backend --image-ids imageTag=$A-ops" "acrodont-frontend --image-ids imageTag=$A"; do
  called "aws ecr describe-images --repository-name $r" || fail "rollback.sh did not check $r"
done
[[ "$(s3_tag)" == "$A" ]] || fail "the rollback did not upload image_tag $A"
in_order "$TF plan" "$TF apply" "aws s3 cp $R/infra/prod.tfvars" "aws elbv2 wait" "curl"
pass "rollback.sh offers the previous ECR tag, warns of added migrations, builds nothing, ships through the gate"

fresh "$B" "$A" "$B"
answers "" n
if run rollback.sh; then fail "rollback.sh went on after the migration warning was declined"; fi
! called "$TF plan" || fail "a declined rollback planned"
fresh "$B" "$A" "$B"
printf '{"tag": "%s", "cpu": "1024", "memory": "2048"}' "$A" > "$FAKE_DIR/ecs/running.json"
answers "" y y
run rollback.sh || fail "rollback.sh failed after a circuit breaker"
{ said "circuit breaker" && said "Roll back to $A (what ECS runs)"; } || fail "what ECS runs was not the default"
[[ "$(s3_tag)" == "$A" ]] || fail "prod.tfvars does not name what ECS runs"
fresh "$E" "$B" "$E"
answers y y
if run rollback.sh --to "$B"; then fail "rollback.sh crossed an edited migration"; fi
said "0001_initial.sql" || fail "the refusal does not name the migration"
! called "$TF plan" || fail "a refused rollback planned"
fresh "$B" "$B"
mkdir -p "$FAKE_DIR/ecr/acrodont-backend" && printf '2026-09-01T00:00:00+00:00' > "$FAKE_DIR/ecr/acrodont-backend/$A"
if run rollback.sh --to "$A"; then fail "rollback.sh went to a tag whose images are not all in ECR"; fi
said "acrodont-backend:$A-ops is not in ECR" || fail "the missing image is not named"
pass "rollback.sh follows a circuit-breaker rollback, refuses edited migrations and missing images"

# ---------------------------------------------------------------------------
# prod-sql.sh
# ---------------------------------------------------------------------------
git -C "$R" checkout -q "$B"
# shellcheck disable=SC2016 # literal dollars and backquotes, on purpose
odd=$'SELECT \'it\'\'s\', "q", $$dollar$$, `tick`, \\back, $1, :x; -- ;\n\tSELECT 2;\n\n'
fresh "$B"
run prod-sql.sh "$odd" || fail "prod-sql.sh failed"
printf '%s' "$odd" > "$WORK/want.sql"
jq -j '.overrides.containerOverrides[0].environment[] | select(.name == "ACRODONT_SQL") | .value' \
  "$FAKE_DIR/runtask/1.json" > "$WORK/got.sql"
cmp -s "$WORK/want.sql" "$WORK/got.sql" || fail "the SQL in the override is not the SQL given"
cmp -s "$WORK/want.sql" "$FAKE_DIR/psql/1.stdin" || fail "psql inside the task did not read the SQL byte for byte"
[[ "$(cat "$FAKE_DIR/psql/1.args")" == "psql
$APP_URL
-X
-v
ON_ERROR_STOP=1
--single-transaction
-f
-" ]] || fail "psql was not run as specified: $(cat "$FAKE_DIR/psql/1.args")"
called "aws ecs run-task --cluster acrodont --task-definition acrodont-ops --launch-type FARGATE --network-configuration awsvpcConfiguration={subnets=[subnet-1,subnet-2],securityGroups=[sg-task],assignPublicIp=ENABLED}" \
  || fail "the ops task was not started in the task network"
called "aws logs get-log-events --log-group-name /ecs/acrodont --log-stream-name ops/ops/task1" || fail "the log stream was not read"
said "psql printed this" || fail "the task's output was not printed"
fresh "$B"
printf '%s' "$odd" | "$R/scripts/prod-sql.sh" > "$WORK/out" 2>&1 || fail "prod-sql.sh failed with SQL on stdin"
cmp -s "$WORK/want.sql" "$FAKE_DIR/psql/1.stdin" || fail "SQL from stdin did not arrive byte for byte"
fresh "$B"
rc=0; FAKE_PSQL_EXIT=3 run prod-sql.sh "SELECT 1/0" || rc=$?
[[ "$rc" == 3 ]] || fail "prod-sql.sh exited $rc for psql exiting 3"
fresh "$B"
run prod-sql.sh --as-master "ALTER ROLE x NOLOGIN" || fail "prod-sql.sh --as-master failed"
[[ "$(head -1 "$FAKE_DIR/psql/1.args")" == acrodont-master-psql ]] || fail "--as-master did not use acrodont-master-psql"
! grep -qF "$APP_URL" "$FAKE_DIR/psql/1.args" || fail "--as-master passed the app URL"
fresh "$B"
if run prod-sql.sh "$(head -c 8000 /dev/zero | tr '\0' x)"; then fail "8000 bytes of SQL were sent"; fi
! called "run-task" || fail "oversized SQL started a task"
fresh "$B"
rm "$FAKE_DIR/ssm/acrodont_production_DATABASE_URL"
rc=0; run prod-sql.sh "SELECT 1" || rc=$?
((rc != 0)) || fail "a task that never started its container counted as success"
said "unable to pull secrets" || fail "the stopped reason is not shown"
pass "prod-sql.sh: SQL byte for byte (arg or stdin) to psql in the task, the container's exit code, --as-master, the size cap"

# ---------------------------------------------------------------------------
# confirm-user.sh
# ---------------------------------------------------------------------------
# shellcheck disable=SC2016 # literal dollars, on purpose
hostile=("x'); DROP TABLE users; --" 'a$$b$q$c' 'back\slash' "q'uo\"te" ":'v' :v \\gset" 'Zoë 名前' $'new\nline;')
for name in "${hostile[@]}"; do
  sql=$("$R/scripts/confirm-user.sh" --admin --print-sql "$name")
  hex=$(printf '%s' "$sql" | sed -n "s/.*decode('\([0-9a-f]*\)', 'hex').*/\1/p" | head -1)
  [[ "$(python3 -c 'import sys; sys.stdout.write(bytes.fromhex(sys.argv[1]).decode())' "$hex")" == "$name" ]] \
    || fail "the hex in the SQL does not decode to: $name"
  stripped=$(printf '%s' "$sql" | sed "s/decode('[0-9a-f]*', 'hex')//g")
  # shellcheck disable=SC2016,SC1003 # literal pieces of the names
  for frag in "DROP TABLE" 'a$$b' "q'uo" 'back\' ":'v'" "Zoë" "名前" "line;"; do
    [[ "$name" != *"$frag"* || "$stripped" != *"$frag"* ]] || fail "a piece of the username reached the SQL: $frag"
  done
  [[ "$(grep -oE 'email[a-z_]*' <<<"$sql" | sort -u)" == email_confirmed_at ]] || fail "the SQL touches a personal column"
done
plain=$("$R/scripts/confirm-user.sh" --print-sql alice)
! grep -q is_admin <<<"${plain%%RETURNING*}" || fail "is_admin set without --admin"
fresh "$B"
run confirm-user.sh --admin "${hostile[0]}" || fail "confirm-user.sh failed"
cmp -s <("$R/scripts/confirm-user.sh" --admin --print-sql "${hostile[0]}") "$FAKE_DIR/psql/1.stdin" \
  || fail "the SQL psql read is not the SQL printed"
grep -q "is_admin = true" "$FAKE_DIR/psql/1.stdin" || fail "--admin did not reach the SQL"
pass "confirm-user.sh: hostile usernames reach the SQL only as hex; no email column; the same SQL reaches psql"

# ---------------------------------------------------------------------------
# rotate-db-password.sh and init-db-roles.sh
# ---------------------------------------------------------------------------
fresh "$B"
answers y
run rotate-db-password.sh || fail "rotate-db-password.sh failed"
new=$(ssm_get DATABASE_URL)
newpw=$(python3 -c 'import sys, urllib.parse as u; print(u.urlsplit(sys.argv[1]).password)' "$new")
[[ "$newpw" =~ ^[0-9a-f]{48}$ ]] || fail "the new password is not 48 hex characters"
[[ "${new/$newpw/oldpw}" == "$APP_URL" ]] || fail "the URL changed beyond its password: $new"
in_order "aws ssm put-parameter --name /acrodont/production/DATABASE_URL --type SecureString --overwrite --value file://" \
         "aws ecs run-task" \
         "aws ecs update-service --cluster acrodont --service acrodont --force-new-deployment" \
         "aws elbv2 wait"
[[ "$(head -1 "$FAKE_DIR/psql/1.args")" == acrodont-master-psql ]] || fail "the password was not set as master"
grep -qx "WF_P=$newpw" "$FAKE_DIR/psql/1.env" || fail "the task did not take the password from its own DATABASE_URL"
grep -qx "WF_U=acrodont_app" "$FAKE_DIR/psql/1.env" || fail "the task did not take the user from its own DATABASE_URL"
grep -qF "ALTER ROLE :\"u\" PASSWORD :'p';" "$FAKE_DIR/psql/1.stdin" || fail "the SQL is not ALTER ROLE from psql variables"
! grep -rqF "$newpw" "$FAKE_DIR/calls.log" "$FAKE_DIR/runtask" "$WORK/out" || fail "the new password travelled in a call, an override or the output"
fresh "$B"
answers y
if FAKE_PSQL_EXIT=3 run rotate-db-password.sh; then fail "a failed ALTER ROLE counted as done"; fi
said "--resume" || fail "a part-way stop does not say --resume"
! called "update-service" || fail "the service restarted after a failed rotation"
cur=$(ssm_get DATABASE_URL)
: > "$FAKE_DIR/calls.log"
answers y
run rotate-db-password.sh --resume || fail "--resume failed"
! called "put-parameter" || fail "--resume wrote a new password"
[[ "$(ssm_get DATABASE_URL)" == "$cur" ]] || fail "--resume changed SSM"
in_order "aws ecs run-task" "aws ecs update-service"
fresh "$B"
answers y
run rotate-db-password.sh --backup || fail "rotate-db-password.sh --backup failed"
[[ "$(ssm_get BACKUP_DATABASE_URL)" != "$BACKUP_URL" && "$(ssm_get DATABASE_URL)" == "$APP_URL" ]] \
  || fail "--backup did not rotate the backup URL alone"
grep -qx "WF_U=acrodont_backup" "$FAKE_DIR/psql/1.env" || fail "--backup did not set acrodont_backup's password"
! called "update-service" || fail "--backup restarted the service"
fresh "$B"
answers y
run rotate-db-password.sh --signing-key || fail "rotate-db-password.sh --signing-key failed"
[[ "$(ssm_get SESSION_SIGNING_KEY)" =~ ^[0-9a-f]{64}$ ]] || fail "the signing key is not 64 hex characters"
said "EVERYONE IS SIGNED OUT" || fail "--signing-key did not warn"
{ ! called "run-task" && called "update-service"; } || fail "--signing-key should restart and touch no role"
fresh "$B"
ssm_put DATABASE_URL 'postgres://postgres:pw@h:5432/acrodont'
answers y
if run rotate-db-password.sh; then fail "a DATABASE_URL for another role was rotated"; fi
! called "put-parameter" || fail "a wrong-role URL was overwritten"
pass "rotate-db-password.sh: SSM first, the role's password set from the task's own URL (never in an override), restart; --resume, --backup, --signing-key"

fresh "$B"
rm -f "$FAKE_DIR"/ssm/*
ssm_put SESSION_SIGNING_KEY keep
run init-db-roles.sh || fail "init-db-roles.sh failed"
[[ "$(ssm_get SESSION_SIGNING_KEY)" == keep ]] || fail "an existing parameter was overwritten"
[[ "$(ssm_get DATABASE_URL)" =~ ^postgres://acrodont_app:[0-9a-f]{48}@acrodont\.abc\.us-east-1\.rds\.amazonaws\.com:5432/acrodont\?sslmode=require$ ]] \
  || fail "DATABASE_URL is not as specified: $(ssm_get DATABASE_URL)"
[[ "$(ssm_get BACKUP_DATABASE_URL)" =~ ^postgres://acrodont_backup:[0-9a-f]{48}@.*:5432/acrodont\?sslmode=require$ ]] \
  || fail "BACKUP_DATABASE_URL is not as specified"
! called "put-parameter --name /acrodont/production/SESSION_SIGNING_KEY" || fail "the existing key was put"
! called "--overwrite" || fail "init-db-roles.sh overwrote a parameter"
in_order "put-parameter --name /acrodont/production/DATABASE_URL" "put-parameter --name /acrodont/production/BACKUP_DATABASE_URL" "aws ecs run-task"
grep -qx "APP_U=acrodont_app" "$FAKE_DIR/psql/1.env" && grep -qx "BK_U=acrodont_backup" "$FAKE_DIR/psql/1.env" \
  || fail "the roles were not read from the task's own URLs"
for want in "CREATE ROLE %I WITH LOGIN PASSWORD %L" "ALTER SCHEMA public OWNER TO" "GRANT pg_read_all_data TO" "GRANT ALL ON DATABASE"; do
  grep -qF "$want" "$FAKE_DIR/psql/1.stdin" || fail "the roles SQL lacks: $want"
done
! grep -rqF "$(python3 -c 'import sys, urllib.parse as u; print(u.urlsplit(sys.argv[1]).password)' "$(ssm_get DATABASE_URL)")" \
  "$FAKE_DIR/calls.log" "$FAKE_DIR/runtask" "$WORK/out" || fail "a password travelled in a call, an override or the output"
: > "$FAKE_DIR/calls.log"
run init-db-roles.sh || fail "a second init-db-roles.sh failed"
! called "put-parameter" || fail "a second run put parameters again"
pass "init-db-roles.sh: missing parameters created (never overwritten), roles made from the task's own URLs; safe to rerun"

# ---------------------------------------------------------------------------
# cutover-db.sh
# ---------------------------------------------------------------------------
fresh "$B"
answers y
run cutover-db.sh acrodont_restored || fail "cutover-db.sh failed"
[[ "$(ssm_get DATABASE_URL)" == "${APP_URL/5432\/acrodont?/5432/acrodont_restored?}" ]] \
  || fail "DATABASE_URL changed beyond its database: $(ssm_get DATABASE_URL)"
[[ "$(ssm_get BACKUP_DATABASE_URL)" == "${BACKUP_URL/5432\/acrodont?/5432/acrodont_restored?}" ]] \
  || fail "BACKUP_DATABASE_URL changed beyond its database: $(ssm_get BACKUP_DATABASE_URL)"
in_order "aws ecs run-task" \
         "aws ssm put-parameter --name /acrodont/production/DATABASE_URL --type SecureString --overwrite --value file://" \
         "aws ssm put-parameter --name /acrodont/production/BACKUP_DATABASE_URL --type SecureString --overwrite --value file://" \
         "aws ecs update-service --cluster acrodont --service acrodont --force-new-deployment" \
         "aws elbv2 wait"
[[ "$(head -1 "$FAKE_DIR/psql/1.args")" == psql ]] || fail "the database was not checked as the app role"
grep -qx "WF_U=acrodont_app" "$FAKE_DIR/psql/1.env" && grep -qx "WF_DB=acrodont_restored" "$FAKE_DIR/psql/1.env" \
  || fail "the check did not connect to the new database as acrodont_app"
! grep -q "^WF_P=" "$FAKE_DIR/psql/1.env" || fail "the password was left in the task's environment for psql's children"
for want in "pg_get_userbyid(datdba)" "has_schema_privilege('public', 'CREATE')" "FROM users" "FROM _sqlx_migrations"; do
  grep -qF "$want" "$FAKE_DIR/psql/1.stdin" || fail "the check's SQL lacks: $want"
done
! grep -rqF "oldpw" "$FAKE_DIR/calls.log" "$FAKE_DIR/runtask" "$WORK/out" || fail "a password travelled in a call, an override or the output"
: > "$FAKE_DIR/calls.log"
run cutover-db.sh acrodont_restored || fail "a second cutover-db.sh failed"
said "nothing to do" || fail "a finished cutover is not recognised"
{ ! called "put-parameter" && ! called "update-service" && ! called "run-task"; } || fail "a finished cutover did something"
fresh "$B"
answers y
if FAKE_PSQL_EXIT=3 run cutover-db.sh acrodont_restored; then fail "a database the app cannot use was cut over to"; fi
said "nothing changed" || fail "the refusal does not say nothing changed"
{ ! called "put-parameter" && ! called "update-service"; } || fail "a refused cutover wrote a parameter or restarted the service"
fresh "$B"
answers n
if run cutover-db.sh acrodont_restored; then fail "a declined cutover went ahead"; fi
! called "put-parameter" || fail "a declined cutover wrote a parameter"
fresh "$B"
for bad_name in "" "Acrodont" "a b" "x;DROP" "acrodont?sslmode=disable"; do
  if run cutover-db.sh "$bad_name"; then fail "cutover-db.sh took the database name '$bad_name'"; fi
done
! called "aws" || fail "a refused name reached AWS"
fresh "$B"
ssm_put BACKUP_DATABASE_URL "${BACKUP_URL/5432\/acrodont?/5432/acrodont_restored?}"
answers y
run cutover-db.sh acrodont_restored || fail "finishing a part-way cutover failed"
[[ "$(ssm_get DATABASE_URL)" == "${APP_URL/5432\/acrodont?/5432/acrodont_restored?}" ]] || fail "a part-way cutover was not finished"
pass "cutover-db.sh: the new database checked as the app role first, both URLs repointed (nothing else in them), restart; refused, declined, bad names, rerun"

# ---------------------------------------------------------------------------
# check-alerts.sh, prod-shell.sh, onboard-deployer.sh
# ---------------------------------------------------------------------------
fresh "$B"
run check-alerts.sh || fail "check-alerts.sh failed"
in_order "set-alarm-state --alarm-name acrodont-no-dump-36h --state-value OK" \
         "set-alarm-state --alarm-name acrodont-no-dump-36h --state-value ALARM" \
         "set-alarm-state --alarm-name acrodont-no-dump-36h --state-value OK"
[[ "$(grep -c "test-event-pattern" "$FAKE_DIR/calls.log")" == 10 ]] || fail "not every pattern case was tested"
called "aws rds describe-event-subscriptions --subscription-name acrodont-db-events" || fail "the RDS subscription was not checked"
fresh "$B"
if FAKE_SNS_PENDING=1 run check-alerts.sh; then fail "an unconfirmed subscription passed"; fi
said "no confirmed subscription" || fail "the unconfirmed subscription is not reported"
fresh "$B"
if FAKE_RULE_BROKEN=acrodont-backup-failed run check-alerts.sh; then fail "a rule matching successes passed"; fi
said "acrodont-backup-failed: a backup task exiting 0 -> True, expected False" || fail "the broken rule is not reported"
fresh "$B"
if FAKE_RULE_EXIT_CODE_ONLY=acrodont-drill-failed run check-alerts.sh; then fail "a rule blind to a task that never starts passed"; fi
said "acrodont-drill-failed: a drill task that never started -> False, expected True" || fail "the blind rule is not reported"
fresh "$B"
if FAKE_RDS_SUB_STATUS=creating run check-alerts.sh; then fail "an inactive RDS subscription passed"; fi
pass "check-alerts.sh: subscription confirmed, alarm forced ALARM then OK, patterns positive and negative (a task that never started included), RDS subscription"

fresh "$B"
run prod-shell.sh || fail "prod-shell.sh failed"
jq -e '.exec == true and .overrides.containerOverrides[0].command == ["bash", "-c", "sleep 14400"]' "$FAKE_DIR/runtask/1.json" >/dev/null \
  || fail "the shell task was not started with ECS Exec and a 4-hour sleep"
called "aws ecs execute-command --cluster acrodont --task arn:aws:ecs:us-east-1:123456789012:task/acrodont/task1 --container ops --interactive --command /bin/bash" \
  || fail "no interactive shell was opened"
! called "stop-task" || fail "leaving the shell stopped the task"
said "aws ecs stop-task --cluster acrodont --task" || fail "how to stop the task is not said"
fresh "$B"
SHELL_HOURS=1 run prod-shell.sh || fail "prod-shell.sh with SHELL_HOURS failed"
jq -e '.overrides.containerOverrides[0].command[2] == "sleep 3600"' "$FAKE_DIR/runtask/1.json" >/dev/null || fail "SHELL_HOURS was ignored"
fresh "$B"
run prod-shell.sh --attach arn:aws:ecs:us-east-1:123456789012:task/acrodont/task9 || fail "--attach failed"
{ called "execute-command --cluster acrodont --task arn:aws:ecs:us-east-1:123456789012:task/acrodont/task9" && ! called "run-task"; } \
  || fail "--attach did not just attach"
pass "prod-shell.sh: an ECS Exec task sleeping SHELL_HOURS, an interactive shell, left running; --attach"

fresh "$B"
rm -f "$ACRODONT_ENV"
answers acrodont acrodont.test state-bucket us-east-2 123456789012
FAKE_PLAN_RC=0 run onboard-deployer.sh || fail "onboard-deployer.sh failed"
for want in "export AWS_PROFILE=acrodont" "export SITE=acrodont.test" "export STATE_BUCKET=state-bucket" \
            "export STATE_REGION=us-east-2" "export ACCOUNT=123456789012"; do
  grep -qxF "$want" "$ACRODONT_ENV" || fail "the settings file lacks: $want"
done
called "$TF init -input=false -backend-config=bucket=state-bucket -backend-config=key=acrodont/production.tfstate -backend-config=region=us-east-2 -backend-config=use_lockfile=true" \
  || fail "terraform init was not pointed at the shared state"
in_order "aws sts get-caller-identity" "$TF init" "aws s3 cp s3://state-bucket/acrodont/prod.tfvars" "$TF plan -input=false -detailed-exitcode -lock=false -var-file=prod.tfvars"
! called "apply" || fail "onboarding applied something"
fresh "$B"
if FAKE_PLAN_RC=2 run onboard-deployer.sh; then fail "onboarding passed with a plan that shows changes"; fi
said "the plan shows changes" || fail "the changes are not reported"
fresh "$B"
if FAKE_TF_VERSION=1.10.5 run onboard-deployer.sh; then fail "onboarding passed with terraform 1.10"; fi
said "too old" || fail "an old terraform is not reported"
fresh "$B"
FAKE_NO_OUTPUTS=1 FAKE_PLAN_RC=2 run onboard-deployer.sh || fail "onboard-deployer.sh failed on a stack never applied"
said "the first setup" || fail "a stack never applied is not recognised"
in_order "$TF init" "aws s3 cp s3://state-bucket/acrodont/prod.tfvars" "$TF plan -input=false -detailed-exitcode -lock=false -var-file=prod.tfvars"
! called "apply" || fail "the first setup applied something"
fresh "$B"
if FAKE_NO_OUTPUTS=1 FAKE_PLAN_RC=0 run onboard-deployer.sh; then fail "an empty state with nothing to add passed"; fi
fresh "$B"
if FAKE_NO_OUTPUTS=1 FAKE_PLAN_RC=1 run onboard-deployer.sh; then fail "a failed first plan passed"; fi
write_env
pass "onboard-deployer.sh: settings written from answers, init against the shared state, a plan that must show no changes; before the first apply, one that must show the stack to add"

# ---------------------------------------------------------------------------
# runbook-check.sh
# ---------------------------------------------------------------------------
good="$WORK/good.md" bad="$WORK/bad.md"
cat > "$good" <<'EOF'
# Runbook

```bash
export AWS_PAGER=""
aws ecs describe-services --cluster acrodont --services acrodont \
  --query 'services[0].deployments'
```

```sql
SELECT 1;
```

```text
anything
```
EOF
"$ROOT/scripts/runbook-check.sh" "$good" > "$WORK/out" 2>&1 || fail "runbook-check.sh refused a good runbook"
check_bad() {  # description, markdown
  printf '%s\n' "$2" > "$bad"
  if "$ROOT/scripts/runbook-check.sh" "$bad" > "$WORK/out" 2>&1; then fail "runbook-check.sh passed $1"; fi
}
check_bad "an unlabelled fence" $'```\nls\n```'
check_bad "a fence labelled sh" $'```sh\nls\n```'
check_bad "an aws block without AWS_PAGER" $'```bash\naws s3 ls\n```'
check_bad "an aws block setting AWS_PAGER too late" $'```bash\naws s3 ls\nexport AWS_PAGER=""\n```'
check_bad "a block that does not parse" $'```bash\nif true; then\n```'
check_bad "an unclosed fence" $'```bash\nls\n'
check_bad "a backslash-space continuation" $'```bash\nls \\ # comment\n  -l\n```'
pass "runbook-check.sh: passes a good file; refuses unlabelled and sh fences, aws without AWS_PAGER first, bad syntax, unclosed fences, \\ # continuations"

echo "ops scripts check passed"
