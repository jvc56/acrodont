# Acrodont runbook

For whoever operates the production instance. It follows PLAN.md § Deployment
and Operations and § Backups. Where this page and the plan disagree, the plan
wins and this page is wrong.

Every multi-step procedure is a script under `scripts/`, tested in CI against
stand-ins for `aws`, `terraform`, `gh` and `docker` (`make ops-check`). Don't
paste commands from memory; run the script. Each script's header says what it
checks and what it changes. `scripts/runbook-check.sh` checks every block on
this page parses.

| Script | What it does |
|---|---|
| `scripts/onboard-deployer.sh` | Sets up a machine to deploy. Changes nothing in AWS |
| `scripts/deploy.sh` | Ships the checked-out commit of `main` |
| `scripts/rollback.sh` | Puts an earlier release back |
| `scripts/set-setting.sh KEY=VALUE` | Changes a Terraform setting through the same plan gate |
| `scripts/prod-sql.sh "SQL"` | Runs one batch of SQL from an ops task inside the VPC |
| `scripts/prod-shell.sh` | Opens a shell in an ops task: psql, pg_restore, restore.py |
| `scripts/confirm-user.sh [--admin] USER` | Confirms an account by hand, and can grant admin |
| `scripts/init-db-roles.sh` | First-time database roles and SSM secrets |
| `scripts/rotate-db-password.sh` | Rotates the app or backup password, or the signing key |
| `scripts/cutover-db.sh DATABASE` | Points the site and the nightly backup at a restored database |
| `scripts/check-alerts.sh` | Proves alarms reach your inbox |

Terraform is the only deployer: `deploy.sh` sets `image_tag` in `prod.tfvars`
and applies. The state therefore always says what is running. The
authoritative `prod.tfvars` lives in the state bucket. The scripts fetch it and
refuse to upload over a copy someone else changed. There is no GitHub Actions
deploy.

## One-time setup

Done once, by an operator with admin access to the AWS account, the domain's
DNS and the GitHub repository.

1. **Tools and login.** Install the AWS CLI, Terraform 1.11 or later (1.16.5 is
   what CI uses), `gh`, Docker, `jq` and the Session Manager plugin. Install
   Terraform from HashiCorp's release zip: their apt repository fails on Ubuntu
   20.04. Then sign in with `aws configure sso`, which gives you a profile name.

2. **The state bucket.** Put it in a region other than the stack's, so losing
   the stack's region does not also lose the state. Versioning is on so a bad
   state write can be undone:

   ```bash
   export AWS_PAGER=""
   aws s3api create-bucket --bucket acrodont-tfstate-ACCOUNT --region us-east-2 \
     --create-bucket-configuration LocationConstraint=us-east-2
   aws s3api put-bucket-versioning --bucket acrodont-tfstate-ACCOUNT \
     --versioning-configuration Status=Enabled
   ```

3. **The first `prod.tfvars`.** Write `infra/prod.tfvars` and upload it to
   `s3://acrodont-tfstate-ACCOUNT/acrodont/prod.tfvars`. Use `image_tag =
   "bootstrap"`, a placeholder `deploy.sh` replaces, and `desired_count = 0`, so
   no task starts before its secrets exist:

   ```text
   domain_name   = "acrodont.example.org"
   alarm_email   = "you@example.org"
   image_tag     = "bootstrap"
   desired_count = 0
   ```

   Check that the database class can be ordered today. Birdtest's first apply
   failed half-way on a class that was not orderable that day:

   ```bash
   export AWS_PAGER=""
   aws rds describe-orderable-db-instance-options --engine postgres --engine-version 16 \
     --db-instance-class db.t4g.micro --query 'OrderableDBInstanceOptions[0].DBInstanceClass'
   ```

   If it prints `null`, set `db_instance_class = "db.t3.micro"`.

4. **Onboard.** Run `scripts/onboard-deployer.sh`. It writes `~/.acrodont-env`,
   initialises Terraform against the state bucket and fetches `prod.tfvars`.
   On the very first setup its closing plan reports changes, because nothing
   exists yet. That is expected; carry on.

5. **The first apply.** Run `terraform -chdir=infra apply -var-file=prod.tfvars`.
   It waits on certificate validation, so create the DNS records in step 6
   while it waits.

