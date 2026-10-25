# OpenShell spike — phase 0 of the integration roadmap

Phase 0 of the OpenShell roadmap (tracking issue 3924). No production code.

This note pins what can be established from primary sources today, and states
explicitly which facts still need a running gateway. Two scope decisions were
taken by the owner before the work started, and both are recorded below.

## Owner decisions taken for this phase

**Verification scope.** Four of the seven 0.1 facts can only be settled by
observing a running gateway, and no gateway exists to observe. Rather than block
the roadmap, this phase desk-verifies from NVIDIA's own documentation and
repository, and marks the remainder `UNVERIFIED — needs gateway`. Phases 1 to 3
touch no OpenShell runtime, so they can proceed against the verified facts.

**The SDK is deferred.** `@nvidia/openshell-sdk` is published to GitHub
Packages, not public npm. Taking it would need a scoped `.npmrc`, a
`read:packages` token wired into CI and the image build as a BuildKit secret,
and its transitive dependencies would have to pass the blocking
`npm audit --omit=dev --audit-level=moderate` gate in `ci.yml`. The roadmap
offers an alternative and it was chosen: **call the gateway RPC directly, and
take the SDK once it reaches public npm.** Nothing in this integration adds a
registry credential to this repository.

## 0.1 — the facts, per release

The documentation set is versioned; `v0.0.116` is the newest version-pinned
path that resolves, alongside `latest`. The roadmap describes the release line
as 0.1.x, so the version string needed settling against the repository's own
releases before any policy was authored.

**Settled, 2026-10-22.** They are two different version spaces. `NVIDIA/OpenShell`
is public and Apache-2.0, and its releases run **0.1.x** — `v0.1.5` on
2026-10-20, `v0.1.4` on 2026-10-13, `v0.1.3` on 2026-10-09, plus a rolling
`dev`. `v0.0.116` is the DOCUMENTATION set's version, not a product release.
So a fact read at docs `v0.0.116` is not thereby a fact about any release, and
the pinned release for this work is **v0.1.5**.

That matters for every defect this note records from third-party testing: all
of it was performed on **v0.1.2**, three patch releases behind v0.1.5. A defect
found there is a question to re-ask, not a finding to carry forward.

| Fact | Status | What was established |
| --- | --- | --- |
| 0.1a schema and sections | **VERIFIED** (docs) | `version: 1`. Static: `filesystem_policy`, `landlock`, `process`. Dynamic: `network_policies` **and `network_middlewares`** |
| 0.1b enforcement default | **VERIFIED** (NVIDIA docs) | An endpoint's `enforcement` defaults to **`audit`**: the proxy "logs violations but forwards traffic" without blocking |
| 0.1c Landlock default | **VERIFIED** (NVIDIA docs) | `compatibility: best_effort` is the default; it "may skip unavailable policy paths and emits a High-severity OCSF `DetectionFinding`". `hard_requirement` is recommended, with Linux 6.2+ |
| 0.1d dropped-tool MCP defect | PENDING | Needs the issue tracker read at the pinned release |
| 0.1e telemetry off | **VERIFIED** (v0.1.5 chart + binary) | One switch was named; there are **three independent channels**. See below |
| 0.1f SDK module format | PENDING | Moot for now: the SDK is deferred. Still needed before it is ever taken |
| 0.1g audit-log coverage | **PARTIAL** (mechanism verified, coverage not) | v0.1.5 ships a configurable gateway OCSF JSONL writer, **off by default**, default path non-persistent. What it records per decision kind still needs a running gateway, which this host cannot provide: snap Docker denies the driver's `no_new_privileges`, so no sandbox starts (root-caused 2026-10-25, Launchpad #1908448) |

### 0.1e — one switch was named; there are three independent channels

Verified on v0.1.5 against the Helm chart's own `values.yaml` and against the
gateway binary, not against documentation. The gateway knows about 99 distinct
`OPENSHELL_*` environment variables (extracted from the binary; a few of those
tokens are artifacts of adjacent strings, so read it as the order of
magnitude). Eight of them govern reporting.

