#!/usr/bin/env bash
# Set up this machine to deploy acrodont. Changes nothing in AWS.
#
#   scripts/onboard-deployer.sh
#
# Run it from a clone, after `aws configure sso` with the profile you were
# given. It:
#   1. checks the tools (aws, terraform >= 1.11, gh, docker, jq,
#      session-manager-plugin, curl, git, python3);
#   2. writes ~/.acrodont-env (ACRODONT_ENV) if there is none, asking for
#      AWS_PROFILE, SITE, STATE_BUCKET, STATE_REGION and ACCOUNT;
#   3. checks the login (`aws sso login` if it has expired) and the account;
#   4. runs `terraform init` against the shared state (S3, lock file);
#   5. fetches prod.tfvars from the state bucket;
#   6. ends with a plan that must show NO changes. If it shows some, stop and
#      compare with whoever deployed last: one of you has an out-of-date main
#      or prod.tfvars.
set -euo pipefail
# shellcheck source=scripts/lib/ops.sh
source "$(dirname "$0")/lib/ops.sh"

[[ $# == 0 ]] || { sed -n '5p' "$0" >&2; exit 2; }

ops_init
# 1. Tools.
ops_need aws terraform gh docker jq session-manager-plugin curl git python3
tf_version=$(terraform version -json | jq -r .terraform_version)
# use_lockfile (S3 locking without DynamoDB) needs 1.11.
[[ "$(printf '%s\n' 1.11.0 "$tf_version" | sort -V | head -1)" == 1.11.0 ]] \
  || ops_die "terraform $tf_version is too old: 1.11 or newer is needed (install the release zip)"
ops_say "terraform $tf_version: use the same version as the other deployers (state written by a newer one cannot be read by an older)"

ask() {  # variable, question, default, validation regex
  local answer=""
  printf '%s%s ' "$2" "${3:+ [$3]}" >&2
  ops_read answer || answer=""
  [[ -z "${OPS_TTY:-}" ]] || printf '%s\n' "$answer" >&2
  answer=${answer:-$3}
  [[ "$answer" =~ $4 ]] || ops_die "not valid: '$answer'"
  printf -v "$1" '%s' "$answer"
}

# 2. The settings file.
ops_load_env
if [[ ! -e "$OPS_ENV_FILE" ]]; then
  ops_say "no $OPS_ENV_FILE yet; writing one"
  name='^[A-Za-z0-9._-]+$'
  ask profile "The AWS CLI profile (from aws configure sso)?" "${AWS_PROFILE:-acrodont}" "$name"
  ask site "The site's hostname (e.g. acrodont.example.org)?" "${SITE:-}" '^[A-Za-z0-9.-]+\.[A-Za-z]+$'
  ask bucket "The Terraform state bucket?" "${STATE_BUCKET:-}" '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
  ask region "The state bucket's region?" "${STATE_REGION:-}" '^[a-z]{2}(-[a-z]+)+-[0-9]$'
  ask account "The AWS account id (12 digits)?" "${ACCOUNT:-}" '^[0-9]{12}$'
  (umask 077; cat > "$OPS_ENV_FILE" <<EOF
# acrodont operator settings (scripts/onboard-deployer.sh). Variables already
# set in the environment win over these.
export AWS_PROFILE=$profile
export SITE=$site
export STATE_BUCKET=$bucket
export STATE_REGION=$region
export ACCOUNT=$account
EOF
  )
  ops_say "wrote $OPS_ENV_FILE"
  ops_load_env
fi
ops_require AWS_PROFILE SITE STATE_BUCKET STATE_REGION ACCOUNT
aws configure list-profiles 2>/dev/null | grep -qx "$AWS_PROFILE" \
  || ops_die "no AWS CLI profile $AWS_PROFILE: run  aws configure sso  first (profile name $AWS_PROFILE)"

# 3. The login.
ops_login

# 4. The shared state.
terraform -chdir="$OPS_INFRA" init -input=false \
  -backend-config="bucket=$STATE_BUCKET" \
  -backend-config="key=acrodont/production.tfstate" \
  -backend-config="region=$STATE_REGION" \
  -backend-config="use_lockfile=true" \
  || ops_die "terraform init failed (above)"

# 5. The variables, and 6. the plan that must show nothing.
ops_stack
ops_tfvars_fetch
rc=0
terraform -chdir="$OPS_INFRA" plan -input=false -detailed-exitcode -lock=false "${OPS_VARFILES[@]}" || rc=$?
case $rc in
  0) ops_say "no changes: this machine is ready to deploy (scripts/deploy.sh)" ;;
  2) ops_die "the plan shows changes: stop, and compare with whoever deployed last (an out-of-date main or prod.tfvars, usually)" ;;
  *) ops_die "terraform plan failed (above)" ;;
esac
