# Host metric reporters

Small shell scripts that run on the production VM under systemd timers, read a
signal that nothing else can see, and POST it to GCP Cloud Monitoring as a
custom metric. A GCP alert policy then watches it.

This is the alerting mechanism that **actually works on this deployment**. The
Prometheus/Alertmanager configuration in `infra/alerts/rules.yml` and
`infra/alerts/receivers.yml` describes a stack that is not deployed — see
`infra/alerts/gcp-custom-metrics.yml` for the contract these reporters satisfy
and the full argument for why a PromQL rule is the wrong answer here.

## Why these files exist in the repo at all

They did not, until 2026-09-24. `git grep container-health-reporter` returned
**zero files**: the script lived only at `/usr/local/bin/` on the VM, with a
systemd timer beside it and its alert policy in the GCP console. Unversioned, so
it could not be reviewed, could not be tested, and could not be rebuilt if the
VM were lost — while the two Prometheus files that *were* in the repo described
22 alert rules that have never run.

`container-health-reporter.{sh,service,timer}` here are **captured verbatim from
the VM**, not retyped. As of capture:

| file | bytes | sha256 |
| --- | --- | --- |
| `container-health-reporter.sh` | 4509 | `c4e5d65e113e59300ef1642d2028487a1ec2c38ecbf65f5eed486007487cb1a7` |
| `container-health-reporter.service` | 507 | `2f60e5abe9c21409dd81246b50d88acf16e1012183e5b253afd24594ff2030e6` |
| `container-health-reporter.timer` | 206 | `6d22352650338bc9544b743a859a98f1b752d657e97f124402bbf43492b1b408` |

**The repo copy is canonical from now on.** If you change behaviour, change it
here and re-install; if you have to hot-fix on the VM, bring the change back in
the same day or the two silently diverge again.

## What is here

| reporter | metric | timer | status |
| --- | --- | --- | --- |
| `container-health-reporter.sh` | `docker/container_health`, `host/disk_percent_used` | 60s | **deployed** |
| `identity-unsettled-reporter.sh` | `identity/write_unsettled` | 5m | **not yet applied** |

## The shape every reporter follows

Four rules, and each one exists because its opposite has failed in production:

1. **No credentials in the script.** The GCP token comes from the metadata
   server at runtime (the VM's service account already holds `monitoring.write`).
   The database is read through `docker exec` into the postgres container, under
   the container's own user. Nothing here is secret and nothing here rotates.
2. **Emit on the healthy path too.** `0` is a value. A metric that only appears
   during an incident is indistinguishable from a metric that stopped being
   emitted.
3. **Emit NOTHING when you cannot measure.** Never post a fallback `0` on a
   failed read — that converts "we cannot tell" into "all clear". Exit non-zero
   and let the policy's absence condition do its job.
4. **Every policy has an absence condition.** A threshold condition alone is
   satisfied by silence.

## Operator procedure — installing `identity-unsettled-reporter` (#2842)

Nothing below has been applied. Until it is, **there is no alert on an unsettled
identity write.** Each step is a production change and is deliberately left to
an operator.

### 0. Dry run first (safe, changes nothing)

```bash
gcloud compute ssh inflect-compliance --zone=europe-west1-b --tunnel-through-iap \
  --command='IDENTITY_UNSETTLED_DRY_RUN=1 bash -s' < infra/reporters/identity-unsettled-reporter.sh
```

Expect a `DRY RUN — would POST …` line ending `"int64Value":"0"`. This does
every read and posts nothing. Verified this way against production on
2026-09-24: real instance id, real zone, value `0` — correct, because the
journal holds 3 rows and all 3 are `APPLIED`.

Do this before step 3: the first real POST **creates the metric descriptor**,
which a dry run does not.

### 1. Install the script and units

```bash
gcloud compute scp infra/reporters/identity-unsettled-reporter.sh \
  inflect-compliance:/tmp/identity-unsettled-reporter.sh \
  --zone=europe-west1-b --tunnel-through-iap
gcloud compute scp infra/reporters/identity-unsettled-reporter.service \
  infra/reporters/identity-unsettled-reporter.timer \
  inflect-compliance:/tmp/ --zone=europe-west1-b --tunnel-through-iap

gcloud compute ssh inflect-compliance --zone=europe-west1-b --tunnel-through-iap --command='
  sudo install -m 0755 /tmp/identity-unsettled-reporter.sh /usr/local/bin/identity-unsettled-reporter.sh
  sudo install -m 0644 /tmp/identity-unsettled-reporter.service /etc/systemd/system/
  sudo install -m 0644 /tmp/identity-unsettled-reporter.timer   /etc/systemd/system/
  sudo systemctl daemon-reload
'
```

### 2. Run it once by hand and read the result

```bash
gcloud compute ssh inflect-compliance --zone=europe-west1-b --tunnel-through-iap --command='
  sudo systemctl start identity-unsettled-reporter.service
  sudo systemctl status identity-unsettled-reporter.service --no-pager
  sudo journalctl -u identity-unsettled-reporter -n 20 --no-pager
'
```

A `200` on stdout is the POST succeeding. This is the step that creates
`custom.googleapis.com/identity/write_unsettled`; the metric must exist before
the alert policy can reference it.

### 3. Start the timer

```bash
gcloud compute ssh inflect-compliance --zone=europe-west1-b --tunnel-through-iap --command='
  sudo systemctl enable --now identity-unsettled-reporter.timer
  systemctl list-timers identity-unsettled-reporter.timer --no-pager
'
```

### 4. Create the alert policy

Do this **after** at least one successful POST, so the metric descriptor exists.

```bash
gcloud alpha monitoring policies create \
  --project=hazel-design-419410 \
  --policy-from-file=infra/alerts/policies/identity-write-unsettled.json
```

`gcloud alpha` is not installed on this workstation. The equivalent REST call
works without it:

```bash
curl -s -X POST \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" \
  -H 'Content-Type: application/json' \
  -d @infra/alerts/policies/identity-write-unsettled.json \
  https://monitoring.googleapis.com/v3/projects/hazel-design-419410/alertPolicies
```

Then record the returned policy id in `infra/alerts/gcp-custom-metrics.yml`
(the `deployed_policy_id: null` line) and flip that reporter's `status` to
`DEPLOYED`, in a follow-up PR. A contract file that says `DEPLOYED` when nothing
is deployed is the exact failure this whole change is about.

### 5. Prove it can fire

**The alert will be silent on day one, and that is correct** — production holds
zero unsettled rows. Silence is therefore not evidence the alert works.

The honest drill, mirroring how the readyz policy was proven in #2745, is a
**temporary second policy** on the same live metric with an inverted threshold
(`COMPARISON_GTE`, `thresholdValue: 0`) — real metric, real aggregation, real
policy evaluation, real email channel, exercised exactly as a genuine backlog
would exercise them, without inventing an unsettled row. Delete the drill policy
after the email arrives.

Do **not** prove it by inserting a PENDING row into `IdentityWriteJournal`. A
journal row asserts that a write against a customer's directory was attempted,
and the table is the strongest evidence this subsystem produces — a fake row is
a lie in the one place designed never to hold one.

## Uninstalling

```bash
sudo systemctl disable --now identity-unsettled-reporter.timer
sudo rm /etc/systemd/system/identity-unsettled-reporter.{service,timer}
sudo rm /usr/local/bin/identity-unsettled-reporter.sh
sudo systemctl daemon-reload
```

Delete the alert policy too, or its absence condition will fire for ever —
correctly, since nothing is reporting any more.
