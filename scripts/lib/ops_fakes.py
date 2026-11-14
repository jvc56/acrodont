#!/usr/bin/env python3
"""Stand-ins for aws, terraform, gh, docker, curl and session-manager-plugin,
for scripts/ops-scripts-check.sh: the operator scripts run against these,
never against AWS. Installed as symlinks named after each tool. Python 3.8.

State, under FAKE_DIR:
  calls.log            one line per call, in order ("aws ecs run-task ...")
  s3/<bucket>/<key>    objects for `aws s3 cp`
  ecr/<repo>/<tag>     images ECR holds; the file holds imagePushedAt
  ecs/running.json     what the service runs: {"tag", "cpu", "memory"}
  ecs/desired          the service's desired count (default 1)
  runtask/<n>.json     each run-task: {"overrides", "exec", "network", "env"}
  tasks/<n>.json       each task: {"status", "exit", "output", "reason"}
  psql/<n>.{args,stdin,env}  what the stub psql inside a task was given
  ssm/<name>           parameter values ("/" in the name as "_")
  alarm/<name>         an alarm's state
  plan.json            the resource_changes `terraform show -json` prints

A one-off ops task (no --enable-execute-command) really runs its command,
here, with the environment ECS would give it: the overrides, and
DATABASE_URL / BACKUP_DATABASE_URL from the fake SSM (a missing parameter
stops the task before its container starts, as ECS does). `psql` and
`acrodont-master-psql` inside it are stubs that record what they get.

Switches, from the environment: FAKE_STS_FAIL, FAKE_ACCOUNT, FAKE_PLAN_RC (2),
FAKE_APPLY_RC (0), FAKE_APPLY_TOUCH_S3 (another deployer uploads prod.tfvars
during the apply), FAKE_ROLLBACK (the circuit breaker keeps the old task
definition), FAKE_CI / FAKE_CI_SCHEDULED ("completed success", or "none"),
FAKE_TASK_EXIT (overrides a one-off task's exit code), FAKE_PSQL_EXIT,
FAKE_RUN_TASK_FAIL ("error": run-task itself fails, as with an expired
sign-in; "capacity": it answers with no task and a failure),
FAKE_TG_FAIL_ROUNDS (target-in-service waits that time out first),
FAKE_CURL_FAIL, FAKE_SNS_PENDING, FAKE_RDS_SUB_STATUS (active),
FAKE_RULE_BROKEN (a rule whose pattern matches every ECS event),
FAKE_SETTLE_POLLS (describe-services calls that still show two deployments),
FAKE_UPDATE_SERVICE_FAIL, FAKE_RESTART_ROLLBACK (a restart's deployment is
rolled back: the service settles on another),
FAKE_TF_VERSION (1.16.5), FAKE_BUILD_FAIL.
"""
import datetime
import json
import os
import re
import subprocess
import sys

D = os.environ["FAKE_DIR"]
ACCOUNT = os.environ.get("FAKE_ACCOUNT", "123456789012")
REGISTRY = "123456789012.dkr.ecr.us-east-1.amazonaws.com"
OUTPUTS = {
    "region": "us-east-1", "cluster_name": "acrodont", "service_name": "acrodont",
    "task_security_group": "sg-task", "ops_task_family": "acrodont-ops",
    "log_group": "/ecs/acrodont",
    "target_group_arn": "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/acrodont/abc",
    "ecr_backend": REGISTRY + "/acrodont-backend", "ecr_frontend": REGISTRY + "/acrodont-frontend",
    "alarm_topic_arn": "arn:aws:sns:us-east-1:123456789012:acrodont-alarms",
    "db_identifier": "acrodont", "site_host": "acrodont.test",
}
JSON_OUTPUTS = {"task_subnets": ["subnet-1", "subnet-2"]}
TD_ARN = "arn:aws:ecs:us-east-1:123456789012:task-definition/acrodont:7"
FLAGS = {
    "--interactive", "--only-show-errors", "--with-decryption", "--overwrite",
    "--enable-execute-command", "--force-new-deployment", "--start-from-head", "--no-paginate",
}


def path(*p):
    return os.path.join(D, *p)


def read(p, default=None):
    try:
        with open(p) as f:
            return f.read()
    except FileNotFoundError:
        return default


