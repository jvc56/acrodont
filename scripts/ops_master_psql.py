#!/usr/bin/env python3
"""wordfall-master-psql: psql as the RDS master user, inside an ops task.

RDS keeps the master password in Secrets Manager and rotates it every 7 days,
so it is never in SSM or on an operator's machine. This fetches it at the
moment of use (MASTER_SECRET_ARN, set on the ops task definition) and runs
psql against the same host and database as DATABASE_URL, with every argument
passed through. Used by scripts/init-db-roles.sh and rotate-db-password.sh.
"""

import json
import os
import sys
from urllib.parse import unquote, urlparse


def main() -> int:
    arn = os.environ.get("MASTER_SECRET_ARN")
    url = os.environ.get("DATABASE_URL")
    if not arn or not url:
        sys.exit("wordfall-master-psql: MASTER_SECRET_ARN and DATABASE_URL must be set (run it in an ops task)")
    import boto3

    secret = json.loads(boto3.client("secretsmanager").get_secret_value(SecretId=arn)["SecretString"])
    target = urlparse(url)
    env = dict(os.environ)
    env.update({
        "PGHOST": target.hostname or "",
        "PGPORT": str(target.port or 5432),
        "PGDATABASE": unquote(target.path.lstrip("/")) or "wordfall",
        "PGUSER": secret["username"],
        "PGPASSWORD": secret["password"],
        "PGSSLMODE": "require",
    })
    # The app's URL must not leak into what psql sees as its own connection.
    env.pop("DATABASE_URL", None)
    os.execvpe("psql", ["psql", *sys.argv[1:]], env)
    return 1


if __name__ == "__main__":
    sys.exit(main())
