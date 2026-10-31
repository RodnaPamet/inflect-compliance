# OpenShell gateway deployment — 4.3 (#3964)

Everything in this directory belongs to **one host that does not exist yet**: a
dedicated gateway VM. Nothing here is installed on the production app VM, and
nothing here is reachable from `deploy/apply.sh`, which refuses any compose
basename other than `docker-compose.prod.yml`.

| | |
|---|---|
| Release | **v0.1.6**, binary, verified to its published checksum |
| Config | `gateway.toml` → `/etc/openshell/gateway.toml` |
| Unit | `openshell-gateway.service` → `/etc/systemd/system/` |
| Driver images | digest-pinned in `gateway.toml` |
| Telemetry | off by setting **and** by egress policy |
| Inbound auth | OIDC bearer tokens, validated against the issuer's JWKS |
| Operator mTLS | disabled here; the certificate lives on neither VM |

## Why a binary and not a container

Upstream publishes no gateway image for this release. `ghcr.io/nvidia/openshell/gateway`
carries 4000 tags whose highest semantic version is **0.0.91**, built
**2026-07-24**; `docker run … --version` on it reports `openshell-gateway 0.0.91`,
against our binary's `0.1.6`.

It is not merely older. It is missing nine flags the 0.1.6 binary has, three of
which this phase depends on — `--compute-driver`, `--enable-operator-auth` and
`--oidc-jwks-allowed-origins`. Using it would also break the pre-1.0 rule that
the SDK and the gateway move together: a 0.1.6 SDK against a 0.0.91 gateway,
reverting three months of fixes including the ones found on 0.1.2.

## Why its own VM

The Docker compute driver needs the Docker socket, which is **root-equivalent
on the host**. The app VM runs eight compose services, so granting it there
would put the whole stack inside the blast radius of the component whose job is
to contain things.