| Channel | Default | Chart key | Environment |
| --- | --- | --- | --- |
| Anonymous OpenShell telemetry, from the gateway **and the sandbox supervisors it launches** | **on** | `server.telemetryEnabled` (`values.yaml:358`) | `OPENSHELL_TELEMETRY_ENABLED`, `OPENSHELL_TELEMETRY_ENDPOINT` |
| OpenTelemetry trace export over OTLP/gRPC | off — endpoint empty | `server.otlp.endpoint` | `OPENSHELL_OTLP_ENDPOINT` |
| Gateway-native OCSF JSONL to a file | off | `server.ocsfLog.*` | `OPENSHELL_OCSF_JSON`, `OPENSHELL_OCSF_LOG_DIR` |
| **OCSF events over OTLP** | off — endpoint empty | **none — absent from the chart** | `OPENSHELL_OTLP_OCSF_ENDPOINT`, `OPENSHELL_OTLP_OCSF_SCHEMA_VERSION` |

**The fourth channel has no representation in the Helm chart.** `values.yaml`
is 40,742 bytes with a `server:` block spanning lines 318 to 613, and it has no
key for `OPENSHELL_OTLP_OCSF_ENDPOINT`. So an egress path for security events
exists, is settable by environment variable, and **cannot be found by reading
the chart** — which is how a deployment review of a Helm-installed gateway
would normally enumerate where data can go. This is the same shape as 0.1a's
second dynamic section and 0.1b's defaulted enforcement mode: the control
surface is wider than the document that describes it.

The roadmap's claim is correct as far as it goes: telemetry is on by default,
and `server.telemetryEnabled=false` is the switch. The incompleteness is that
it reads as ONE control over outbound reporting when it is four, and
`telemetryEnabled` governs only the first. Today the other two default to off,
so setting the named switch does leave a gateway that reports nothing — which
is exactly why this is worth writing down rather than ticking off. The decision
"telemetry is off" was never a decision about the OTLP path, so an operator who
later points a collector at `server.otlp.endpoint` reopens an egress channel
without touching the setting that recorded the intent.

**The env var is not discoverable from the CLI.**
`OPENSHELL_TELEMETRY_ENABLED` is present in the gateway binary and is honoured,
but it is NOT among the gateway's 33 long options and does not appear in
`--help`. On a binary install — which is what a non-Kubernetes host uses — the
environment is the only route, and the tool's own self-documentation does not
say the control exists.

### 0.1g — the mechanism is there; the coverage is still unmeasured

The symptom this note inherited from the v0.1.2 testing was that "the OCSF JSON
export wrote no file". On v0.1.5 the gateway's OCSF writer is a first-class
configurable feature — `server.ocsfLog` carries `enabled`, `path`,
`schemaVersion` (native 1.8.0, downgradable to 1.1 or 1.3), `rotation`,
`maxFiles`, `queueCapacity` and `queueMaxBytes`. It is **off by default**, and
its default path `/tmp/gateway-ocsf.jsonl` is documented as not persisting
across restarts.

That is consistent with the v0.1.2 symptom being the feature's default state
rather than a defect, but consistent is not the same as established, and
nothing here says what the writer records per decision kind. Phase 5.1 still
depends on that measurement.

#### Why that measurement could not be taken on this host — root-caused 2026-10-25

It needs a gateway that can actually start a sandbox, and on this host no
sandbox ever reached a running state. Both containers died with `exit=255`
inside a second, and no gateway log, retained container output or
`openshell logs` ever carried a reason. Attaching `docker logs -f` on the
container's `start` event — the stream survives the container, which the driver
removes in under a second — captured one line:

```
exec /.openshell/runtime/openshell-sandbox: operation not permitted
```

**The cause is not OpenShell.** It is a known and permanent limitation of
snap-packaged Docker, and it reduces to one command with nothing of ours in it:

```
$ docker run --rm --security-opt no-new-privileges busybox:latest echo RAN
exec /bin/echo: operation not permitted
$ docker run --rm busybox:latest echo RAN
RAN
```