def write(p, s):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(s)


def log(tool, args):
    with open(path("calls.log"), "a") as f:
        f.write(" ".join([tool] + [a.replace("\n", "\\n") for a in args]) + "\n")


def parse(args):
    pos, opt, i = [], {}, 0
    while i < len(args):
        a = args[i]
        if a.startswith("--") and a not in FLAGS and i + 1 < len(args):
            opt[a] = args[i + 1]
            i += 2
        elif a.startswith("--"):
            opt[a] = True
            i += 1
        else:
            pos.append(a)
            i += 1
    return pos, opt


def out(s):
    sys.stdout.write(s if s.endswith("\n") or s == "" else s + "\n")


def fail(msg, rc=254):
    sys.stderr.write(msg + "\n")
    sys.exit(rc)


def tfvar(text, key, default=""):
    m = re.search(r'^\s*' + key + r'\s*=\s*"?([^"\n]*?)"?\s*$', text or "", re.M)
    return m.group(1) if m else default


def count(name):
    """A counter kept in a file: returns the new value."""
    n = int(read(path(name), "0")) + 1
    write(path(name), str(n))
    return n


def value_of(v):
    return read(v[7:]) if isinstance(v, str) and v.startswith("file://") else v


# --------------------------------------------------------------------------
def aws(args):
    log("aws", args)
    svc, op = args[0], args[1] if len(args) > 1 else ""
    pos, opt = parse(args[2:])
    q = opt.get("--query", "")
    handler = {
        "sts": sts, "configure": configure, "s3": s3, "ecr": ecr, "ecs": ecs, "logs": logs,
        "elbv2": elbv2, "ssm": ssm, "rds": rds, "sns": sns, "cloudwatch": cloudwatch, "events": events,
    }.get(svc)
    if handler is None:
        fail("fake aws: no such call: %s" % " ".join(args), 2)
    handler(op, pos, opt, q)


def sts(op, pos, opt, q):
    if os.environ.get("FAKE_STS_FAIL"):
        fail("An error occurred (ExpiredToken): the SSO session has expired", 255)
    out("%s\tarn:aws:sts::%s:assumed-role/AdministratorAccess/tester" % (ACCOUNT, ACCOUNT))


def configure(op, pos, opt, q):
    out("acrodont")


def s3(op, pos, opt, q):
    if op != "cp":
        fail("fake aws s3: no such call: " + op, 2)
    src, dst = pos
    if src.startswith("s3://"):
        data = read(path("s3", src[5:]))
        if data is None:
            fail("fatal error: An error occurred (404) when calling the HeadObject operation", 1)
        write(dst, data)
    else:
        write(path("s3", dst[5:]), read(src))


def ecr(op, pos, opt, q):
    repo = opt.get("--repository-name", "")
    if op == "get-login-password":
        out("password")
    elif op == "describe-images" and "--image-ids" in opt:
        tag = opt["--image-ids"].split("=", 1)[1]
        at = read(path("ecr", repo, tag))
        if at is None:
            fail("An error occurred (ImageNotFoundException): the image with imageTag '%s' does not exist" % tag)
        out(json.dumps({"imageDetails": [{"imageTags": [tag], "imagePushedAt": at.strip()}]}))
    elif op == "describe-images":
        d = path("ecr", repo)
        tags = sorted(os.listdir(d)) if os.path.isdir(d) else []
        out(json.dumps({"imageDetails": [
            {"imageTags": [t], "imagePushedAt": read(os.path.join(d, t)).strip()} for t in tags]}))
    else:
        fail("fake aws ecr: no such call: " + op, 2)


def running():
    return json.loads(read(path("ecs", "running.json"), '{"tag": "none", "cpu": "1024", "memory": "2048"}'))