6. **DNS**, from `terraform -chdir=infra output`:
   - `acm_validation_records`: the CNAMEs that validate the certificate.
   - `ses_dns_records`: three DKIM CNAMEs, the `mail.` MX and SPF TXT for the
     MAIL FROM domain, and a `_dmarc` TXT.
   - The domain itself: an alias (or CNAME) to `alb_dns_name`.

7. **Confirm the alarm subscription.** SNS mails `alarm_email` a confirmation
   link. Until it is clicked, every alarm goes nowhere.

8. **The anomaly monitor.** An account allows only one AWS-services cost
   monitor, and new accounts often have one already. If the first apply failed
   on `aws_ce_anomaly_monitor`, find the existing monitor's ARN, set it with
   `scripts/set-setting.sh anomaly_monitor_arn=ARN`, and apply again:

   ```bash
   export AWS_PAGER=""
   aws ce get-anomaly-monitors --query 'AnomalyMonitors[].[MonitorArn,MonitorName,MonitorType]'
   ```

   If the account is shared with other projects, set `cost_scope = "tag"`. First
   activate the `Project` cost allocation tag in Billing, so the budget and the
   monitor count only acrodont's resources.

9. **Database roles and secrets.** Run `scripts/init-db-roles.sh`. It creates
   the three SSM parameters if they don't exist yet (it never overwrites one).
   Then, as the RDS master user, it creates the `acrodont_app` and
   `acrodont_backup` roles from those values. Terraform never sees a secret.

10. **The first release.** Run `scripts/deploy.sh`. It builds and pushes the
    backend, ops and frontend images, sets `image_tag` and applies. Then start
    the service, and pin the zones the first apply chose (a subnet cannot
    change zone later):

    ```bash
    scripts/set-setting.sh desired_count=1
    scripts/set-setting.sh 'azs=["us-east-1a","us-east-1b"]'
    ```

    Use the zones `terraform -chdir=infra output azs` prints.

11. **Prove the alarms work.** Run `scripts/check-alerts.sh` and expect an ALARM
    mail, then an OK mail.

12. **SES production access.** A new account's SES only sends to verified
    addresses. Request production access for the region (type
    "Transactional"; mention the suppression list and the bounce and complaint
    alarms). It took birdtest about a day. **Don't announce the site until it is
    granted.** Until then, confirmation mail reaches no one else. Once granted,
    raise the send rate to the account's rate, usually 14:

    ```bash
    scripts/set-setting.sh mail_max_per_second=14
    ```

13. **The first admin and the first catalog.** Register through the site, then
    confirm and promote yourself (the mail may not arrive while SES is in the
    sandbox):

    ```bash
    scripts/confirm-user.sh --admin YOUR_NAME
    ```

    Upload the licensed catalog at `/admin` from your own files:
    distributions, then lexicons, then leave values. They are stored only as
    rows. Later corrections need no new lexicon: **Replace definitions** and
    **Replace values** on `/admin` take the same file with new definitions,
    or new leave values, and every cascade then shows them. Then compare the in-memory index sizes `/admin` shows (hover a
    lexicon's or leave value set's Storage) with `task_memory` (2 GiB by
    default). The `acrodont-backend-memory-high` alarm watches this from now
    on.

## Deploying

```bash
scripts/deploy.sh
```

Run it from a clean checkout of `main` once CI's run on `main` is green on
that commit (a branch's run of the same commit is only the Push tier, which
does not count). It refuses otherwise; `--skip-ci-check` exists for
emergencies. In order, it:

1. checks the checkout, the AWS login and account, and that ECS is running what
   `prod.tfvars` names. If ECS's circuit breaker rolled a release back, the
   two disagree, and it tells you to run `scripts/rollback.sh` first;
2. refuses any change under `backend/migrations/` that is not an added file
   (see below);
3. builds and pushes only the images ECR lacks, tagged with the commit;
4. sets `image_tag`, then runs the **plan gate**: the plan must not delete or
   replace the database, a bucket, the network, a KMS key or an ECR repository.
   The override is `ACRODONT_ALLOW_DESTRUCTIVE_PLAN=yes` plus typing `destroy`;
