# shellcheck shell=bash
#
# Shared by the operator scripts (deploy.sh, rollback.sh, set-setting.sh,
# prod-sql.sh, ...). Sourced, never run: the caller sets `set -euo pipefail`
# and calls ops_init first.
#
#   - settings: ~/.acrodont-env (ACRODONT_ENV), written by onboard-deployer.sh;
#     variables already set in the environment win over the file;
#   - login: `aws sts get-caller-identity`, checked against ACCOUNT;
#   - the stack: Terraform outputs of infra/, AWS_REGION exported from them;
#   - prod.tfvars: fetched from the state bucket, uploaded after an apply, the
#     upload refused if the bucket's copy changed in between;
#   - the plan gate: plan -out, show -json, data-losing changes refused;
#   - prompts from /dev/tty (OPS_TTY in the tests), so a pipe cannot answer;
#   - ops tasks: run-task, polled with no time cap, logs paged, exit code;
#   - the rollout wait: one settled deployment running what was applied.

if [[ -n "${OPS_LIB_LOADED:-}" ]]; then return 0; fi
OPS_LIB_LOADED=1

OPS_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
OPS_INFRA=${INFRA_DIR:-$OPS_ROOT/infra}
OPS_ENV_FILE=${ACRODONT_ENV:-$HOME/.acrodont-env}
OPS_ENV_VARS="AWS_PROFILE SITE STATE_BUCKET STATE_REGION ACCOUNT"
OPS_TFVARS=$OPS_INFRA/prod.tfvars
OPS_TFVARS_KEY=acrodont/prod.tfvars
OPS_NAME=$(basename "$0")
OPS_APP_FAMILY=acrodont
OPS_SSM_PREFIX=/acrodont/production
# Resource types whose loss is data loss or an outage: the data and what
# holds it, and what cannot be replaced without work outside Terraform (a
# new load balancer needs the hand-made DNS alias repointed, a new
# certificate its validation records, a new topic its subscription confirmed)
# or without the site going down (the cluster, the service, the target group).
OPS_DANGEROUS_TYPES='^(aws_db_instance|aws_db_subnet_group|aws_s3_bucket.*|aws_vpc|aws_subnet|aws_kms_key|aws_ecr_repository|aws_lb|aws_lb_target_group|aws_acm_certificate|aws_ecs_cluster|aws_ecs_service|aws_sns_topic)$'
# Paths whose change means the app images must be rebuilt.
OPS_IMAGE_PATHS='^(backend/|frontend/|docker/|contract-fixtures/|scripts/(backup|restore|ops_master_psql|drill)\.py$)'
# CLI v2 pages long output through less, which swallows the rest of a script.
export AWS_PAGER=""

ops_say() { printf '%s: %s\n' "$OPS_NAME" "$*" >&2; }
ops_die() { printf '%s: %s\n' "$OPS_NAME" "$*" >&2; exit 1; }

ops_init() {
  OPS_TMP=$(mktemp -d "${TMPDIR:-/tmp}/acrodont-ops.XXXXXX")
  chmod 700 "$OPS_TMP"
  trap 'rm -rf "$OPS_TMP"' EXIT
}

# ---------------------------------------------------------------------------
# Tools, settings, login
# ---------------------------------------------------------------------------

ops_need() {
  local missing="" t
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || missing="$missing $t"
  done
  [[ -z "$missing" ]] || ops_die "missing tools:$missing (scripts/onboard-deployer.sh checks them all)"
}

