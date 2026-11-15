#!/usr/bin/env bash
# First-time database setup: after the first apply (desired_count = 0) and
# the first scripts/deploy.sh, which builds the ops image this runs its task
# on, and before the service is scaled up.
#
#   scripts/init-db-roles.sh
#
#   1. puts the SSM parameters that do not exist yet -- never overwrites one:
#        /acrodont/production/DATABASE_URL         acrodont_app, new password
#        /acrodont/production/BACKUP_DATABASE_URL  acrodont_backup, new password
#        /acrodont/production/SESSION_SIGNING_KEY  64 hex characters
#      (the database host from the RDS instance named by db_identifier);
#   2. runs a master ops task that creates the roles, or sets their passwords
#      if they exist, from the task's own injected URLs (no password travels
#      in an override or a log): acrodont_app (LOGIN, owner of schema public,
#      ALL on the database) and acrodont_backup (LOGIN, pg_read_all_data).
# Safe to run again.
set -euo pipefail
# shellcheck source=scripts/lib/ops.sh
source "$(dirname "$0")/lib/ops.sh"

[[ $# == 0 ]] || { sed -n '5p' "$0" >&2; exit 2; }

ops_init
ops_need aws terraform jq python3
ops_load_env
ops_login
ops_stack

ident=$(ops_out -raw db_identifier)
endpoint=$(aws rds describe-db-instances --db-instance-identifier "$ident" --output json \
  | jq -r '.DBInstances[0].Endpoint | "\(.Address):\(.Port // 5432)"') \
  || ops_die "no RDS instance $ident"
[[ "$endpoint" =~ ^[A-Za-z0-9.-]+:[0-9]+$ ]] || ops_die "the instance $ident has no endpoint yet ($endpoint)"

# 0 exists, 1 missing; anything else stops.
param_exists() {
  local err=$OPS_TMP/ssm.err
  if aws ssm get-parameter --name "$OPS_SSM_PREFIX/$1" --query Parameter.Name --output text >/dev/null 2>"$err"; then
    return 0
  fi
  grep -q ParameterNotFound "$err" && return 1
  cat "$err" >&2
  ops_die "could not read $OPS_SSM_PREFIX/$1"
}
put_new() {  # name, value: through a file, so the value is not in argv
  local f=$OPS_TMP/param
  (umask 077; printf '%s' "$2" > "$f")
  aws ssm put-parameter --name "$OPS_SSM_PREFIX/$1" --type SecureString --value "file://$f" >/dev/null \
    || ops_die "could not put $OPS_SSM_PREFIX/$1"
  rm -f "$f"
  ops_say "$OPS_SSM_PREFIX/$1 created"
}
hex() { python3 -c "import secrets; print(secrets.token_hex($1))"; }

for var in DATABASE_URL BACKUP_DATABASE_URL SESSION_SIGNING_KEY; do
  if param_exists "$var"; then
    ops_say "$OPS_SSM_PREFIX/$var exists: left as it is"
    continue
  fi
  case $var in
    DATABASE_URL) put_new "$var" "postgres://acrodont_app:$(hex 24)@$endpoint/acrodont?sslmode=require" ;;
    BACKUP_DATABASE_URL) put_new "$var" "postgres://acrodont_backup:$(hex 24)@$endpoint/acrodont?sslmode=require" ;;
    SESSION_SIGNING_KEY) put_new "$var" "$(hex 32)" ;;
  esac
done

script="set -euo pipefail
$(ops_url_parts_snippet DATABASE_URL)
export APP_U=\$WF_U APP_P=\$WF_P APP_DB=\$WF_DB
$(ops_url_parts_snippet BACKUP_DATABASE_URL)
export BK_U=\$WF_U BK_P=\$WF_P
unset WF_P
[ \"\$APP_U\" = acrodont_app ] || { echo \"DATABASE_URL's user is \$APP_U, not acrodont_app\" >&2; exit 4; }
[ \"\$BK_U\" = acrodont_backup ] || { echo \"BACKUP_DATABASE_URL's user is \$BK_U, not acrodont_backup\" >&2; exit 4; }
[ -n \"\$APP_P\" ] && [ -n \"\$BK_P\" ] || { echo 'a URL has no password' >&2; exit 4; }
acrodont-master-psql -X -q -v ON_ERROR_STOP=1 --single-transaction -f - <<'SQL'
\\set VERBOSITY terse
\\set SHOW_CONTEXT never
\\getenv app_u APP_U
\\getenv app_p APP_P
\\getenv app_db APP_DB
\\getenv bk_u BK_U
\\getenv bk_p BK_P
SELECT format(CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_u')
                   THEN 'ALTER ROLE %I WITH LOGIN PASSWORD %L'
                   ELSE 'CREATE ROLE %I WITH LOGIN PASSWORD %L' END, :'app_u', :'app_p') \\gexec
SELECT format(CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'bk_u')
                   THEN 'ALTER ROLE %I WITH LOGIN PASSWORD %L'
                   ELSE 'CREATE ROLE %I WITH LOGIN PASSWORD %L' END, :'bk_u', :'bk_p') \\gexec
-- Postgres 16: handing a schema to a role needs membership in it.
GRANT :\"app_u\" TO CURRENT_USER;
GRANT ALL ON DATABASE :\"app_db\" TO :\"app_u\";
ALTER SCHEMA public OWNER TO :\"app_u\";
GRANT pg_read_all_data TO :\"bk_u\";
SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN (:'app_u', :'bk_u') ORDER BY rolname;
SQL"
rc=0
ops_run_ops_script "$script" || rc=$?
((rc == 0)) || ops_die "creating the roles failed (exit $rc): the SSM parameters stay; fix the cause and run this again"
ops_say "roles ready. Next (docs/runbook.md): scripts/set-setting.sh desired_count=1"