def ecs(op, pos, opt, q):
    if op == "describe-services":
        desired = int(read(path("ecs", "desired"), "1").strip())
        dep = read(path("ecs", "deployment"), "ecs-svc/0").strip()
        if os.environ.get("FAKE_RESTART_ROLLBACK") and dep != "ecs-svc/0":
            dep += "-rollback"
        deps = [{"id": dep, "status": "PRIMARY", "rolloutState": "COMPLETED", "taskDefinition": TD_ARN}]
        if count("settle_polls") <= int(os.environ.get("FAKE_SETTLE_POLLS", "0")):
            deps = [{"id": dep, "status": "PRIMARY", "rolloutState": "IN_PROGRESS", "taskDefinition": TD_ARN},
                    {"id": "ecs-svc/old", "status": "ACTIVE", "rolloutState": "COMPLETED",
                     "taskDefinition": TD_ARN[:-1] + "6"}]
        out(json.dumps({"services": [{
            "serviceName": opt["--services"], "desiredCount": desired, "runningCount": desired,
            "deployments": deps,
            "events": [{"createdAt": "2026-10-06T00:00:00Z", "message": "(service acrodont) has reached a steady state."}],
        }], "failures": []}))
    elif op == "describe-task-definition":
        r = running()
        out(json.dumps({"taskDefinition": {
            "family": "acrodont", "cpu": r["cpu"], "memory": r["memory"],
            "containerDefinitions": [
                {"name": "backend", "image": "%s/acrodont-backend:%s" % (REGISTRY, r["tag"])},
                {"name": "nginx", "image": "%s/acrodont-frontend:%s" % (REGISTRY, r["tag"])}]}}))
    elif op == "update-service":
        if os.environ.get("FAKE_UPDATE_SERVICE_FAIL"):
            fail("fake aws ecs update-service: failing as asked")
        if "--desired-count" in opt:
            write(path("ecs", "desired"), opt["--desired-count"])
        if "--force-new-deployment" in opt:
            # A restart is a new deployment, and the service's PRIMARY from here.
            dep = "ecs-svc/%d" % count("deployments")
            write(path("ecs", "deployment"), dep)
            out(json.dumps({"service": {"serviceName": opt["--service"], "deployments": [
                {"id": dep, "status": "PRIMARY", "rolloutState": "IN_PROGRESS", "taskDefinition": TD_ARN}]}}))
        else:
            out(opt["--service"])
    elif op == "run-task":
        run_task(opt)
    elif op == "describe-tasks":
        n = opt["--tasks"].rsplit("task", 1)[1]
        t = read(path("tasks", n + ".json"))
        if t is None:
            out(json.dumps({"tasks": [], "failures": [{"arn": opt["--tasks"], "reason": "MISSING"}]}))
            return
        t = json.loads(t)
        container = {"name": "ops", "lastStatus": t["status"],
                     "managedAgents": [{"name": "ExecuteCommandAgent", "lastStatus": "RUNNING"}] if t.get("exec") else []}
        if t.get("exit") is not None:
            container["exitCode"] = t["exit"]
        out(json.dumps({"tasks": [{"taskArn": opt["--tasks"], "lastStatus": t["status"],
                                   "stoppedReason": t.get("reason", ""), "containers": [container]}],
                        "failures": []}))
    elif op == "stop-task":
        n = opt["--task"].rsplit("task", 1)[1]
        t = json.loads(read(path("tasks", n + ".json"), "{}"))
        t["status"] = "STOPPED"
        write(path("tasks", n + ".json"), json.dumps(t))
    elif op == "execute-command":
        pass
    else:
        fail("fake aws ecs: no such call: " + op, 2)


TASKBIN = {
    "psql": r'''#!/bin/sh
# A stub psql inside a fake ops task: records its arguments, stdin and the
# WF_/APP_/BK_ variables the task script parsed.
d="$FAKE_DIR/psql"; mkdir -p "$d"
n=$(( $(ls "$d" | grep -c '\.args$') + 1 ))
printf '%s\n' "$(basename "$0")" "$@" > "$d/$n.args"
cat > "$d/$n.stdin"
env | grep -E '^(WF_|APP_|BK_)' | sort > "$d/$n.env"
echo "psql printed this"
exit "${FAKE_PSQL_EXIT:-0}"
''',
}
TASKBIN["acrodont-master-psql"] = TASKBIN["psql"]


