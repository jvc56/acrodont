#!/usr/bin/env bash
# Confirm a registration by hand (while SES is in the sandbox, or when the
# mail never came), and optionally make the account an admin.
#
#   scripts/confirm-user.sh [--admin] [--print-sql] USERNAME
#
# Runs one batch through scripts/prod-sql.sh, in one transaction. A
# registration waits in pending_registrations until its address is confirmed,
# and only then is there an account: this makes the account from the
# username's latest registration whose code is still valid (24 hours from
# registering; after that, register again), exactly as following its link
# would, and drops the address's other registrations. A username that already
# is an account is left as it is. The username is the user's own text, so it
# travels as hex and Postgres decodes it: no character of it can end a quote.
# Nothing personal is selected (what psql prints stays in CloudWatch): the
# address and the password hash are copied inside the database and never
# returned. Fails when the username is neither an account nor a registration
# still waiting (compared case-insensitively, as the site does). It does not
# apply MAX_ACCOUNTS: an operator confirming by hand has decided.
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

name="convert_from(decode('$hex', 'hex'), 'UTF8')::citext"
if ((admin)); then
  result="UPDATE users SET is_admin = true
 WHERE username = $name
RETURNING username, is_admin;"
else
  result="SELECT username, is_admin FROM users
 WHERE username = $name;"
fi
sql="INSERT INTO users (username, email, password_hash)
SELECT username, email, password_hash FROM pending_registrations
 WHERE username = $name AND expires_at > now()
 ORDER BY created_at DESC, id LIMIT 1
ON CONFLICT DO NOTHING;
DELETE FROM pending_registrations p USING users u
 WHERE u.username = $name AND p.email = u.email;
$result
\\if :ROW_COUNT
\\else
DO \$\$ BEGIN RAISE EXCEPTION 'no account has that username, and no registration still waiting (a registration lasts 24 hours: register again)'; END \$\$;
\\endif
"

if ((print)); then
  printf '%s' "$sql"
  exit 0
fi
exec "$(dirname "$0")/prod-sql.sh" "$sql"