There is a second reason, specific to packaging: snap-packaged Docker cannot
run these sandboxes at all. snapd's AppArmor denies the `no_new_privs`
transition (Launchpad #1908448, open since 2020), and the driver sets
`no_new_privileges` on sandbox containers — correctly. So the requirement is
not "its own VM" but **its own VM with Docker from Docker's apt repository**.

## The binary's checksum chain

The published checksums cover the **archives**, not the extracted files, so the
chain has four links and all four are checked:

```
published SHA256SUMS → tarball → extracted binary → host-to-VM transfer
```

`openshell-gateway --version` on the VM must print `openshell-gateway 0.1.6`
before the unit is enabled. That is the pin; there is no digest for a binary.

## Digest pinning, and why the tag is not trusted

With no configuration the gateway resolves its driver images **by mutable tag**.
Observed in its own Docker socket traffic:

```
GET /images/ghcr.io/nvidia/openshell/sandbox:0.1.6/json
GET /images/ghcr.io/nvidia/openshell/supervisor:0.1.6/json
```

And that tag moves. The digests in `gateway.toml` are the images this phase ran
and verified, recorded 2026-10-24. Re-resolved 2026-10-27 — **three days
later** — `:0.1.5` pointed at different content in both repositories:

```
sandbox:0.1.5     -> sha256:e9adf9ec…    recorded: sha256:d60222e1…
supervisor:0.1.5  -> sha256:fabcd01f…    recorded: sha256:07cc8b62…
```

Those were the v0.1.5 pins and the movement that proved the point. The pins in
`gateway.toml` are v0.1.6's, resolved 2026-10-29 and **verified in use** — a
0.1.6 gateway running that config created a sandbox on them.

Both recorded digests still exist and still pull, so this is not a mistaken
record: a **release** tag was re-pushed within 72 hours. Anyone who pinned
`:0.1.5` believing they had pinned v0.1.5 would have had both images replaced
underneath them, with nothing to see in any diff.

`tests/guardrails/runtime-image-pinning.test.ts` scans this directory's TOML and
requires a digest on every image reference it finds.

## Watchtower

Watchtower does not update anything here, for two independent reasons:

1. **It does not run on this VM.** It is a service in
   `deploy/docker-compose.prod.yml`, on the app VM, watching containers on that
   VM's Docker socket. It has no view of this host.
2. **It is opt-in by label, and nothing here carries the label.** It runs with
   `WATCHTOWER_LABEL_ENABLE: "true"` and `--label-enable`, so only containers
   labelled `com.centurylinklabs.watchtower.enable=true` are candidates. The
   gateway is not a container at all, and the two images it pulls are created by
   the gateway rather than by compose.

The second reason is a **premise that can expire**: drop `--label-enable` and
Watchtower watches everything it can see. It still could not see this VM, but
the guard pins the premise anyway, because an argument whose conditions have
gone false while nothing failed is worse than no argument.

## Egress

`OPENSHELL_TELEMETRY_ENABLED=false` is set in the unit, and anonymous telemetry
is **default on** in this build, which is why the line exists.

**And it works — measured, after an earlier claim here that it could not be
verified.** 0.1e (#3930) ran the gateway against a DNS sinkhole for 300 seconds
per arm, with a positive control and `readyz` gated at both ends of each window:

```
default (unset),  create+list+delete   3013 bytes   (reproduced exactly)
default (unset),  list only               0 bytes
=false,           create+list+delete      0 bytes
```

So telemetry is on by default, this line turns it off completely, and the sends
are EVENT-DRIVEN rather than periodic. The earlier text here said the setting
was not self-verifying, on the strength of three 18-second traced runs that were
indistinguishable — too short, and generating no sandbox lifecycle at all, so it
was watching for an event-driven send while producing no events.

So the endpoint must be denied by the VM's egress policy, independently of the
setting:

```
https://events.telemetry.data.nvidia.com/v1.1/events/jsonstruct
```

That denial is a **precondition below**, not something this directory
configures — there is no egress policy here to point at, and claiming otherwise
would be the same mistake as trusting the setting.

**And what is deployed is a NAME-RESOLUTION control, not a network one — #4566.**
An earlier version of this paragraph ended "the network rule is the enforcement",
which was written to say *do not trust the env var, trust the network*. The
network half was never built, so the sentence provided exactly the false
reassurance it was written to prevent. What the host actually carries is a
sinkhole in `/etc/hosts`:

```
0.0.0.0 events.telemetry.data.nvidia.com
```

Verified working — `curl` to the endpoint returns HTTP 000. What the sinkhole
alone covered, and did not:

| | |
|---|---|
| a process using the system resolver | **denied** |
| a process with its own resolver | not denied |
| a connection to a literal address | not denied |
| an image rebuild that drops the hosts entry | not denied, and silent |

### THE NETWORK RULE NOW EXISTS — owner decision 2026-10-31 (#4566)

A **global network firewall policy** with an FQDN object, so the denial holds in
the data plane regardless of what any process does to `/etc/hosts`:

```
policy       inflect-egress-telemetry-deny      (global, logging enabled)
rule 1000    EGRESS  deny  all protocols
             dest-fqdns: events.telemetry.data.nvidia.com
association  network:default
```

**FQDN rather than an IP rule**, because an IP rule would rot: the endpoint sits
behind a CDN and a moved address would silently restore egress — a control that
decays with no signal. Google resolves the name on its side, so an address
change is handled; a NAME change is not, and that residual is real.

**VPC-wide rather than scoped to the gateway VM, deliberately.** Targeting one
instance in a network firewall policy needs secure tags, and this project has
none; and nothing in this project has any reason to reach NVIDIA's telemetry
sink, so the wider scope is the stronger control rather than a compromise. Both
production apps were checked immediately after the association and answered
`200`.

**Verified by a probe with a positive control, and then attributably.** The
gateway VM is the wrong place to test from — its `/etc/hosts` entry would block
the name whether or not the firewall worked, which is a probe with no
discriminating power. Measured from the **app** VM, which carries no such entry:

```
/etc/hosts entries for the name      0
https://ghcr.io                      301 in 0.18s   <- positive control
https://events.telemetry…            000 at 20s     <- denied
same, --resolve to the literal IP    000 at 20s     <- not name resolution
```

And the data plane says so itself, which is what makes this evidence rather
than inference:

```
DENY  network:default/firewallPolicy:inflect-egress-telemetry-deny  18.198.233.49
```

Logging is on for exactly that reason: a control nobody can see fire is a
configuration, not a control.

So there are now **three** independent controls — the env var, the sinkhole, and
the network rule — and the first two remain, weak in their own ways, because
three independent weak controls fail in different places. A full deny-by-default
egress policy is still not built, and still real work: an allowlist has to admit
ghcr.io and three clouds' APIs, all CDN-hosted. That half stays open on #4569's
neighbour territory rather than being implied closed here.

## Inbound authentication

**Since v0.1.6 it refuses to start without any**, which is the hardening this
section used to have to argue for: OIDC, mTLS user or operator authentication,
or gateway JWTs. `gateway.toml`'s `gateway_jwt` table is what satisfies it here.

Upstream documents an escape hatch, `allow_unauthenticated_users = true` under
`[openshell.gateway.auth]`, for "trusted local development only". It must never
appear in this deployment's config, and a guard asserts that — on a host whose
Docker socket is root-equivalent, it would turn the refusal back into the 0.1.5
behaviour, which was to start anyway and warn:

```
WARN Neither mTLS user auth nor OIDC nor sandbox JWT auth is configured
     — the gateway has no authentication mechanism
```

That warning disappearing is how you know the configuration took effect. Set in
`/etc/openshell/env`, which is not in this repository:

```
OPENSHELL_BIND_ADDRESS=<private address>    # default 127.0.0.1
OPENSHELL_SERVER_PORT=17670
OPENSHELL_HEALTH_PORT=8081
OPENSHELL_METRICS_PORT=9091
OPENSHELL_TLS_CERT=/etc/openshell/pki/server/tls.crt
OPENSHELL_TLS_KEY=/etc/openshell/pki/server/tls.key
OPENSHELL_TLS_CLIENT_CA=/etc/openshell/pki/ca.crt
OPENSHELL_OIDC_JWKS_TTL=3600                # the renewal interval
# OPENSHELL_OIDC_ISSUER=<issuer URL>        # validates `authorization: Bearer`
# OPENSHELL_OIDC_AUDIENCE=<our client id>   # NOT the default `openshell-cli`
```

**This list was four variables until the VM existed, and three of the missing
ones are fatal.** Without them the 0.1.6 gateway exits immediately:

```
× --tls-cert is required when TLS is enabled (use --disable-tls to skip)
```

`--disable-tls` is the wrong way out: nothing terminates TLS in front of this
VM, so plaintext would put a root-equivalent Docker socket behind an
unauthenticated VPC port.

**The OIDC pair is commented out, and that is deliberate.** It needs an
identity-provider client (client-credentials grant) that does not exist yet.
What satisfies 0.1.6's refusal to start unauthenticated is mTLS instead:
`--enable-mtls-auth` is documented to default ON "when client certificate
verification is configured and no OIDC issuer is present", which is exactly
this host. Writing an invented issuer here would produce a gateway that starts
and validates nothing.

The worker obtains a token by the OAuth2 **client-credentials** grant and sends
it as a bearer token; the gateway validates it against the issuer's JWKS and
refreshes that key set on the TTL above. Renewal is therefore a property of the
grant and the TTL, not of a long-lived secret on the app VM.

`OPENSHELL_ENABLE_OPERATOR_AUTH=false` is set explicitly, though it is also the
default, so that the default moving does not change this deployment. Operator
access is gateway-wide mTLS with `OU=operator`; that certificate is deliberately
absent from both VMs and is presented out of band by a person.

## Preconditions before enabling

```
[ ] A VM exists, with Docker from Docker's apt repository — NOT snap.
[ ] Linux 6.2+ with Landlock. Under hard_requirement the gateway REFUSES to
    start without it, which is the behaviour to want rather than work around.
[ ] openshell-gateway 0.1.6 at /usr/local/bin, checksum chain checked.
[ ] /etc/openshell/pki/jwt/signing.pem exists, root-owned, mode 0400.
    The unit ASSERTS this and FAILS without it — it does not skip.
[ ] /etc/openshell/env written with the eight variables above.
[ ] /etc/openshell/pki/server/tls.{crt,key} and ca.crt exist; the gateway
    REFUSES to start without --tls-cert and --tls-key.
[ ] Egress policy denies events.telemetry.data.nvidia.com.
[ ] `openshell-gateway --version` prints 0.1.6 on the VM.
[ ] openshell-idle-shutdown.timer enabled — it is the cost control, not a
    convenience. See the cost section below.
[ ] `npm run openshell:digest -- --check` passes, and the app's environment
    carries SANDBOX_RUNTIME_CONFIG_DIGEST from config-digest.txt plus
    SANDBOX_RUNTIME_APPLIED_AT stamped at apply time.
[ ] SANDBOX_RUNTIME_HEALTH_URL points at the gateway's health port, or is
    absent — absent means "not probed", which the admin page reports
    differently from "did not answer".
[ ] SANDBOX_RUNTIME_GATEWAY_{PROJECT,ZONE,INSTANCE} all set, or all absent.
    All three present means a scan may start the VM (#4562); any one missing
    and the start is skipped, which is the right behaviour for a gateway
    somebody else runs.
```

### What to put in `/opt/inflect/.env.prod` — #4564

The admin page's subject is "what did this deploy declare", and it declares
nothing until these reach the app. They go in `/opt/inflect/.env.prod` on the
app VM, which `docker-compose.prod.yml` hands to the container through
`env_file:` — so **no compose or apply.sh change is involved**, and nothing has
to be interpolated.

```
SANDBOX_RUNTIME_CONFIG_DIGEST=sha256:…      # copy from config-digest.txt
SANDBOX_RUNTIME_APPLIED_AT=2026-10-30T06:39:54Z
SANDBOX_RUNTIME_CHANNELS=ocsf-file
SANDBOX_RUNTIME_HEALTH_URL=http://10.132.0.28:8081
SANDBOX_RUNTIME_GATEWAY_PROJECT=hazel-design-419410
SANDBOX_RUNTIME_GATEWAY_ZONE=europe-west1-b
SANDBOX_RUNTIME_GATEWAY_INSTANCE=openshell-gateway
```

**All seven are optional and absence is a working state**, not a broken one. With
no digest the page reports `not-configured` for every row, which is true of a
deploy that declared nothing.

#### The last three are what lets a scan START the machine — 4.3 (#4562)

Owner decision 2026-10-30: **the caller starts the VM and waits for `readyz`.**
There is no start schedule and no Cloud Scheduler, because the 5 USD/month cap
is a runtime budget of about 45 hours and a day with no scan must cost nothing.

All three must be present for a start to be attempted; any one missing and the
step is skipped entirely. That is not a degraded mode — it is what a deploy
pointing at a gateway somebody else started looks like, including a local one,
and attempting `instances start` against it would be wrong.

The accepted costs, stated so they are not a surprise:

- **~45 seconds of cold boot inside a scan's latency budget**, measured on this
  VM from `instances start` to `readyz` 200;
- a scan that starts the machine and then fails still burns the boot. The idle
  timer bounds that at 20 minutes of no activity.

A start that is attempted and does NOT reach `readyz` raises
`SANDBOX_UNREACHABLE` rather than proceeding to create a sandbox, because the
only thing that could do is fail more slowly having already spent the boot.

**None of these three is a secret** — a project, a zone and an instance name are
all visible to anybody with console access. The AUTHORITY to start the machine
is the service account's, which is why #4562 narrowed it to exactly
`compute.instances.get`, `compute.instances.start` and
`compute.zoneOperations.get` on that one instance.

#### `SANDBOX_RUNTIME_CHANNELS` is derived, not chosen

It lists the channels declared **on**, and for this deployment that is
`ocsf-file` alone — derived from the committed artefacts rather than decided
here:

| channel | why | from |
|---|---|---|
| `anonymous-telemetry` | OFF | `OPENSHELL_TELEMETRY_ENABLED=false` in the unit |
| `otlp-traces` | OFF | no active OTLP endpoint in either artefact |
| `ocsf-file` | **ON** | the `[openshell.gateway.ocsf_log]` table in `gateway.toml` |
| `ocsf-over-otlp` | OFF | no active `OPENSHELL_OTLP_OCSF_ENDPOINT` |

Get this wrong in the permissive direction and the page under-reports where data
can go, which is the one failure that makes it worse than no page. Note that
`parseDeclaredChannels` **refuses the whole list** on a name this build does not
know — a newer runtime or a typo both mean the enumeration is no longer
exhaustive, and an incomplete list of egress paths reads exactly like a complete
one.

#### An empty value means absent, and that took a schema change

Compose and shell defaults produce **empty strings**, not absent variables, and
`SANDBOX_RUNTIME_HEALTH_URL` was `z.string().url().optional()` — which accepts
`undefined` and rejects `''` with "Invalid URL". So an operator who left the line
in but blank would have failed env validation and the container would not have
started: a working state turned into an outage by a variable nobody set.
`src/env.ts` now coerces empty to absent for that one variable, verified against
`''`, whitespace, a real URL and a malformed one.

### The digest, and why the admin page shows provenance instead of state

Effective gateway configuration is **unobservable from outside the process**.
0.1a established there is no configuration read API: `config`, `configz`,
`version` and `/api/v1/config` all answer 404, and only `healthz` and `readyz`
exist. So the admin page cannot truthfully say

> Telemetry: off

and instead says what is true — what was **sent**, and what **answered**:

> declared, digest `sha256:b9dccbef…`, applied 2026-10-30T06:39Z — gateway
> reachable, reporting version 0.1.6

Two pieces make that possible.

**The digest is committed, not only computed at deploy.** A digest computed at
apply time is unfalsifiable: whatever was applied hashes to whatever it hashes
to, and nothing can disagree. `deploy/openshell/config-digest.txt` gives it
something to be wrong against — editing `gateway.toml` without re-running
`npm run openshell:digest -- --write` fails a guard in CI. That is what makes
the number on the page a claim rather than a decoration, and it gives 5.2
(#3972) a second anchor to compare: a digest that changes without a deploy is
drift by definition.

**`openshell-gateway config preflight` validates a configuration without
starting the service**, so the digest can be checked before it is ever applied.
Measured on 0.1.6, all four arms:

```
valid config                        exit 0, silent
compute_driver = "not-a-driver"     exit 1, category=malformed
malformed TOML                      exit 1
allow_unauthenticated_users = true  exit 0   <-- NOT caught
```

That last arm matters: **preflight validates the SHAPE of a configuration, not
whether its choices are ones we permit.** It is not a substitute for the
assertion in `sandbox-runtime-channels-match-the-runtime` that forbids the
escape hatch. The digest script runs preflight where the binary exists and
skips it **with a message** where it does not — CI has no gateway binary, and a
silent skip would let the check pass while reporting nothing.

**The reachability probe reads `/readyz`, not `/healthz`.** Measured: only one
of them carries a version.

```
GET /readyz   200  {"status":"healthy","version":"0.1.6","checks":{...}}
GET /healthz  200  (empty body)
GET /livez    404
GET /version  404
```

A probe pointed at `/healthz` would establish reachability and report no
version — indistinguishable from an unreachable gateway. And the version comes
from that body or from nowhere: never from the pin, the digest or an env var,
because a version this product already knows is not an observation.

**Unreachable is the normal case.** The VM is stopped most of the time by
design — the cap is a runtime budget — so the page will usually say "did not
answer", and that is the honest reading rather than an alarm.

## The VM, and the 5 USD/month cap it runs under

Provisioned 2026-10-29 on the owner's instruction, with a hard **5 USD/month**
cap. It is an owner cost decision, and the cap is the binding constraint on
every shape choice below.

```
openshell-gateway   europe-west1-b   e2-standard-2 (2 vCPU / 8 GiB)
                    20 GB pd-balanced boot disk
                    10.132.0.28 internal, ephemeral external IP
                    no service account, no scopes
                    Shielded VM: secure boot + vTPM + integrity monitoring
```

### Why this shape

The project has **one** commitment, `agrent-inflect-e2-3yr` (36-month,
GENERAL\_PURPOSE\_E2, europe-west1, `VCPU;MEMORY = 4;32768`, active to
2029-09-21), and a commitment is **regional and aggregated across the family**,
not per-VM. `agrent` and `inflect-compliance` are both `e2-highmem-2` in
europe-west1 and together consume it **exactly**, so this third VM bills
entirely on-demand. The last time one of these VMs was resized beyond the
commitment it billed about EUR 64 per month and was reverted the same day.

RAM and CPU come from a measurement, not a guess. On the lab VM a 0.1.6 gateway
with **six containers** — three sandboxes and three supervisors — used **946 MiB
of RAM and 3.5 GB of disk**, with both driver images totalling 316 MB. 8 GiB
therefore leaves roughly 8x headroom for a Powerpipe collector running inside a
sandbox, and 20 GB leaves room for the steampipe plugins.

`pd-balanced` rather than `pd-standard` costs 1.20 USD/month more and is still
the right call: `pd-standard` scales IOPS with size, so a 20 GB standard disk
gets about **15 read IOPS**, which would make booting and pulling images
painfully slow on a VM whose whole purpose is to be started for half an hour.

### The cap is a RUNTIME BUDGET, and that is the useful way to state it

Rates are the real europe-west1 on-demand SKUs, read from the Cloud Billing
Catalog API rather than remembered. The USD figures were cross-checked against
three independently fetched USD SKUs, which agreed with the EUR set on a single
ratio to nine decimal places.

| | rate | billed | per month |
|---|---|---|---|
| 2 x E2 vCPU | $0.023993370 /vCPU-h | while running | |
| 8 x E2 RAM | $0.003216090 /GiB-h | while running | |
| ⇒ e2-standard-2 | **$0.07371546 /h** | while running | $1.11 at 30 min/day |
| 20 GB pd-balanced | $0.100 /GiB-month | **always** | **$2.00** |
| ephemeral external IP | $0.005 /h | while running | $0.08 |
| internet egress | ~$0.12 /GiB | per scan | ~$0.02 |
| **projected** | | | **≈ $3.21** |

The disk is the only always-on charge, so:

```
  $5.00 cap - $2.00 disk - $0.02 egress = $2.98 for runtime
  $2.98 / ($0.07371546 + $0.005) per hour  =  about 38 HOURS PER MONTH
```

**38 hours a month, i.e. 1.25 h/day.** A 30-minute nightly scan uses 39% of it.
A VM left running for a whole month would use 730 hours and cost about 54 USD —
**17x the cap** — which is the number that decides everything else here.

### Three controls, because an estimate is not a control

The projection above rests entirely on the VM not being left running, and
"somebody remembers to stop it" is not a mechanism.

1. **`openshell-idle-shutdown.timer`** — in this directory, and it is the real
   control. Every five minutes it asks whether
   `openshell_server_supervisor_sessions` is zero **and**
   `openshell_server_grpc_requests_total` is unchanged; four consecutive idle
   checks shut the VM down. Two signals, not one: the gauge reads zero in the
   gap between one sandbox being deleted and the next created, so the gauge
   alone would shoot a multi-benchmark scan in the back. A **failed scrape is
   not idle** — unknown state resets the counter, so a broken metrics endpoint
   errs towards staying up and being visible in the budget rather than shutting
   down exactly when something is wrong.
2. **A daily stop schedule** — resource policy `openshell-gateway-nightly-stop`,
   05:00 Europe/Sofia. Deliberately **stop-only, with no start schedule**: the
   VM costs nothing on a day with no scan, and starting it is the caller's act.
   This is the backstop for the case where the idle timer itself is broken.
3. **A budget** — `OpenShell gateway VM - 5 USD cap (#3924)`, 5 USD/month with
   alerts at 50/80/100/120%, scoped to the label `component=openshell-gateway`.
   **The boot disk had to be labelled separately**: a disk does not inherit its
   instance's labels, so the budget would have silently excluded the single
   largest always-on charge in the table above.
4. **An alert that the idle timer did not run** — owner decision 2026-10-30
   (#4571), declared at
   [`infra/alerts/policies/openshell-gateway-overrunning.json`](../../infra/alerts/policies/openshell-gateway-overrunning.json)
   and routed in `docs/incident-response.md`.

   **Deliberately NOT an uptime check.** This VM is `TERMINATED` almost always
   by design, so an uptime check would fire on the normal state — and an alert
   that fires constantly trains people to ignore the channel it fires on, which
   is worse than no alert. The condition is the opposite shape: GCP's own
   `compute.googleapis.com/instance/uptime_total` **only produces samples while
   the instance runs**, so a stopped machine is silent, and `> 7200s` fires only
   when the VM has been up far longer than the idle path allows. The longest
   legitimate idle-to-off run is ~32 minutes (10-minute boot grace + four
   five-minute strikes + ~2 minutes to stop), so 2 hours is roughly 4x headroom.

   It needs **no Ops Agent and no service account**, which matters because this
   VM has neither: `gcloud compute instances describe` returns no
   `serviceAccounts` key at all, so nothing running on it can write to Cloud
   Logging or Monitoring. The signal #4571 originally proposed — an absence of
   `logger -t openshell-idle-shutdown` entries — cannot work here for two
   independent reasons: there is no path for those entries to reach Cloud
   Logging, and absence is also the normal state, because a stopped VM logs
   nothing for days.

   Verified at creation rather than assumed: the deployed filter matches one
   real time series (uptime observed 60s–2267s), the same filter with a
   deliberately mistyped instance name matches **zero** series — so the name is
   load-bearing, not ignored — and 7200s would not have fired on any of the
   VM's real history, so it starts quiet.

   **What it is for, stated honestly:** control 2 already bounds a runaway to
   24 hours (~1.61 USD), so this is not an emergency signal. It exists because
   an unfixed timer recurs *nightly*, and three such nights is 4.82 USD of
   compute, which takes the 5 USD cap over once the disk is counted. The
   budget's own 50% threshold also catches it, roughly a day later and saying
   "cost" rather than "the timer did not run".

### The PKI is REGENERABLE, not backed up — owner decision 2026-10-30 (#4565)

The CA and the JWT signing key are generated **on** this VM and exist nowhere
else. That is deliberate — no private key should cross machines — and it means a
disk failure loses them. There is no snapshot and no snapshot schedule, by
decision rather than omission:

- they cost one run of `regenerate-pki.sh` to remake, so a backup buys little;
- a snapshot of a disk holding private keys is **itself a secret-bearing
  artifact** with its own access-control problem. It would trade one exposure
  for two.
- it would also sit outside the $5 cap's accounting, which is currently exact.

`deletionProtection` is **on**, which covers accidental loss — verified by
attempting the delete and being refused. `regenerate-pki.sh` covers the rest.

#### What regenerating costs

> **A new CA invalidates every client certificate it ever signed.**

The gateway authorises an inbound caller on
`CN=openshell-client/OU=openshell-user`, signed by this CA. Any copy distributed
to another host stops being accepted the moment the script runs. There is no
revocation and no grace period — the old CA is simply gone.

So regenerating is a **two-host operation** once a client certificate has been
distributed: re-issue and redeploy it in the same maintenance window, or the
app's transport fails closed against a gateway that no longer knows it.

**Today nothing holds a copy**, which is why the script could be tested by
actually running it. That changes the first time a transport ships (#4561), and
the cost of this decision rises at that moment.

#### The script was proved by running it, not by review

On the live VM, 2026-10-30:

```
without --force      exit 2, refused — a PKI is already present
with --force         layout IDENTICAL (modes and paths, 10 files)
                     ca.crt digest ec4cd3f8… -> bba0cabd…   (genuinely new)
                     chain verifies; client subject, server SAN, Ed25519,
                     kid 32 bytes and mode 0400 all as before
after restart        openshell-gateway active, readyz HTTP 200
```

The digest changing is the part that matters: it proves the run produced new
material rather than silently doing nothing. A script that reports success and
regenerates nothing is the failure mode worth guarding against here, because
the output looks identical either way.

It **refuses by default** and needs `--force`. A script that silently
regenerates over a working PKI is a footgun: the failure is invisible until an
inbound call is rejected, and by then the old CA is unrecoverable.

### The network posture, and why it opts out of the project defaults

The project's own defaults are too broad for this host. `default-allow-internal`
opens every TCP and UDP port to `10.128.0.0/9`, and `default-allow-ssh` opens
22 to the whole internet. This VM holds a Docker socket that is root-equivalent,
so it opts out of both with a deny-first rule:

```
 90  ALLOW  35.235.240.0/20  tcp:22                      (IAP TCP forwarding only)
 90  ALLOW  10.132.0.3/32    tcp:17670,8081,9091         (the app VM only)
100  DENY   0.0.0.0/0        all
```

Verified from GCP's own `get-effective-firewalls` view rather than from the rule
list, and then probed: 22, 17670 and 8081 are all unreachable from the internet
while IAP SSH and outbound egress still work.

### The external IP is EPHEMERAL, and that is a constraint on egress allowlisting

It changed from `34.156.44.196` to `35.241.231.207` across a single
stop/start — measured, not assumed. Two consequences:

- **Nothing may allowlist this VM by its outbound IP.** A posture API, a
  partner firewall or an upstream allowlist keyed on it breaks on the next
  start, and the schedule above means there is a start most days. A static IP
  would cost $0.0088/h *unattached*, which on a VM that is stopped 97% of the
  time is more than the compute.
- **The app must address the gateway by its INTERNAL IP**, `10.132.0.28`, which
  is stable across stop/start. That is what the firewall rule and the bind
  address both use.

### What is verified on this host, and what is not

Verified: the gateway comes up **from a cold boot with no intervention** —
`systemctl is-active` reports active and `readyz` answers 200 within about 45
seconds of `instances start`, which is what proves the StateDirectory/HOME pair
works at boot and not merely on a hand-driven `systemctl restart`. Then: the
idle timer took the VM down by itself end to end — fourth strike at 17:33:42,
`STOPPING` at 17:35:50, `TERMINATED` at 17:36:32, at which point compute, RAM
and the external IP all stop billing and only the disk continues. Also the
checksum chain end to end (the installed binary digests
`6451533e…` and `962d7d3a…` match the published sums, re-checked **on the VM**
after transfer); `openshell-gateway 0.1.6`; the service active with its
listeners bound to the private address; the Docker driver connected;
`readyz`/`healthz` 200; plaintext to 17670 refused; an **unauthenticated gRPC
call refused** (`whoami` → "missing authorization header"); the telemetry
endpoint sinkholed and unreachable; and `no_new_privs` working under apt Docker
where it fails under snap.

**Not yet verified on this host: that an authenticated caller is accepted.**
Stated plainly because the first probe for it had no discriminating power — a
bare `GET /` returned 404 with *and* without a client certificate, since 404 is
only "that is not a gRPC path". The CLI cannot close the gap either:
`openshell gateway add --local` reports that "mTLS certificates … were not
found. Expected them under the default gateway config directory. Start the
gateway package first so it provisions client TLS material" — that package is
the container distribution this deployment deliberately does not use, because
no gateway image exists for the pinned release. The caller that matters is the
app's own gRPC transport, so the positive control belongs with that wiring and
not with provisioning.

## Upgrades

Pre-1.0, **the SDK and the gateway move together.** Upgrading one alone is the
failure this release line makes easy: the version spaces are confusing on
purpose-adjacent grounds — releases run `0.1.x`, the published documentation
versions itself `v0.0.116`, and the container images stop at `0.0.91`. Three
numbering spaces, none of them the same.

### The checklist

Steps marked **[test]** fail in CI if skipped — `tests/guards/sandbox-runtime-channels-match-the-runtime.test.ts`
holds the pinned release as a constant and every recorded measurement against
it, so moving the pin reddens the build until each one is re-established (5.3,
#3973). The unmarked steps are still yours to do.

```
[ ]       new binary at /usr/local/bin, checksum chain re-checked (4 links)
[ ]       `openshell-gateway --version` on the VM prints the new release
[ ]       driver digests RE-RESOLVED and recorded in gateway.toml
[ ] [test] every image reference in deploy/openshell/*.toml is digest-pinned
[ ]       the SDK bumped in the SAME change — pre-1.0 they move together
[ ] [test] no file claims a release newer than the pin (a half-done upgrade)
[ ] [test] every phase 0.1 fact re-verified against the new release
[ ]          0.1b above all: is `enforcement` unset still AUDIT mode?
[ ] [test] vendored skills re-pinned, VENDORED.md Tag matches the pin
[ ]       the NOTICE commit updated, and THE NEW SKILL TEXT READ before merging
[ ]       policy prover re-run — SEE BELOW, this is not possible as written
[ ]       `npm run skills:evaluate` re-run — SEE BELOW, usually a no-op
[ ] [test] scanner contract tests re-run
```

### Two of those three items were wrong, and the measurements are here

**The policy prover re-run cannot be done against a gateway policy.** Measured
on 2026-10-29 with the checksum-verified `openshell-prover 0.1.6`
(sha256 `dafef6f1…`):

```
$ openshell-prover check --boundary p.json p.json      # p.json = {"version":2}
openshell-prover: invalid candidate policy: invalid policy:
  unsupported policy version 2; expected version 1
```

The gateway's policy schema is **version 2** — that is 0.1a's established fact,
and `[openshell] version = 2` is what `gateway.toml` sets. The prover accepts
**version 1 only**. They are different formats, not different revisions of one:
in the prover's format `network_policies` is a **mapping**, while the gateway's
(and `collectorSandboxPolicy`'s) is a **sequence**, so even the one field name
they share disagrees on type:

```
network_policies: type mismatch: expected mapping, found sequence
```

**This is long-standing, not a 0.1.6 regression** — the 0.1.5 prover rejects
version 2 with the identical message, so the two components have never agreed.
There is no translation layer in this repository and none is published
upstream, so the item is **unsatisfiable as written** rather than pending. It
should be read as "write a v2→v1 translation, or drop the item", and that is a
piece of work, not a checklist tick.

The prover does run and does discriminate on its own schema — a `version 1`
policy returns `result: within_boundary` with
`coverage: domains=filesystem,network_l4,network_rest,process,landlock`. So the
finding is a schema divergence, not a broken tool.

One asymmetry worth carrying forward: **the prover rejects unknown fields and
the gateway's parser does not.** The prover answers `unknown field
'process.allow_root' in authored policy`, while
`agent-sandbox-policy-review/SKILL.md` records — about the gateway — that "the
policy parser does not reject unknown keys… a field it does not recognise is
discarded without error". Both are true of their own component, which means
agreement between prover and gateway can never be assumed from either one
passing.

**`npm run skills:evaluate` does not need the owner's key, and usually has
nothing to do.** The key is on the production VM at `/opt/inflect/.env.prod`,
which is the same credential the Flue runtime's provider already uses. More to
the point, a record goes stale only when a skill's **evaluation set** changes —
`checkEvaluationRecord` fails on `MALFORMED`, `SET_MISMATCH`, an unknown,
duplicate or unanswered answer, or `BELOW_THRESHOLD`, and it does **not** hash
the instructions. All eleven skills carry a passing record today, so an upgrade
that changes no evaluation set needs no re-run; running one anyway spends
credits to rewrite eleven files and risks a record that scores worse. Re-run it
when a set changes, not when a release does.

**Why 0.1b is called out.** #3927 calls it "the most consequential fact in the
roadmap". An endpoint with `enforcement` unset runs in audit mode:
`NETWORK_ENFORCEMENT_MODE_UNSPECIFIED` is zero on the wire and documented as
"log violations and allow traffic", so an omitted field, a proxy-dropped field
and explicit audit are the same bytes — and all three allow the traffic the
policy appears to forbid. Every verdict the scanner and the skill derive from a
policy rests on that reading. A release that changed it, or renamed the enum so
our explicit value stopped matching, would invert what a policy means with
nothing visible in any diff.

That is why the re-verification is a test and not a line on a checklist: the
discovery has to happen in CI rather than in a client's estate.
