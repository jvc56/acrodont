#!/usr/bin/env bash
# Point the site and the nightly backup at another database on the same
# instance: the cutover that ends a restore (docs/runbook.md, Restoring).
#
#   scripts/cutover-db.sh DATABASE
#
# DATABASE_URL and BACKUP_DATABASE_URL both come to name DATABASE; nothing
# else in either changes. Repointing the app alone would leave the nightly
# dump reading the abandoned database and reporting success.
#
# Before anything is written, an ops task connects to DATABASE as the app
# role and refuses unless that role owns it and can read its users table: a
# database made or restored by the master user is one the app can neither
# read nor migrate. The service then restarts to read the new value, and the
# site is checked. To go back, run it again with the old name.
set -euo pipefail
# shellcheck source=scripts/lib/ops.sh
source "$(dirname "$0")/lib/ops.sh"

usage() { sed -n '5p' "$0" >&2; exit 2; }
[[ $# == 1 ]] || usage
db=$1
[[ "$db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || ops_die "a database name is lower-case letters, digits and underscores"

ops_init
ops_need aws terraform jq python3 curl
ops_load_env
ops_login
ops_stack

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
url_part() {  # url, part (username or path)
  URL=$1 PART=$2 python3 -c 'import os, urllib.parse as u
p = u.urlsplit(os.environ["URL"])
print(u.unquote(p.username or "") if os.environ["PART"] == "username" else p.path.lstrip("/"))'
}
# shellcheck disable=SC2016
url_with_db() {  # url, database
  URL=$1 DB=$2 python3 -c 'import os, urllib.parse as u
print(u.urlsplit(os.environ["URL"])._replace(path="/" + os.environ["DB"]).geturl())'
}

app_url=$(get_param DATABASE_URL) || ops_die "could not read $OPS_SSM_PREFIX/DATABASE_URL"
backup_url=$(get_param BACKUP_DATABASE_URL) || ops_die "could not read $OPS_SSM_PREFIX/BACKUP_DATABASE_URL"
[[ "$(url_part "$app_url" username)" == acrodont_app ]] || ops_die "$OPS_SSM_PREFIX/DATABASE_URL's user is not acrodont_app"
[[ "$(url_part "$backup_url" username)" == acrodont_backup ]] || ops_die "$OPS_SSM_PREFIX/BACKUP_DATABASE_URL's user is not acrodont_backup"
from=$(url_part "$app_url" path)
backup_from=$(url_part "$backup_url" path)
if [[ "$from" == "$db" && "$backup_from" == "$db" ]]; then
  ops_say "the site and the backup already use $db: nothing to do"
  exit 0
fi

# The task's own injected URL carries the password; only the name travels.
script="set -euo pipefail
$(ops_url_parts_snippet DATABASE_URL)
[ \"\$WF_U\" = acrodont_app ] || { echo \"DATABASE_URL's user is \$WF_U, not acrodont_app\" >&2; exit 4; }
export WF_DB=$db
export PGHOST=\$(python3 -c 'import os, urllib.parse as u; print(u.urlsplit(os.environ[\"DATABASE_URL\"]).hostname)')
export PGPORT=\$(python3 -c 'import os, urllib.parse as u; print(u.urlsplit(os.environ[\"DATABASE_URL\"]).port or 5432)')
export PGUSER=\$WF_U PGPASSWORD=\$WF_P PGDATABASE=\$WF_DB PGSSLMODE=require
unset WF_P
psql -X -q -At -v ON_ERROR_STOP=1 -f - <<'SQL'
\\set VERBOSITY terse
DO \$\$
BEGIN
  IF (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) <> current_user THEN
    RAISE EXCEPTION 'database % is not owned by %: create it with OWNER % and restore into it as that role',
      current_database(), current_user, current_user;
  END IF;
  IF NOT has_schema_privilege('public', 'CREATE') THEN
    RAISE EXCEPTION '% cannot create in schema public of %: it could not migrate', current_user, current_database();
  END IF;
END \$\$;
SELECT 'accounts: ' || count(*) FROM users;
SELECT 'migrations: ' || count(*) FROM _sqlx_migrations;
SQL"
rc=0
ops_run_ops_script "$script" || rc=$?
((rc == 0)) || ops_die "$db is not a database the app can use (exit $rc): nothing changed"

ops_say "the site moves from $from to $db, and the nightly backup from $backup_from to $db"
ops_say "the service restarts; work synced to $from after the restore point is not in $db"
ops_confirm "Cut over to $db?" || ops_die "nothing changed"

trap 'rm -rf "$OPS_TMP"; ops_say "STOPPED PART-WAY: run  scripts/cutover-db.sh $db  again to finish, or with $from to go back"' EXIT
put_param DATABASE_URL "$(url_with_db "$app_url" "$db")"
ops_say "$OPS_SSM_PREFIX/DATABASE_URL written"
put_param BACKUP_DATABASE_URL "$(url_with_db "$backup_url" "$db")"
ops_say "$OPS_SSM_PREFIX/BACKUP_DATABASE_URL written"
unset app_url backup_url

live=$(ops_live_release) || ops_die "cannot read what the service runs"
aws ecs update-service --cluster "$OPS_CLUSTER" --service "$OPS_SERVICE" --force-new-deployment \
  --query 'service.serviceName' --output text >/dev/null
ops_say "the service is restarting to read the new value"
trap 'rm -rf "$OPS_TMP"' EXIT
if [[ "$(ops_desired_count)" != 0 ]]; then
  ops_wait_release "${live%% *}" "${live#* }"
  ops_check_site
fi
ops_say "done: the site and tonight's dump use $db. $from is untouched; drop it once you are sure"