def run_task(opt):
    refused = os.environ.get("FAKE_RUN_TASK_FAIL")
    if refused == "capacity":
        out(json.dumps({"tasks": [], "failures": [{"reason": "RESOURCE:FARGATE", "detail": "Capacity is unavailable at this time."}]}))
        return
    if refused:
        fail("An error occurred (ExpiredTokenException) when calling the RunTask operation: The security token included in the request is expired", 254)
    n = count("task_count")
    overrides = json.loads(opt.get("--overrides", "{}"))
    c = (overrides.get("containerOverrides") or [{}])[0]
    env = {e["name"]: e["value"] for e in c.get("environment", [])}
    exec_ = "--enable-execute-command" in opt
    write(path("runtask", "%d.json" % n), json.dumps({
        "overrides": overrides, "exec": exec_, "network": opt.get("--network-configuration"),
        "taskDefinition": opt.get("--task-definition"), "launchType": opt.get("--launch-type")}))
    arn = "arn:aws:ecs:us-east-1:123456789012:task/acrodont/task%d" % n
    task = {"status": "RUNNING", "exec": exec_, "exit": None, "output": []}
    if not exec_:
        task.update(execute(c.get("command") or [], env))
    write(path("tasks", "%d.json" % n), json.dumps(task))
    out(json.dumps({"tasks": [{"taskArn": arn}], "failures": []}))