# Sources the settings file; a variable already set in the environment keeps
# its value. A missing file is fine when the environment has what is needed.
ops_load_env() {
  local v saved=()
  for v in $OPS_ENV_VARS; do
    [[ -z "${!v+x}" ]] || saved+=("$v=${!v}")
  done
  if [[ -r "$OPS_ENV_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$OPS_ENV_FILE"
  fi
  local kv
  for kv in ${saved[@]+"${saved[@]}"}; do
    printf -v "${kv%%=*}" '%s' "${kv#*=}"
  done
  for v in $OPS_ENV_VARS; do
    [[ -z "${!v:-}" ]] || export "${v?}"
  done
  export AWS_PAGER=""
}

ops_require() {
  local v
  for v in "$@"; do
    [[ -n "${!v:-}" ]] || ops_die "$v is not set (in the environment or $OPS_ENV_FILE; scripts/onboard-deployer.sh writes it)"
  done
}

ops_login() {
  local out
  if ! out=$(aws sts get-caller-identity --query '[Account, Arn]' --output text 2>&1); then
    printf '%s\n' "$out" >&2
    ops_die "not logged in to AWS: run  aws sso login${AWS_PROFILE:+ --profile $AWS_PROFILE}  and run this again"
  fi
  OPS_ACCOUNT=${out%%[[:space:]]*}
  ops_say "AWS: ${out#*[[:space:]]}"
  if [[ -n "${ACCOUNT:-}" && "$ACCOUNT" != "$OPS_ACCOUNT" ]]; then
    ops_die "logged in to account $OPS_ACCOUNT, but ACCOUNT=$ACCOUNT ($OPS_ENV_FILE)"
  fi
}

# ---------------------------------------------------------------------------
# The stack, from Terraform's outputs
# ---------------------------------------------------------------------------

ops_out() { terraform -chdir="$OPS_INFRA" output "$@"; }

# Sets OPS_REGION (exported as AWS_REGION), OPS_CLUSTER, OPS_SERVICE and
# OPS_VARFILES; refuses when SITE disagrees with the stack's site_host.
ops_stack() {
  OPS_REGION=$(ops_out -raw region 2>/dev/null) || OPS_REGION=""
  [[ -n "$OPS_REGION" ]] \
    || ops_die "no Terraform outputs: is infra/ initialized (scripts/onboard-deployer.sh) and the stack applied?"
  # The stack's own region, never the CLI's default.
  export AWS_REGION=$OPS_REGION AWS_DEFAULT_REGION=$OPS_REGION
  OPS_CLUSTER=$(ops_out -raw cluster_name)
  OPS_SERVICE=$(ops_out -raw service_name)
  OPS_VARFILES=(-var-file=prod.tfvars)
  local host
  host=$(ops_out -raw site_host 2>/dev/null) || host=""
  if [[ -n "${SITE:-}" && -n "$host" && "$SITE" != "$host" ]]; then
    ops_die "SITE=$SITE, but the stack's site_host is $host: wrong settings file or wrong state?"
  fi
  OPS_SITE=${SITE:-$host}
  ops_say "region $OPS_REGION, cluster $OPS_CLUSTER, service $OPS_SERVICE"
}

# ---------------------------------------------------------------------------
# prod.tfvars, kept in the state bucket
# ---------------------------------------------------------------------------

ops_tfvars_url() { printf 's3://%s/%s' "$STATE_BUCKET" "$OPS_TFVARS_KEY"; }

# The bucket's copy into infra/prod.tfvars; a differing local file is shown
# and replaced only if the operator agrees (it is kept beside it).
ops_tfvars_fetch() {
  ops_require STATE_BUCKET STATE_REGION
  OPS_TFVARS_BASE=$OPS_TMP/prod.tfvars.fetched
  aws s3 cp "$(ops_tfvars_url)" "$OPS_TFVARS_BASE" --region "$STATE_REGION" --only-show-errors \
    || ops_die "could not fetch $(ops_tfvars_url) (first deploy? upload it: aws s3 cp infra/prod.tfvars $(ops_tfvars_url) --region $STATE_REGION)"
  if [[ -e "$OPS_TFVARS" ]] && ! cmp -s "$OPS_TFVARS" "$OPS_TFVARS_BASE"; then
    ops_say "infra/prod.tfvars differs from the state bucket's copy:"
    diff -u --label "infra/prod.tfvars (this machine)" --label "$(ops_tfvars_url)" \
      "$OPS_TFVARS" "$OPS_TFVARS_BASE" >&2 || true
    ops_confirm "Use the bucket's copy (the one last applied)? The local file is kept beside it." \
      || ops_die "stopped: reconcile infra/prod.tfvars with the bucket's copy first"
    cp "$OPS_TFVARS" "$OPS_TFVARS.local-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  cp "$OPS_TFVARS_BASE" "$OPS_TFVARS"
}

# Uploads infra/prod.tfvars. Refused if the bucket's copy changed since the
# fetch: the state lock serializes applies, not settings.
ops_tfvars_upload() {
  local now=$OPS_TMP/prod.tfvars.now url
  url=$(ops_tfvars_url)
  aws s3 cp "$url" "$now" --region "$STATE_REGION" --only-show-errors \
    || ops_die "could not read $url back; upload by hand: aws s3 cp infra/prod.tfvars $url --region $STATE_REGION"
  if ! cmp -s "$now" "$OPS_TFVARS_BASE"; then
    diff -u --label "as fetched" --label "the bucket now" "$OPS_TFVARS_BASE" "$now" >&2 || true
    ops_die "the bucket's prod.tfvars changed while this ran (another deployer?): not uploaded. Merge by hand, then  aws s3 cp infra/prod.tfvars $url --region $STATE_REGION"
  fi
  if cmp -s "$now" "$OPS_TFVARS"; then
    ops_say "prod.tfvars unchanged; nothing to upload"
    return 0
  fi
  ops_say "uploading prod.tfvars"
  aws s3 cp "$OPS_TFVARS" "$url" --region "$STATE_REGION" --only-show-errors \
    || ops_die "the upload failed; run it by hand: aws s3 cp infra/prod.tfvars $url --region $STATE_REGION"
  cp "$OPS_TFVARS" "$OPS_TFVARS_BASE"
}

# A variable's value in a tfvars file, without quotes (one-line assignments).
ops_tfvar() {
  local key=$1 file=${2:-$OPS_TFVARS}
  awk -v k="$key" '
    {
      line = $0
      if (line !~ "^[ \t]*" k "[ \t]*=") next
      sub("^[ \t]*" k "[ \t]*=[ \t]*", "", line)
      sub(/[ \t]+#.*$/, "", line); sub(/[ \t]+$/, "", line)
      if (line ~ /^".*"$/) line = substr(line, 2, length(line) - 2)
      v = line; found = 1
    }
    END { if (found) print v }
  ' "$file"
}

# Sets KEY to the HCL value VALUE in a tfvars file. A key infra/ does not
# declare is refused: Terraform would only warn about it.
ops_tfvars_set() {
  local key=$1 value=$2 file=${3:-$OPS_TFVARS}
  [[ "$key" =~ ^[a-z_][a-z0-9_]*$ ]] || ops_die "not a variable name: $key"
  cat "$OPS_INFRA"/*.tf 2>/dev/null | grep -Eq "^variable[[:space:]]+\"$key\"" \
    || ops_die "infra/ declares no variable $key"
  [[ "$value" != *$'\n'* ]] || ops_die "a value on one line only"
  local current
  current=$(awk -v k="$key" '$0 ~ "^[ \t]*" k "[ \t]*=" { sub("^[^=]*=[ \t]*", ""); sub(/[ \t]+$/, ""); print }' "$file")
  case "$current" in
    "<<"* | "["*[!\]] | "[" | "{"*[!\}] | "{")
      ops_die "$key's value in $(basename "$file") spans lines: edit it by hand" ;;
  esac
  [[ "$(printf '%s\n' "$current" | grep -c .)" -le 1 ]] \
    || ops_die "$key is set more than once in $(basename "$file"): edit it by hand"
  if grep -Eq "^[[:space:]]*${key}[[:space:]]*=" "$file"; then
    # Through the environment: `awk -v` would read backslashes as escapes.
    OPS_VALUE=$value awk -v k="$key" '
      $0 ~ "^[ \t]*" k "[ \t]*=" { print k " = " ENVIRON["OPS_VALUE"]; next } { print }
    ' "$file" > "$file.new" && mv "$file.new" "$file"
  else
    [[ ! -s "$file" || "$(tail -c1 "$file")" == "" ]] || printf '\n' >> "$file"
    printf '%s = %s\n' "$key" "$value" >> "$file"
  fi
}

ops_tfvars_unset() {
  local key=$1 file=${2:-$OPS_TFVARS}
  [[ "$key" =~ ^[a-z_][a-z0-9_]*$ ]] || ops_die "not a variable name: $key"
  grep -Eq "^[[:space:]]*${key}[[:space:]]*=" "$file" || ops_die "$key is not set in prod.tfvars"
  grep -Ev "^[[:space:]]*${key}[[:space:]]*=" "$file" > "$file.new" || true
  mv "$file.new" "$file"
}

# A value as HCL: numbers, booleans, null, lists, maps and quoted strings as
# given; anything else quoted. Quotes, backslashes and templates must come
# already quoted, as HCL.
ops_hcl_value() {
  local v=$1 number='^-?[0-9]+(\.[0-9]+)?$'
  case $v in
    true | false | null | \"*\" | \[*\] | \{*\})
      printf '%s' "$v"; return 0 ;;
  esac
  if [[ "$v" =~ $number ]]; then
    printf '%s' "$v"
    return 0
  fi
  case $v in
    *[\"\\]* | *"\${"* | *"%{"*)
      ops_die "give this value as HCL, quoted and escaped: $v" ;;
  esac
  printf '"%s"' "$v"
}

ops_show_tfvars_diff() {
  diff -u --label "prod.tfvars (live)" --label "prod.tfvars (${1:-new})" \
    "$OPS_TFVARS_BASE" "$OPS_TFVARS" >&2 || true
}

# ---------------------------------------------------------------------------
# Prompts, from the terminal
# ---------------------------------------------------------------------------

ops_read() {
  if [[ -z "${OPS_TTY_OPEN:-}" ]]; then
    exec 9<"${OPS_TTY:-/dev/tty}" || ops_die "no terminal to ask on"
    OPS_TTY_OPEN=1
  fi
  IFS= read -r "$1" <&9
}

ops_confirm() {
  local answer=""
  printf '%s [y/N] ' "$1" >&2
  ops_read answer || answer=""
  [[ -z "${OPS_TTY:-}" ]] || printf '%s\n' "$answer" >&2
  [[ "$answer" == [yY] || "$answer" == [yY][eE][sS] ]]
}

ops_confirm_typed() {
  local expected=$1 what=$2 answer=""
  printf 'Type %s to %s: ' "$expected" "$what" >&2
  ops_read answer || answer=""
  [[ -z "${OPS_TTY:-}" ]] || printf '%s\n' "$answer" >&2
  [[ "$answer" == "$expected" ]] || ops_die "not confirmed (typed '$answer'): nothing done"
}

# ---------------------------------------------------------------------------
# The plan gate
# ---------------------------------------------------------------------------

# Plans to OPS_PLAN and asks before anything is applied. Sets OPS_PLAN_EMPTY
# when there is nothing to apply, and OPS_PLAN_JSON to the plan as JSON.
ops_plan_gate() {
  OPS_PLAN=$OPS_TMP/acrodont.tfplan
  OPS_PLAN_JSON=$OPS_TMP/acrodont.tfplan.json
  OPS_PLAN_EMPTY=""
  local rc=0
  terraform -chdir="$OPS_INFRA" plan -input=false -detailed-exitcode "${OPS_VARFILES[@]}" \
    -out="$OPS_PLAN" || rc=$?
  case $rc in
    0) OPS_PLAN_EMPTY=1; echo '{}' > "$OPS_PLAN_JSON"; ops_say "the plan has no changes"; return 0 ;;
    2) ;;
    *) ops_die "terraform plan failed: nothing applied" ;;
  esac
  terraform -chdir="$OPS_INFRA" show -json "$OPS_PLAN" > "$OPS_PLAN_JSON" \
    || ops_die "terraform show -json failed: nothing applied"
  local dangerous
  dangerous=$(jq -r --arg re "$OPS_DANGEROUS_TYPES" '
    .resource_changes[]?
    | select(.type | test($re))
    | select(any(.change.actions[]; . == "delete" or . == "forget"))
    | "  \(.address): \(.change.actions | join(" then "))"' "$OPS_PLAN_JSON") \
    || ops_die "could not read the plan's JSON: nothing applied"
  if [[ -n "$dangerous" ]]; then
    ops_say "the plan destroys, replaces or forgets:"
    printf '%s\n' "$dangerous" >&2
    if [[ "${ACRODONT_ALLOW_DESTRUCTIVE_PLAN:-}" != yes ]]; then
      ops_die "refused: nothing was applied. Find out why before going on; once understood, ACRODONT_ALLOW_DESTRUCTIVE_PLAN=yes lets it through with a typed confirmation."
    fi
    ops_confirm_typed destroy "apply it anyway"
  fi
  ops_say "plan: $(jq -r '[.resource_changes[]?.change.actions | join("/")] | map(select(. != "no-op")) | group_by(.) | map("\(length) \(.[0])") | join(", ")' "$OPS_PLAN_JSON")"
  ops_confirm "Apply this plan?" || ops_die "not applied: nothing changed"
}

ops_plan_touches_ecs() {
  [[ -z "$OPS_PLAN_EMPTY" ]] || return 1
  jq -e '[.resource_changes[]?
          | select(.type == "aws_ecs_service" or .type == "aws_ecs_task_definition")
          | select(.change.actions != ["no-op"])] | length > 0' "$OPS_PLAN_JSON" >/dev/null
}

ops_apply_plan() {
  terraform -chdir="$OPS_INFRA" apply -input=false "$OPS_PLAN"
}

# The app task definition's cpu and memory as the plan leaves them ("CPU MEM"),
# else as prod.tfvars sets them; empty when neither says.
ops_expected_size() {
  local size=""
  if [[ -z "$OPS_PLAN_EMPTY" ]]; then
    size=$(jq -r --arg f "$OPS_APP_FAMILY" '
      [.planned_values? // {} | .. | objects
       | select(.type? == "aws_ecs_task_definition" and .values?.family? == $f)][0]
      | if . == null then "" else "\(.values.cpu) \(.values.memory)" end' "$OPS_PLAN_JSON" 2>/dev/null) || size=""
  fi
  if [[ -z "$size" ]]; then
    local c m
    c=$(ops_tfvar task_cpu) m=$(ops_tfvar task_memory)
    [[ -z "$c" || -z "$m" ]] || size="$c $m"
  fi
  printf '%s' "$size"
}

# ---------------------------------------------------------------------------
# The service
# ---------------------------------------------------------------------------

ops_describe_service() {
  aws ecs describe-services --cluster "$OPS_CLUSTER" --services "$OPS_SERVICE" --output json
}

ops_desired_count() { ops_describe_service | jq -r '.services[0].desiredCount // empty'; }

# The PRIMARY deployment's task definition, described: JSON.
ops_live_taskdef() {
  local td
  td=$(ops_describe_service | jq -r '.services[0].deployments[]? | select(.status == "PRIMARY") | .taskDefinition' | head -1) \
    || return 1
  [[ -n "$td" ]] || return 1
  aws ecs describe-task-definition --task-definition "$td" --output json
}

# "TAG CPU MEMORY" of what the service's primary deployment runs: the tag of
# its backend container's image.
ops_live_release() {
  local js
  js=$(ops_live_taskdef) || return 1
  jq -r '.taskDefinition as $t
    | ([$t.containerDefinitions[] | select(.name == "backend") | .image][0] // "") as $img
    | if $img == "" then empty else "\($img | split(":") | last) \($t.cpu) \($t.memory)" end' <<<"$js"
}

ops_live_tag() {
  local r
  r=$(ops_live_release) || return 1
  [[ -n "$r" ]] || return 1
  printf '%s' "${r%% *}"
}

ops_show_events() {
  ops_describe_service | jq -r '.services[0].events[:8][]? | "  \(.createdAt) \(.message)"' >&2 || true
}

# A single deployment, COMPLETED. A circuit-breaker rollback settles too, on
# the old task definition: ops_wait_release tells the two apart.
ops_wait_settled() {
  local i js n state
  for i in $(seq 240); do
    js=$(ops_describe_service 2>/dev/null) || js='{}'
    n=$(jq -r '.services[0].deployments | length' <<<"$js" 2>/dev/null) || n=""
    state=$(jq -r '.services[0].deployments[0].rolloutState // ""' <<<"$js" 2>/dev/null) || state=""
    if [[ "$n" == 1 && "$state" == COMPLETED ]]; then return 0; fi
    ((i % 8 != 1)) || ops_say "waiting for the deployment to settle (${n:-?} deployments, ${state:-?})"
    sleep 15
  done
  ops_die "the deployment has not settled after an hour: aws ecs describe-services --cluster $OPS_CLUSTER --services $OPS_SERVICE"
}

# Waits for the service to settle on TAG (and "CPU MEM" when given), then for
# its targets to be healthy. Compares the task definition, not only the image:
# a circuit-breaker rollback of a cpu change keeps the image.
ops_wait_release() {
  local tag=$1 size=${2:-} live
  ops_say "waiting for the deployment to settle (startup is allowed several minutes; failed starts roll it back)"
  # ECS is eventually consistent: asked at once it may describe only the old,
  # settled deployment, which would read as a rollback.
  sleep 20
  ops_wait_settled
  live=$(ops_live_release) || live=""
  if [[ "${live%% *}" != "$tag" || ( -n "$size" && "${live#* }" != "$size" ) ]]; then
    ops_show_events
    ops_die "ECS rolled the release back: the service runs [${live:-nothing}] (tag cpu memory), not [$tag ${size:-? ?}]. Terraform still names the new one, so before any other apply run scripts/rollback.sh"
  fi
  ops_say "the service runs $tag${size:+ (cpu/memory $size)}"
  ops_wait_healthy
}

# Restarts the service on the task definition it has, so that its tasks read
# their parameters again, and waits until the restart has taken. The image and
# the size are the same before and after, so ops_wait_release could not tell a
# restart that took from one the circuit breaker rolled back: this compares
# deployments. The restart is the deployment update-service returns; the
# service must settle with that one as its PRIMARY. A rollback settles on
# another.
ops_restart_service() {
  local new primary
  new=$(aws ecs update-service --cluster "$OPS_CLUSTER" --service "$OPS_SERVICE" --force-new-deployment --output json \
    | jq -r '[.service.deployments[]? | select(.status == "PRIMARY") | .id][0] // empty') || ops_die "the restart could not be asked for"
  [[ -n "$new" ]] || ops_die "ECS did not say which deployment the restart is: aws ecs describe-services --cluster $OPS_CLUSTER --services $OPS_SERVICE"
  ops_say "the service is restarting to read the new value"
  [[ "$(ops_desired_count)" != 0 ]] || return 0
  ops_say "waiting for the deployment to settle (startup is allowed several minutes; failed starts roll it back)"
  sleep 20
  ops_wait_settled
  primary=$(ops_describe_service | jq -r '[.services[0].deployments[]? | select(.status == "PRIMARY") | .id][0] // empty') || primary=""
  if [[ "$primary" != "$new" ]]; then
    ops_show_events
    ops_die "the restart did not take: the service settled on deployment [${primary:-none}], not the restart's [$new]. The tasks serving now may still hold the old values, and a task that starts later reads the new ones"
  fi
  ops_wait_healthy
}

# The AWS waiter gives up after ten minutes, so it is asked three times.
ops_wait_healthy() {
  local arn round
  arn=$(ops_out -raw target_group_arn)
  for round in 1 2 3; do
    if aws elbv2 wait target-in-service --target-group-arn "$arn"; then
      ops_say "targets healthy"
      return 0
    fi
    ops_say "targets not healthy yet (wait $round of 3)"
  done
  aws elbv2 describe-target-health --target-group-arn "$arn" --output table >&2 || true
  ops_die "the targets never became healthy: see scripts/rollback.sh"
}

ops_check_site() {
  [[ -n "${OPS_SITE:-}" ]] || ops_die "no SITE to check"
  if curl -fsS --max-time 20 "https://$OPS_SITE/health" >/dev/null; then
    ops_say "https://$OPS_SITE/health answers"
  else
    ops_die "applied, but https://$OPS_SITE/health did not answer: look at the site now"
  fi
}

# With infra/prod.tfvars edited: the plan gate, the apply, the upload, then
# the wait -- always with WAIT=always, else only when the plan touched ECS.
ops_ship() {
  local wait=${1:-if-ecs} desired size
  ops_plan_gate
  if [[ -z "$OPS_PLAN_EMPTY" ]]; then
    ops_apply_plan \
      || ops_die "terraform apply failed. prod.tfvars was not uploaded (infra/prod.tfvars has the change): fix the cause and run this again"
  fi
  ops_tfvars_upload
  if [[ "$wait" != always ]] && ! ops_plan_touches_ecs; then
    return 0
  fi
  desired=$(ops_desired_count) || desired=""
  if [[ "$desired" == 0 ]]; then
    ops_say "the service is at desired count 0: nothing to wait for"
    return 0
  fi
  size=$(ops_expected_size)
  ops_wait_release "$(ops_tfvar image_tag)" "$size"
  ops_check_site
}

# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

# Sets OPS_ECR_BACKEND and OPS_ECR_FRONTEND (repository URLs) and their names.
ops_ecr() {
  OPS_ECR_BACKEND=$(ops_out -raw ecr_backend)
  OPS_ECR_FRONTEND=$(ops_out -raw ecr_frontend)
  OPS_REPO_BACKEND=${OPS_ECR_BACKEND##*/}
  OPS_REPO_FRONTEND=${OPS_ECR_FRONTEND##*/}
}

ops_image_exists() {  # repository-name tag
  aws ecr describe-images --repository-name "$1" --image-ids "imageTag=$2" >/dev/null 2>&1
}

# The images of a release, as "repository tag" lines.
ops_release_images() {
  printf '%s %s\n' "$OPS_REPO_BACKEND" "$1" "$OPS_REPO_BACKEND" "$1-ops" "$OPS_REPO_FRONTEND" "$1"
}

# ---------------------------------------------------------------------------
# Schema changes (append-only migrations)
# ---------------------------------------------------------------------------

# The migrations FROM has that TO changed, renamed or deleted (sqlx checksums
# every applied one). Returns 0 when there are some, 1 when none, 2 when FROM
# or TO is not a commit here.
ops_migrations_changed() {
  local from=$1 to=$2 changed
  git -C "$OPS_ROOT" cat-file -e "$from^{commit}" 2>/dev/null || return 2
  git -C "$OPS_ROOT" cat-file -e "$to^{commit}" 2>/dev/null || return 2
  changed=$(git -C "$OPS_ROOT" diff --name-status "$from" "$to" -- backend/migrations/) || return 2
  changed=$(printf '%s\n' "$changed" | awk 'NF && $1 !~ /^A/ { print "  " $0 }')
  [[ -n "$changed" ]] || return 1
  printf '%s\n' "$changed"
}

ops_migrations_added() {
  git -C "$OPS_ROOT" diff --name-status "$1" "$2" -- backend/migrations/ | awk '$1 ~ /^A/ { print "  " $2 }'
}

# What commit TO changes since FROM: "images" and/or "infra", one a line.
# Returns 2 when FROM or TO is not a commit here.
ops_changed_components() {
  local from=$1 to=$2 paths
  git -C "$OPS_ROOT" cat-file -e "$from^{commit}" 2>/dev/null || return 2
  git -C "$OPS_ROOT" cat-file -e "$to^{commit}" 2>/dev/null || return 2
  paths=$(git -C "$OPS_ROOT" diff --name-only --no-renames "$from" "$to") || return 2
  printf '%s\n' "$paths" | ops_path_components
}

ops_path_components() {
  awk -v img="$OPS_IMAGE_PATHS" '
    function hit(c) { if (!(c in seen)) { seen[c] = 1; print c } }
    $0 ~ img     { hit("images"); next }
    /^infra\//   { hit("infra"); next }
  '
}

# ---------------------------------------------------------------------------
# Ops tasks (the acrodont-ops family: psql, python3, acrodont-master-psql)
# ---------------------------------------------------------------------------

ops_network() {
  local subnets sg
  subnets=$(ops_out -json task_subnets | jq -r 'join(",")')
  sg=$(ops_out -raw task_security_group)
  printf 'awsvpcConfiguration={subnets=[%s],securityGroups=[%s],assignPublicIp=ENABLED}' "$subnets" "$sg"
}

# Starts an ops task with the container overrides OVERRIDES (JSON); further
# arguments go to run-task. Prints the task ARN.
ops_run_task() {
  local overrides=$1 started arn
  shift
  started=$(aws ecs run-task --cluster "$OPS_CLUSTER" --task-definition "$(ops_out -raw ops_task_family)" \
    --launch-type FARGATE --network-configuration "$(ops_network)" \
    --overrides "$overrides" "$@" --output json) || ops_die "ecs run-task failed"
  arn=$(jq -r '.tasks[0].taskArn // empty' <<<"$started")
  if [[ -z "$arn" ]]; then
    jq '.failures' <<<"$started" >&2 || true
    ops_die "the ops task did not start"
  fi
  printf '%s' "$arn"
}

ops_describe_task() {
  aws ecs describe-tasks --cluster "$OPS_CLUSTER" --tasks "$1" --output json
}

# Polled without a cap: `aws ecs wait tasks-stopped` gives up after ten
# minutes while the SQL runs on and commits, and a rerun would run it twice.
# A task ECS does not describe ("MISSING") is new (eventual consistency) or
# long forgotten (a laptop that slept): stopped once seen, or after 5 minutes.
ops_wait_task_stopped() {
  local arn=$1 seen=0 unseen=0 failed=0 status
  while :; do
    sleep 10
    status=$(ops_describe_task "$arn" 2>/dev/null | jq -r 'if (.tasks | length) == 0 then "MISSING" else .tasks[0].lastStatus end' 2>/dev/null) || status=""
    [[ "$status" == STOPPED ]] && return 0
    if [[ "$status" == MISSING ]]; then
      unseen=$((unseen + 1)) failed=0
      { ((seen)) || ((unseen >= 30)); } && return 0
    elif [[ -n "$status" ]]; then
      seen=1 unseen=0 failed=0
    else
      # The call itself fails (an expired sign-in, no network). The task runs
      # on whatever this does, so it is not given up on: it is said, once a
      # minute, with what to do.
      failed=$((failed + 1))
      ((failed % 6 != 0)) || ops_say "cannot ask ECS about the task (for $((failed / 6)) min): it may still be running. If your sign-in has expired, run  aws sso login  in another terminal and this carries on"
    fi
  done
}

# Every page of the task's log stream (one call returns at most 1 MB).
ops_task_logs() {
  local arn=$1 group token="" page next
  group=$(ops_out -raw log_group)
  # CloudWatch takes a few seconds to ingest the last lines: psql's ERROR.
  sleep 10
  while :; do
    page=$(aws logs get-log-events --log-group-name "$group" \
      --log-stream-name "ops/ops/${arn##*/}" --start-from-head \
      ${token:+--next-token "$token"} --output json 2>/dev/null) || {
      ops_say "no output from the task:"
      ops_describe_task "$arn" | jq -r '.tasks[0] | "\(.stoppedReason // "") \(.containers[0].reason // "")"' >&2 || true
      return 1
    }
    jq -r '.events[].message' <<<"$page"
    next=$(jq -r '.nextForwardToken' <<<"$page")
    [[ "$next" != "$token" ]] || break
    token=$next
  done
}

# The ops container's exit code; empty when ECS no longer knows it.
ops_task_exit() {
  ops_describe_task "$1" | jq -r '[.tasks[0].containers[]? | select(.name == "ops") | .exitCode][0] // empty'
}

# Runs SCRIPT with bash in a one-off ops task (ENV_JSON: extra environment as
# [{name, value}]), prints its log, and returns the container's exit code: 2
# when ECS cannot say what it was, 125 when no task was started at all.
#
# Callers run this as `ops_run_ops_script ... || rc=$?`, and bash turns
# `set -e` off inside a function called that way, so each step that must not
# be carried on from is checked here by hand: a run-task that failed or
# started nothing (an expired sign-in, no Fargate capacity) would otherwise
# leave an empty ARN to be waited on, with "it may still be running" said of
# a task that never existed.
ops_run_ops_script() {
  local script=$1 env=${2:-[]} overrides arn code
  overrides=$(jq -cn --arg s "$script" --argjson env "$env" \
    '{containerOverrides: [{name: "ops", environment: $env, command: ["bash", "-c", $s]}]}') || overrides=""
  if [[ -z "$overrides" ]]; then
    ops_say "the task's command and environment could not be put together: no ops task was started, so nothing ran"
    return 125
  fi
  arn=$(ops_run_task "$overrides") || arn=""
  if [[ -z "$arn" ]]; then
    ops_say "no ops task was started, so nothing ran and nothing is still running"
    return 125
  fi
  ops_say "running $arn"
  ops_wait_task_stopped "$arn"
  ops_task_logs "$arn" || true
  code=$(ops_task_exit "$arn") || code=""
  if [[ -z "$code" ]]; then
    ops_say "the task's exit status is unknown (stopped before its container ran, or forgotten by ECS): read the output above before running anything again"
    return 2
  fi
  [[ "$code" == 0 ]] || ops_say "the ops task exited $code"
  return "$code"
}

# A shell snippet, for ops task scripts: exports WF_U, WF_P and WF_DB from the
# URL in the variable named $1, parsed inside the task -- so a password never
# travels in an override or a log.
ops_url_parts_snippet() {
  printf 'export WF_URL_VAR=%s\n' "$1"
  cat <<'EOF'
eval "$(python3 -c 'import os, shlex, urllib.parse as u
p = u.urlsplit(os.environ[os.environ["WF_URL_VAR"]])
for k, v in (("WF_U", p.username), ("WF_P", p.password), ("WF_DB", p.path.lstrip("/"))):
    print("export %s=%s" % (k, shlex.quote(u.unquote(v or ""))))')"
EOF
}