5. applies the saved plan;
6. waits for the rollout. The running task must have the new image **and** the
   applied CPU and memory, because a circuit-breaker rollback of a CPU change
   would otherwise still look deployed. It then waits for healthy targets and
   checks `/health`.

A docs-only commit deploys nothing. `infra/` changes plan and apply without
building. The service rolls: the new task serves before the old one drains,
so a deploy has no gap. A warning means the last nightly CI run (the Main
tier and the scale suite) failed.

**Migrations are append-only and additive.** Never edit or remove an applied
migration. Add a numbered file instead.
- Additive changes are new tables, nullable or defaulted columns, and indexes.
- Drops and renames wait a release.
- A new enum or CHECK value is **not** additive: ship the code that reads it one
  release before the code that writes it.
- The backend runs its migrator with `ignore_missing`, so the previous image
  starts on the newer schema. That is what makes a rollback possible.

**Sync compatibility.** A sync API change must stay compatible with the
previous app version for at least `SYNC_RETENTION_DAYS` (30). Devices can be
offline that long. To retire old builds, raise `min_app_version` with
`scripts/set-setting.sh`. Devices below it get `426` after their operations
are applied, and they offer "reload to keep syncing".

Settings are changed the same way:

```bash
scripts/set-setting.sh task_cpu=1024 task_memory=4096
```

## Rolling back

```bash
scripts/rollback.sh
```

By default it targets what ECS already rolled back to, if the circuit breaker
acted. Otherwise it offers the previous release in ECR. `--to TAG` names one.
It builds nothing, because ECR's tags are immutable, so the images are still
there. It refuses a target whose migrations were edited, and asks before
running an older image on a schema with newer (additive) migrations. Then it
ships through the same plan gate.

**A `acrodont deploy FAILED` mail** means ECS's circuit breaker rolled a
release back. Terraform's state still names the failed release, so run
`scripts/rollback.sh` before any other apply. The stopped tasks and the log
group say why the release failed.

## Running SQL in production

The database has no public address. SQL runs from an ops task inside the VPC:

```bash
scripts/prod-sql.sh "SELECT count(*) FROM users"
scripts/prod-shell.sh
```

The SQL travels as an environment override that AWS keeps in the task's
record, and psql's output stays in CloudWatch Logs for 30 days. So **never
select personal columns** (email, password_hash, tokens), and never put a
secret in the SQL. `--as-master` runs as the RDS master user, whose password
RDS keeps and rotates in Secrets Manager. A shell task stops itself after 4
hours, and leaving the shell does not stop it. ECS Exec sessions are not
logged.

Granting admin, or confirming an account while SES is in the sandbox:

```bash
scripts/confirm-user.sh --admin USERNAME
```

## Rotating secrets

```bash
scripts/rotate-db-password.sh
```

- No option: the app role. `--backup`: the dump's role. `--signing-key`: the
  session key, which signs everyone out.
- The new value goes to SSM first, then the role's password is set from it by
  an ops task, so the password never passes through the operator's machine or
  a log.
- `--resume` finishes an interrupted run without making a new password.
- The RDS master password needs nothing: RDS rotates it.

## Alarms

All alarms go to the `acrodont-alarms` SNS topic and on to `alarm_email`.