def execute(command, env):
    """The container, run here: secrets from the fake SSM, then the command."""
    task_env = {"PATH": path("taskbin") + ":" + os.environ.get("REAL_PATH", "/usr/bin:/bin"),
                "FAKE_DIR": D, "HOME": path("taskhome"), "LANG": "C.UTF-8",
                "MASTER_SECRET_ARN": "arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!db-1"}
    for var in ("DATABASE_URL", "BACKUP_DATABASE_URL"):
        v = read(path("ssm", "acrodont_production_" + var))
        if v is None:
            return {"status": "STOPPED", "exit": None,
                    "reason": "ResourceInitializationError: unable to pull secrets: /acrodont/production/" + var}
        task_env[var] = v
    if "FAKE_PSQL_EXIT" in os.environ:
        task_env["FAKE_PSQL_EXIT"] = os.environ["FAKE_PSQL_EXIT"]
    task_env.update(env)
    for name, body in TASKBIN.items():
        p = path("taskbin", name)
        if not os.path.exists(p):
            write(p, body)
            os.chmod(p, 0o755)
    os.makedirs(path("taskhome"), exist_ok=True)
    if not command:
        command = ["true"]
    r = subprocess.run(command, env=task_env, cwd=path("taskhome"), stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
    code = r.returncode
    if os.environ.get("FAKE_TASK_EXIT"):
        code = int(os.environ["FAKE_TASK_EXIT"])
    return {"status": "STOPPED", "exit": code, "reason": "Essential container in task exited",
            "output": r.stdout.decode("utf-8", "replace").splitlines()}


def logs(op, pos, opt, q):
    token = opt.get("--next-token")
    stream = opt["--log-stream-name"]
    m = re.match(r"^ops/ops/task(\d+)$", stream)
    t = json.loads(read(path("tasks", m.group(1) + ".json"), "null")) if m else None
    if t is None or t.get("exit") is None and t["status"] == "STOPPED":
        fail("An error occurred (ResourceNotFoundException): The specified log stream does not exist.")
    if token:
        out(json.dumps({"events": [], "nextForwardToken": token}))
        return
    out(json.dumps({"events": [{"message": m} for m in t["output"]], "nextForwardToken": "f/1"}))


def elbv2(op, pos, opt, q):
    if op == "wait":
        if count("tg_waits") <= int(os.environ.get("FAKE_TG_FAIL_ROUNDS", "0")):
            fail("Waiter TargetInService failed: Max attempts exceeded", 255)
    elif op == "describe-target-health":
        out("| unhealthy | Target.FailedHealthChecks |")


def ssm(op, pos, opt, q):
    name = opt.get("--name", "")
    p = path("ssm", name.strip("/").replace("/", "_"))
    if op == "get-parameter":
        v = read(p)
        if v is None:
            fail("An error occurred (ParameterNotFound) when calling the GetParameter operation: ")
        out(name if q == "Parameter.Name" else v)
    elif op == "put-parameter":
        if os.path.exists(p) and "--overwrite" not in opt:
            fail("An error occurred (ParameterAlreadyExists) when calling the PutParameter operation")
        assert opt.get("--type") == "SecureString", "a parameter that is not a SecureString"
        write(p, value_of(opt["--value"]))
        out('{"Version": 2}')


def rds(op, pos, opt, q):
    if op == "describe-db-instances":
        ident = opt["--db-instance-identifier"]
        out(json.dumps({"DBInstances": [{"DBInstanceIdentifier": ident, "Endpoint": {
            "Address": ident + ".abc.us-east-1.rds.amazonaws.com", "Port": 5432}}]}))
    elif op == "describe-event-subscriptions":
        out(os.environ.get("FAKE_RDS_SUB_STATUS", "active"))


def sns(op, pos, opt, q):
    arn = opt["--topic-arn"]
    sub = "PendingConfirmation" if os.environ.get("FAKE_SNS_PENDING") else arn + ":1111-2222"
    out(json.dumps({"Subscriptions": [{"SubscriptionArn": sub, "Protocol": "email",
                                       "Endpoint": "ops@example.org", "TopicArn": arn}]}))


def cloudwatch(op, pos, opt, q):
    if op == "describe-alarms":
        name = opt["--alarm-names"]
        out(read(path("alarm", name), "ALARM") if name == "acrodont-no-dump-36h" else "None")
    elif op == "set-alarm-state":
        write(path("alarm", opt["--alarm-name"]), opt["--state-value"])


def task_pattern(family):
    """infra/backups.tf's task_failed pattern by hand, without its clusterArn.
    infra/tests/variables.tftest.hcl pins the real one's "$or" to this text."""
    return {"source": ["aws.ecs"], "detail-type": ["ECS Task State Change"],
            "detail": {"lastStatus": ["STOPPED"], "group": ["family:" + family],
                       "$or": [{"containers": {"exitCode": [{"anything-but": 0}]}},
                               {"stopCode": ["TaskFailedToStart"]}]}}


RULES = {
    "acrodont-deploy-failed": {"source": ["aws.ecs"], "detail-type": ["ECS Deployment State Change"],
                               "detail": {"eventName": ["SERVICE_DEPLOYMENT_FAILED"]}},
    "acrodont-backup-failed": task_pattern("acrodont-backup"),
    "acrodont-drill-failed": task_pattern("acrodont-drill"),
}


def leaf(rule, v, present):
    if isinstance(rule, dict):
        if "anything-but" in rule:
            ab = rule["anything-but"]
            ab = ab if isinstance(ab, list) else [ab]
            return present and v is not None and not any(type(v) == type(a) and v == a for a in ab)
        if "prefix" in rule:
            return isinstance(v, str) and v.startswith(rule["prefix"])
        if "exists" in rule:
            return present == rule["exists"]
        raise ValueError("fake matcher: unsupported rule %r" % rule)
    return present and type(v) == type(rule) and v == rule


def matches(pattern, event):
    """EventBridge's matching, as far as these rules use it."""
    for k, pv in pattern.items():
        if k == "$or":
            if not any(matches(alt, event) for alt in pv):
                return False
            continue
        present = isinstance(event, dict) and k in event
        ev = event.get(k) if present else None
        if isinstance(pv, dict):
            items = ev if isinstance(ev, list) else [ev]
            if not any(isinstance(e, dict) and matches(pv, e) for e in items):
                return False
        else:
            vals = ev if isinstance(ev, list) else [ev]
            if not any(leaf(r, v, present) for r in pv for v in vals):
                return False
    return True


def events(op, pos, opt, q):
    if op == "describe-rule":
        name = opt["--name"]
        if name not in RULES:
            fail("An error occurred (ResourceNotFoundException): Rule %s does not exist." % name)
        p = RULES[name]
        if os.environ.get("FAKE_RULE_BROKEN") == name:
            p = {"source": ["aws.ecs"]}
        if os.environ.get("FAKE_RULE_EXIT_CODE_ONLY") == name:
            p = json.loads(json.dumps(p))
            p["detail"]["containers"] = p["detail"].pop("$or")[0]["containers"]
        out(json.dumps(p))
    elif op == "test-event-pattern":
        event = json.loads(opt["--event"])
        for k in ("id", "account", "source", "time", "region", "resources", "detail-type"):
            if k not in event:
                fail("An error occurred (InvalidEventPatternException): Event is missing " + k)
        out("True" if matches(json.loads(opt["--event-pattern"]), event) else "False")


# --------------------------------------------------------------------------
def terraform(args):
    log("terraform", args)
    chdir = "."
    if args and args[0].startswith("-chdir="):
        chdir, args = args[0][len("-chdir="):], args[1:]
    cmd = args[0]
    tfvars = read(os.path.join(chdir, "prod.tfvars"))
    if cmd == "output":
        if os.environ.get("FAKE_NO_OUTPUTS"):
            fail("Warning: No outputs found", 1)
        name = args[-1]
        if "-json" in args:
            out(json.dumps(JSON_OUTPUTS[name]))
        else:
            sys.stdout.write(OUTPUTS[name])
    elif cmd == "plan":
        assert "-var-file=prod.tfvars" in args, "plan without prod.tfvars"
        assert tfvars is not None, "no prod.tfvars to plan with"
        rc = int(os.environ.get("FAKE_PLAN_RC", "2"))
        for a in args:
            if a.startswith("-out="):
                write(a[5:], "plan")
        out("Plan: 1 to add, 1 to change, 1 to destroy." if rc == 2 else "No changes.")
        sys.exit(rc)
    elif cmd == "show":
        plan = json.loads(read(path("plan.json"), '{"resource_changes": []}'))
        cpu, mem = tfvar(tfvars, "task_cpu", "1024"), tfvar(tfvars, "task_memory", "2048")
        plan["planned_values"] = {"root_module": {"resources": [], "child_modules": [{"resources": [
            {"address": "module.app.aws_ecs_task_definition.app", "type": "aws_ecs_task_definition",
             "values": {"family": "acrodont", "cpu": cpu, "memory": mem}},
            {"address": "module.app.aws_ecs_task_definition.ops", "type": "aws_ecs_task_definition",
             "values": {"family": "acrodont-ops", "cpu": "256", "memory": "512"}}]}]}}
        out(json.dumps(plan))
    elif cmd == "apply":
        rc = int(os.environ.get("FAKE_APPLY_RC", "0"))
        if rc:
            sys.exit(rc)
        if not os.environ.get("FAKE_ROLLBACK"):
            write(path("ecs", "running.json"), json.dumps({
                "tag": tfvar(tfvars, "image_tag"), "cpu": tfvar(tfvars, "task_cpu", "1024"),
                "memory": tfvar(tfvars, "task_memory", "2048")}))
        if os.environ.get("FAKE_APPLY_TOUCH_S3"):
            p = path("s3", "state-bucket", "acrodont", "prod.tfvars")
            write(p, read(p) + "# someone else\n")
        out("Apply complete!")
    elif cmd == "version":
        out(json.dumps({"terraform_version": os.environ.get("FAKE_TF_VERSION", "1.16.5")}))
    elif cmd == "init":
        out("Terraform has been successfully initialized!")
    else:
        fail("fake terraform: no such call: %s" % " ".join(args), 2)


def gh(args):
    log("gh", args)
    key = "FAKE_CI_SCHEDULED" if "schedule" in args else "FAKE_CI"
    spec = os.environ.get(key, "completed success")
    if spec == "none":
        out("[]")
        return
    status, conclusion = (spec.split() + [""])[:2]
    out(json.dumps([{"status": status, "conclusion": conclusion, "url": "https://github.com/x/actions/runs/1"}]))


def docker(args):
    log("docker", args)
    if args[0] == "login":
        sys.stdin.read()
    elif args[0] == "build" and os.environ.get("FAKE_BUILD_FAIL"):
        sys.exit(1)
    elif args[0] == "push":
        repo, tag = args[1].rsplit("/", 1)[1].split(":", 1)
        at = datetime.datetime(2026, 11, 1, tzinfo=datetime.timezone.utc) + datetime.timedelta(minutes=count("pushes"))
        write(path("ecr", repo, tag), at.isoformat())


def curl(args):
    log("curl", args)
    if os.environ.get("FAKE_CURL_FAIL"):
        fail("curl: (22) The requested URL returned error: 502", 22)


tool = os.path.basename(sys.argv[0])
{"aws": aws, "terraform": terraform, "gh": gh, "docker": docker, "curl": curl,
 "session-manager-plugin": lambda a: None}[tool](sys.argv[1:])