snapd's own AppArmor confinement denies `no_new_privs` transitions outright
(Launchpad #1908448, open since 2020). It is not fixable in Docker and
Canonical's position is that it cannot be supported until AppArmor itself
supports it. OpenShell's Docker driver sets `no_new_privileges` on sandbox
containers, which for a sandbox is exactly right — so the driver and the
packaging are incompatible by design, not by accident, and waiting for a
release does not help.

That the driver sets it is MEASURED, not inferred from the error. The gateway's
own debug log carries the container-create payloads it sends to Docker:

```
"SecurityOpt":["no-new-privileges:true"]
"Entrypoint":["/.openshell/runtime/openshell-sandbox"]
"CapDrop":["ALL"]   "ReadonlyRootfs":true   "PidsLimit":2048
```

The entrypoint override is the staged path from the error message, so this is
the same container. Note the other three hardening options in that payload:
each was tested individually against this host and each WORKS. Only
`no-new-privileges` fails, which is why the whole hardening set looked
collectively suspect for hours while exactly one term in it was responsible.

What took four hours to find was hidden by two things worth recording, because
both will mislead the next reader the same way:

- **`EPERM` is not `EACCES`.** `man 2 execve` grants EPERM only for a
  nosuid mount with a set-user-ID file, or an LSM denial. A missing exec bit, a
  `noexec` mount or an untraversable directory all give EACCES. The binary is
  static-PIE, mode `0555`, owner `0:0`, carries no file capabilities and no
  setuid bit, so every filesystem explanation was excluded early — correctly,
  and that is why the search went to the LSM.
- **Container-level AppArmor options cannot see it.**
  `--security-opt apparmor=unconfined` changes the profile applied to the
  CONTAINER; the profile doing the denying is the snap's, confining `runc`
  itself. So the one flag that looks like it tests the hypothesis reports that
  the hypothesis is false:

```
nnp alone                                  exec /bin/echo: operation not permitted
nnp + apparmor=unconfined                  exec /bin/echo: operation not permitted
nnp + seccomp=unconfined                   exec /bin/echo: operation not permitted
apparmor=unconfined alone                  RAN
seccomp=unconfined alone                   RAN
```

An earlier round of four controls — exec from inside the image, from a named
volume, from a dot-prefixed volume path, and from a `/tmp` bind mount — was read
as DISPROVING a snap-AppArmor cause. It did not: none of those four set
`no-new-privileges`, which is the only trigger. A control that does not vary the
responsible term cannot clear it, and a set of four agreeing controls reads far
more conclusive than one.

The host kernel is not implicated: `setpriv --no-new-privs /bin/echo` runs
normally, so `no_new_privs` works outside the snap's confinement.

Measured on: snap `docker` 29.8.0 rev 3618 (publisher Canonical), containerd
`db8809540e`, kernel `7.0.0-28-generic`, `docker info` reporting
`name=apparmor,profile=default`.

**Consequence for the roadmap.** 0.1g, R-OS1 and anything else needing a running
sandbox cannot be measured on this host under snap Docker. The options are
Docker from Docker's own apt repository (removes the snap confinement; untested
here, and replacing the host's Docker affects every other container on it) or
the VM the host section already contemplates. This is independent evidence for
that section's conclusion rather than a new requirement.

### What a running v0.1.5 gateway looks like, observed

Started on the development host on 2026-10-22 from the verified binary, bound
to loopback, TLS disabled, `OPENSHELL_TELEMETRY_ENABLED=false`, Docker compute
driver:

```
readyz -> {"status":"healthy","version":"0.1.5",
           "checks":{"database":{"status":"healthy","latency_ms":0}}}
```

Four facts the roadmap did not have:

- **No external database is required.** With `--db-url` unset the gateway keeps
  state in SQLite under the XDG state directory. The `readyz` payload still
  reports a `database` check, so a healthy database there is not evidence of a
  provisioned one.
- **The Docker driver polls with a label selector** —
  `openshell.ai/managed-by=openshell`, `sandbox-namespace`, `isolation-role` —
  so it enumerates only containers it manages. On a host with unrelated
  containers it does not see them.
- **The gateway exposes no configuration read API.** `healthz` and `readyz` are
  the only HTTP routes on the health port; `config`, `configz`, `version` and
  `/api/v1/config` all return 404, and none of the 39 metric lines names a
  configuration value. **Effective configuration is not observable from
  outside the process.** Anything that reports what a gateway is running with
  is reporting what was DECLARED to it, not what it is using.
- `config preflight` validates and exits 0 without starting the service, which
  makes configuration checkable in CI without a running gateway.

### Distribution, which the supply-chain phase can rely on

v0.1.5 ships plain binaries for `x86_64-unknown-linux-gnu`/`-musl`,
`aarch64-unknown-linux-gnu`/`-musl` and `aarch64-apple-darwin`, plus `.deb`,
`.rpm`, a snap and a Python wheel. Each component publishes its own
`*-checksums-sha256.txt`. The gateway, supervisor, sandbox, prover and CLI were
downloaded and **all five verified against those published sums**.

Two consequences. A gateway needs no Kubernetes — `deploy/helm` and
`deploy/kube` exist but are one option among `deploy/docker`, `deploy/deb` and
`deploy/rpm`. And `sandbox` ships ONLY for linux-musl, with no Darwin build,
which is the architecture-level statement of why a macOS host cannot run
sandboxes even though it can run the gateway and CLI.

### A correction to the roadmap's own precedent for 0.3

0.3 says "follow the harness-scanner precedent: its own VM
(`deploy/harness-scanner/vm.sh`, `.github/workflows/scanner-vm.yml`)". That
script defaults `VM_NAME` to `inflect-compliance` (`vm.sh:24`) and no VM
matching `*scanner*` exists in the project. The harness scanner is a compose
overlay **on the production app VM**, so the cited precedent is not an example
of the thing it is cited for. 0.3's requirement stands on its own reasoning —
a Docker compute driver means socket access, which is root-equivalent — but it
has no precedent in this repository to follow.

### 0.1a — the roadmap names one dynamic section; there are two

The roadmap says a policy has "one **dynamic** section, `network_policies`".
The documentation describes a second: `network_middlewares`, which "declares
keyed HTTP and WebSocket middleware configs" that run **after policy admission
and independently of which `network_policies` rule allowed the traffic**.

This matters beyond tidiness. Phase 5.2 detects drift by comparing a committed
policy with the live one, and `policy set` replaces the whole policy rather than
merging. A drift check that hashes only `network_policies` would not notice a
middleware appearing, disappearing or being reordered on a running sandbox —
and a middleware that runs after admission is in the data path of every request
the policy allowed. **Phase 5.2 must hash both dynamic sections.**

### 0.1b — the vendor's own documentation says the default is audit

This is the roadmap's most consequential claim, and it arrived there from a
third-party evaluation of v0.1.2: a forbidden POST went through and was logged
as ALLOWED.

The vendor corroborates it. NVIDIA's security best-practices page states the
default plainly — `audit`, logging violations while forwarding traffic — and
frames it as deliberate: start in audit to "understand traffic patterns and
verify that rules are correct", then switch to `enforce`, which blocks
non-matching requests with a 403.

So this fact no longer rests on a third-party report, and it does not need a
gateway to establish. What a gateway would add is confirmation that the
documented default is the implemented one on the pinned release, which is worth
having but is no longer load-bearing.

**The consequence for this product is unchanged and now better supported:** a
policy can read as restrictive while restricting nothing, so
`enforcement: enforce` must be set explicitly on every endpoint and checked
mechanically in CI (phase 4), and an audit-mode endpoint must evidence nothing
in the scanner (phase 1.3b) and the skill (phase 3.3).

**A documentation gap worth noting.** The schema reference does not state the
endpoint default; only the security page does. A reader authoring a policy from
the schema reference alone would not learn that omitting `enforcement` disables
enforcement. That is the shape of defect this integration exists to catch in
client estates, and it is present in the vendor's own documentation set.

### 0.1c — best_effort is not silent

The roadmap's reading is that a `best_effort` ruleset may be dropped whole
(NVIDIA/OpenShell#664) and so is not evidence of confinement. The documentation
adds a detail the roadmap does not carry: skipping a path **emits a
High-severity OCSF `DetectionFinding`**, and the guidance is to investigate those
rather than treat a skipped policy as acceptable.

That does not change the verdict — a ruleset that may have been reduced is still
not evidence of confinement, and phase 1.3b stands. It does change what the
scanner can look for: the finding is an observable, so a client estate running
`best_effort` may have evidence of **which** paths were skipped. Worth
considering for phase 1 as a second-order signal rather than assuming silence.

## 0.2 — supply chain: the SDK is deferred

Recorded above under the owner decisions. The route taken is the gateway RPC
directly. Consequences to carry into phase 4.2:

- no `.npmrc`, no `read:packages` token, no BuildKit secret mount, and no new
  transitive dependencies presented to the blocking audit gate;
- the RPC calls are hand-written, so the typed surface the SDK would have given
  is replaced by our own types and our own tests;
- 0.1f stays open rather than answered. If the SDK is taken later and is
  ESM-only, it must be imported only from an isolated boundary module, the way
  `flue/agent.ts` isolates `@flue/runtime`, which already needs its own jest
  project.

## 0.3 — the host

Not yet chosen; it needs infrastructure this phase did not provision. The
requirements are fixed and recorded here so that choosing one is mechanical:

- **not** the production app VM, which runs eight compose services. A gateway
  creates sandboxes through a compute driver, and with Docker that means socket
  access, which is root-equivalent on the host.
- follow the harness-scanner precedent — its own VM
  (`deploy/harness-scanner/vm.sh`, `.github/workflows/scanner-vm.yml`).
- **Linux 6.2 or newer with Landlock enabled**, per NVIDIA's own guidance, and
  the ABI confirmed before the gateway is configured. Under
  `hard_requirement` the gateway refuses to start without it, which is the
  behaviour to want rather than to work around.

## 0.4 — the four decisions, taken 2026-10-21

**D1 — OpenShell sandboxes report under the existing `runtime` source kind.**
No contract change. The contract already defines `runtime` as "a deployment,
and the secrets it runs with", and LangSmith set the precedent. A new kind would
need `/4`, because kinds are a closed list on the wire.

**D2 — a new ladder criterion, `H3.egress_enforced`, on H3.** No contract bump:
the verifier checks each verdict's criterion with `isHarnessCriterionId` against
the live ladder, so an id added to the ladder is accepted without a version
change. That is also the hazard — a scanner emitting an id an ingest does not
define gets its **whole report** refused, so the ingest must be live before any
scanner build carries it.

**D3 — the first internal workload is the Powerpipe collectors.** Re-measured
on `origin/main 0e9cd611e`: two real `child_process` call sites,
`aws-posture-provider.ts` (one call) and `cloud-posture/powerpipe-core.ts`
(two). `bounded-exec.ts` also matches a grep but is the seam itself, and
`packages/agent-harness-scanner/src/sources/langchain.ts` matches only in a
docblock describing what `eslint.config.mjs` forbids there — zero real calls.
So "two sites" is right, and a naive file count says four.

**D4 — split by role: pipelock mediates MCP, OpenShell does not.** pipelock is
the designed signer of agent action receipts, the externally verifiable evidence
behind `H4.receipts`, and it is wired through 44 files. OpenShell produces no
signed per-decision receipts, so retiring pipelock would have removed an
evidence source with nothing to replace it.

**D4 was asked twice, and that is worth recording.** The first version of the
question described pipelock as an overlay that was defined but never activated,
and on that description the answer was to retire it. The description was
incomplete — it missed the receipt role entirely — and the answer changed once
that was stated. A decision whose input description was wrong the first time is
worth marking as such, because the reasoning that produced the first answer was
sound on the facts it was given.

## What this phase did not establish

0.1e is now settled on v0.1.5 and is recorded above; it needed the chart and
the binary rather than a running gateway. **One fact still needs a running
gateway**: what the audit log records per decision kind (0.1g). Phase 5.1
depends on it — a decision OpenShell never records cannot be bridged into the
hash-chained `AuditLog`, and claiming otherwise would put the gap in Inflect's
compliance record instead of the vendor's. 0.1c's stated behaviour, that
`hard_requirement` refuses to start rather than skipping a path, is also still
a documentation claim and not an observation.

One documentation URL the roadmap cites as a source,
`docs.nvidia.com/openshell/latest/reference/policy-schema`, does not resolve.
The facts attributed to it were re-established from the versioned
`sandboxes/policies` page and the security best-practices page instead.