| Alarm | Means | First step |
|---|---|---|
| `acrodont-down` | No healthy target for 10 minutes | The service's events and the newest stopped task's reason. A Spot interruption replaces the task within minutes; if Spot capacity cannot place one, `scripts/set-setting.sh use_fargate_spot=false` |
| `acrodont-api-5xx` | The load balancer answered 5xx for 15 minutes | The log group, `level = ERROR` |
| `acrodont-backend-cpu-high` | Over 85% CPU for 15 minutes | Searches or exports? Consider `task_cpu=1024` (and `search_concurrency`) |
| `acrodont-backend-memory-high` | Over 85% memory for 10 minutes | The in-memory index sizes in `/admin` (hover each Storage) against `task_memory`; raise it |
| `acrodont-db-cpu-high` | Database over 80% CPU for 15 minutes | Raise `db_instance_class`; the change applies at once with a short restart |
| `acrodont-db-events` (RDS events) | Low storage, failure, or allocation near the autoscaling ceiling | Raise `db_allocated_storage` |
| `acrodont-no-dump-36h` | No successful dump in 36 hours | The last `backup` log stream; the `acrodont-backup-failed` mail says why |
| `acrodont-dump-shrank` | A dump at least 30% smaller than the one before | Check the database size first. A truncated run leaves a small object |
| `acrodont-backup-failed`, `acrodont-drill-failed` | The task exited non-zero | Its log stream, named in the mail |
| `acrodont-deploy-failed` | ECS rolled a release back | `scripts/rollback.sh` (above) |
| `acrodont-sync-error-rejection` | A sync operation rejected as `error`: a database error the rules did not expect | Find `sync operation failed with a database error` in the logs |
| `acrodont-ses-bounce-rate`, `-complaint-rate` | Nearing the rate at which SES pauses sending | Who is registering with bad addresses? Bounced addresses are suppressed automatically |
| `acrodont-mail-failed` | An account mail failed to send | The log line has SES's reason |
| Budget, cost anomaly | Spending above 85% of `monthly_budget_usd`, or an anomaly of `anomaly_threshold_usd` or more | Cost Explorer, by service |

The `acrodont-sync` dashboard graphs sync rejections by type and reason. Some
reasons are what ordinary two-device use produces:
- `stale_attempt`, `stale`, `not_active` and `not_deepest`;
- `not_found`, when it follows one of those in the same batch.

A rise in any other reason points to a divergence between the Rust and
TypeScript rules.

## What it costs

The stack is sized for one user at first and 750 accounts at most (`MAX_ACCOUNTS`), each
holding at most 10 MB (`MAX_STORAGE_BYTES_PER_USER`). Approximate us-east-1 prices:

| Item | Monthly |
|---|---|
| App task, 0.5 vCPU and 2 GiB on Fargate Spot (~$21 on demand) | ~$7 |
| Load balancer | ~$18 |
| Public IPv4: the load balancer's two and the task's one | ~$11 |
| RDS `db.t4g.micro`, 20 GiB gp3, 7-day point-in-time recovery | ~$14 |
| Logs, alarms past the free ten, ECR, S3 backups, the master secret | ~$3 |
| **Total** | **~$53** (~$67 with `use_fargate_spot=false`) |

The domain's registration is extra. `monthly_budget_usd` defaults to 70.

## Backups

| What | Where | Kept |
|---|---|---|
| RDS automated backups, point in time | RDS, same region | 7 days (`db_backup_retention_days`) |
| Nightly `pg_dump --format=custom` and `--schema-only` | `s3://acrodont-production-backups-<account>/daily/YYYY-MM-DD.*`, second region, versioned, object-locked | 90 days |
| The first-of-month dump | `…/monthly/YYYY-MM.*` | a year |

The dump runs at 03:15 UTC as the `acrodont-backup` task: `scripts/backup.py`
on the ops image, with the read-only `acrodont_backup` role. It reports
`Acrodont/Backups` metrics `DumpSucceeded`, `DumpBytes` and `DumpSizeRatio`.
The backup role can write dumps but read only the daily dump it copies to
`monthly/`. The drill role can only read. No role may bypass the object lock.

## Restoring

