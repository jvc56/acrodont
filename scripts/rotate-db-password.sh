#!/usr/bin/env bash
# Rotate a database role's password, or the session signing key.
#
#   scripts/rotate-db-password.sh [--backup] [--signing-key] [--resume]
#
# With no option: the app role acrodont_app (DATABASE_URL). --backup: the
# backup role acrodont_backup (BACKUP_DATABASE_URL) instead; --signing-key:
# SESSION_SIGNING_KEY instead (signs everyone out). Options combine.
#
# A password is written to SSM FIRST, then set on the role by a master ops
# task that reads it from its own injected URL -- so it never travels in an
# override, a log or this shell's arguments, and is never only in this shell.
# If anything stops it part-way, the site fails new database connections until
#   scripts/rotate-db-password.sh [--backup] --resume
# sets the role's password from what SSM holds (it never makes a new one).
# The service restarts after an app-password or signing-key change, so its
# tasks read the new value; the backup and drill tasks read it at each run.
# Run it at a quiet moment.
set -euo pipefail
# shellcheck source=scripts/lib/ops.sh
source "$(dirname "$0")/lib/ops.sh"

usage() { sed -n '4p' "$0" >&2; exit 2; }
backup=0 signing=0 resume=0
while (($#)); do
  case $1 in
    --backup) backup=1 ;;
    --signing-key) signing=1 ;;
    --resume) resume=1 ;;
    *) usage ;;
  esac
  shift
done
app=1
((backup == 0 && signing == 0)) || app=0
((resume == 0 || app || backup)) || ops_die "--resume is for a password rotation; a signing key is simply rotated again"

ops_init
ops_need aws terraform jq python3 curl
ops_load_env
ops_login
ops_stack

roles=()
((app == 0)) || roles+=("DATABASE_URL acrodont_app")
((backup == 0)) || roles+=("BACKUP_DATABASE_URL acrodont_backup")

get_param() {
  aws ssm get-parameter --name "$OPS_SSM_PREFIX/$1" --with-decryption --query Parameter.Value --output text
}
put_param() {  # name, value: through a file, so the value is not in argv
  local f=$OPS_TMP/param
  (umask 077; printf '%s' "$2" > "$f")
  aws ssm put-parameter --name "$OPS_SSM_PREFIX/$1" --type SecureString --overwrite \
    --value "file://$f" >/dev/null
  rm -f "$f"
}
# shellcheck disable=SC2016
url_user() { URL=$1 python3 -c 'import os, urllib.parse as u; print(u.unquote(u.urlsplit(os.environ["URL"]).username or ""))'; }

what=""
for r in ${roles[@]+"${roles[@]}"}; do what+=" the ${r#* } password,"; done
((signing == 0)) || what+=" the session signing key (EVERYONE IS SIGNED OUT),"
if ((resume)); then
  ops_say "re-applying from SSM:${what%,}"
else
  ops_say "rotating:${what%,}"
fi
((app == 0 && signing == 0)) || ops_say "the service restarts; between the SSM write and the restart, new app connections fail"
ops_confirm "Go on?" || ops_die "nothing changed"

resume_cmd="scripts/rotate-db-password.sh --resume"
((backup == 0)) || resume_cmd="scripts/rotate-db-password.sh --backup --resume"
restart=0
for r in ${roles[@]+"${roles[@]}"}; do
  var=${r%% *} role=${r#* } url=""
  url=$(get_param "$var") || ops_die "could not read $OPS_SSM_PREFIX/$var"
  [[ "$(url_user "$url")" == "$role" ]] || ops_die "$OPS_SSM_PREFIX/$var's user is not $role"
  if ((resume == 0)); then
    # Hex: nothing to percent-encode.
    # shellcheck disable=SC2016
    new_url=$(URL=$url python3 -c 'import os, secrets, urllib.parse as u
p = u.urlsplit(os.environ["URL"])
userinfo, host = p.netloc.rsplit("@", 1)
print(p._replace(netloc=userinfo.split(":", 1)[0] + ":" + secrets.token_hex(24) + "@" + host).geturl())')
    trap 'rm -rf "$OPS_TMP"; ops_say "STOPPED PART-WAY: SSM may hold a password the role does not have. Finish with  $resume_cmd"' EXIT
    put_param "$var" "$new_url"
    unset new_url
    ops_say "$OPS_SSM_PREFIX/$var written"
  fi
  unset url
  # The task's own injected URL carries the password; VERBOSITY terse keeps
  # the statement text out of any error message.
  script="set -euo pipefail
$(ops_url_parts_snippet "$var")
[ \"\$WF_U\" = $role ] || { echo \"$var's user is \$WF_U, not $role\" >&2; exit 4; }
[ -n \"\$WF_P\" ] || { echo \"$var has no password\" >&2; exit 4; }
acrodont-master-psql -X -q -v ON_ERROR_STOP=1 <<'SQL'
\\set VERBOSITY terse
\\set SHOW_CONTEXT never
\\getenv u WF_U
\\getenv p WF_P
ALTER ROLE :\"u\" PASSWORD :'p';
SQL
echo \"password of $role set from $var\""
  rc=0
  ops_run_ops_script "$script" || rc=$?
  ((rc == 0)) || ops_die "setting $role's password failed (exit $rc). SSM holds the new one: fix the cause, then run this again with --resume"
  [[ "$var" != DATABASE_URL ]] || restart=1
done

if ((signing)); then
  # shellcheck disable=SC2016
  put_param SESSION_SIGNING_KEY "$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  ops_say "$OPS_SSM_PREFIX/SESSION_SIGNING_KEY written: every session ends at the restart"
  restart=1
fi

if ((restart)); then
  live=$(ops_live_release) || ops_die "cannot read what the service runs"
  aws ecs update-service --cluster "$OPS_CLUSTER" --service "$OPS_SERVICE" --force-new-deployment \
    --query 'service.serviceName' --output text >/dev/null
  ops_say "the service is restarting to read the new value"
  trap 'rm -rf "$OPS_TMP"' EXIT
  if [[ "$(ops_desired_count)" != 0 ]]; then
    ops_wait_release "${live%% *}" "${live#* }"
    ops_check_site
  fi
fi
trap 'rm -rf "$OPS_TMP"' EXIT
ops_say "done"
