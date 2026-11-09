#!/usr/bin/env bash
# Confirm an account's email address by hand (while SES is in the sandbox),
# and optionally make it an admin.
#
#   scripts/confirm-user.sh [--admin] [--print-sql] USERNAME
#
# Runs one UPDATE through scripts/prod-sql.sh; an address already confirmed
# keeps its time. The username is the user's own text, so it travels as hex
# and Postgres decodes it: no character of it can end a quote. Nothing
# personal is selected (what psql prints stays in CloudWatch). Fails when no
# account has the username (compared case-insensitively, as the site does).
# --admin: sign out and in again to see the admin pages. --print-sql prints
# the SQL instead of running it.
set -euo pipefail

usage() { sed -n '5p' "$0" >&2; exit 2; }

admin=0 print=0 username=""
while (($#)); do
  case $1 in
    --admin) admin=1 ;;
    --print-sql) print=1 ;;
    --) shift; [[ $# == 1 ]] || usage; username=$1; break ;;
    -*) usage ;;
    *) [[ -z "$username" ]] || usage; username=$1 ;;
  esac
  shift
done
[[ -n "$username" ]] || usage
((${#username} <= 128)) || { echo "$0: not a username: too long" >&2; exit 2; }

hex=$(printf '%s' "$username" | od -An -v -tx1 | tr -d ' \n')
[[ "$hex" =~ ^([0-9a-f]{2})+$ ]] || { echo "$0: could not encode the username" >&2; exit 1; }

set_admin=""
((admin == 0)) || set_admin=", is_admin = true"
sql="UPDATE users
   SET email_confirmed_at = coalesce(email_confirmed_at, now())$set_admin
 WHERE username = convert_from(decode('$hex', 'hex'), 'UTF8')::citext
RETURNING username, is_admin, (email_confirmed_at IS NOT NULL) AS confirmed;
\\if :ROW_COUNT
\\else
DO \$\$ BEGIN RAISE EXCEPTION 'no account has that username'; END \$\$;
\\endif
"

if ((print)); then
  printf '%s' "$sql"
  exit 0
fi
exec "$(dirname "$0")/prod-sql.sh" "$sql"