1. **Restore into a new database on the live instance, never over the live
   one.** The new database must be **owned by `acrodont_app` and restored as
   that role**. One the master user makes is one the app role cannot create
   in (the restore stops at its first statement), and one the master user
   restores is one the app can neither read nor migrate. Both routes run in
   `scripts/prod-shell.sh`, whose `DATABASE_URL` is the app role's.
   - **From a nightly dump** (`BUCKET` is the `backups_bucket` output, `DAY`
     the dump's date):

     ```bash
     acrodont-master-psql -c 'CREATE DATABASE acrodont_restored OWNER acrodont_app'
     NEW_URL=$(python3 -c 'import os, urllib.parse as u
     print(u.urlsplit(os.environ["DATABASE_URL"])._replace(path="/acrodont_restored").geturl())')
     python3 /opt/acrodont/scripts/restore.py s3://BUCKET/daily/DAY.dump \
       --s3-region us-west-2 --database-url "$NEW_URL"
     ```

   - **From point-in-time recovery:** restore the RDS instance to a new,
     temporary identifier, **in the `acrodont` DB subnet group and with the
     `acrodont-db` security group**: without both, nothing in the VPC can
     reach it. Then copy it into a new database on the live instance, as a
     dump would be. The temporary instance has the roles and passwords of its
     restore point, so `DATABASE_URL`'s work on it unless the app password was
     rotated since. `TEMP_HOST` is its endpoint:

     ```bash
     acrodont-master-psql -c 'CREATE DATABASE acrodont_restored OWNER acrodont_app'
     NEW_URL=$(python3 -c 'import os, urllib.parse as u
     print(u.urlsplit(os.environ["DATABASE_URL"])._replace(path="/acrodont_restored").geturl())')
     TEMP_URL=$(HOST=TEMP_HOST python3 -c 'import os, urllib.parse as u
     p = u.urlsplit(os.environ["DATABASE_URL"])
     print(p._replace(netloc=p.netloc.rsplit("@", 1)[0] + "@" + os.environ["HOST"] + ":5432").geturl())')
     pg_dump --dbname "$TEMP_URL" --format=custom --file /tmp/pitr.dump
     python3 /opt/acrodont/scripts/restore.py /tmp/pitr.dump --database-url "$NEW_URL"
     ```

     Delete the temporary instance once the cutover has held. Terraform never
     knew it.
2. **Check it before any cutover.** Restore a copy locally with
   `./scripts/dev.py --restore DUMP`. It is scrubbed (every address replaced,
   every password the dev password) and the sequences are bumped. Then open a
   few cascades. `/health` stays not-ready until every catalog index is built
   from the rows. Nothing has to be re-uploaded.
3. **The resync step.** `restore.py` does this every time, and on its own with
   `--bump-only`. It sets every user's `sync_seq` and `sync_floor_seq` to
   `sync_seq + 2^32`. Every device's next sync then answers `resync_required`
   and rebuilds from the server, pushing its unsent operations with that
   pull. It is easy to forget and impossible to skip: without it, a
   device that synced after the restore point would silently ignore rows it
   should pull.
4. **Cut over**, from your own machine:

   ```bash
   scripts/cutover-db.sh acrodont_restored
   ```

   It first checks, as the app role, that the database is owned by that role
   and holds the schema, and changes nothing otherwise. Then it points
   **both** `DATABASE_URL` and `BACKUP_DATABASE_URL` at it (repointing the
   app alone leaves the nightly dump reading the abandoned database and
   reporting success), restarts the service and checks the site. Run with
   the old name, it goes back. Tell users what was lost: work pushed after
   the restore point that lived only on the server. Anything still in a
   device's outbox is pushed again and survives. The old database stays
   until you drop it.

## The drill

**Monthly, automatically.** On the 1st at 05:00 UTC, the `acrodont-drill` task
(`scripts/drill.py`) restores the newest nightly dump into a Postgres started
inside its own task, never on production. It then checks:
- every table the schema-only dump names is present;
- migrations are recorded;
- every cascade has its questions;
- the sequence bump forces a resync.

It reports `DrillSucceeded` and `DrillSeconds`. A failure mails
`acrodont-drill-failed`.

**Quarterly, by hand**, the part a machine cannot do:

1. Restore the latest dump locally with `./scripts/dev.py --restore DUMP`, but
   first sign a second browser profile in to the local stack. Its cursor must be
   ahead of the restored server, with unsent grades in its outbox.
2. After the restore, reconnect that profile and check three things: the grades
   were applied, the device resynced rather than diverging, and no operation was
   rejected as `invalid`.
3. Record the date and the drill's `DrillSeconds` below.

| Date | Dump | Restore time | By | Notes |
|---|---|---|---|---|
| | | | | |

## Locally

`./scripts/dev.py --snapshot NAME` saves the development stack's database, and
`./scripts/dev.py --restore NAME` puts it back. Do this before a risky
migration edit. A restore goes into a new database and is swapped in with both
renames in one transaction, so a failed restore leaves the stack as it was. A
production dump is always scrubbed (`scripts/scrub.sql`).
