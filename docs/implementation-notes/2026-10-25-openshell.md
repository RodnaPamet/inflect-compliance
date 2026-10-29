# OpenShell: the implementation note

Phase 5.5 (#3975), part of #3924. Written at the end of the phase that measured
what the spike could not, so several things here correct the spike note rather
than summarising it.

No doc-classification entry accompanies this file. `docs/implementation-notes/`
is **historical-by-path** — `docs-accuracy` classifies the subtree `historical`
and exempts it from the freshness banner — so adding an entry fails the ratchet
rather than satisfying it.

## 1. The pinned version

| | |
|---|---|
| Release | **v0.1.5** |
| Vendored skills commit | `bdb956f2cd65a635f1294fccf1d138d263bf650f` |
| Sandbox runtime image | `ghcr.io/nvidia/openshell/sandbox@sha256:d60222e1183ad3212436507c4b9035c0aeda1c1bba4a00a02ec7949fb0a0d7b2` |
| Supervisor image | `ghcr.io/nvidia/openshell/supervisor@sha256:07cc8b62b34a0b54a3ebeb485cebe9f223cffe10dad819af550849cf0699816f` |

Two version spaces exist and they are easy to confuse: the project's **releases**
run `0.1.x`, while the published documentation versions itself `v0.0.116`. They
are not the same number. Every third-party defect this phase inherited was found
on **v0.1.2**, three patch releases behind the pin.

The binaries are verified to a published checksum, and the chain is worth stating
because the checksums cover the **archives**, not the extracted files: published
`SHA256SUMS` → tarball → extracted binary (compared to the installed one) →
host-to-VM transfer. All four links were checked.

## 2. D1–D4, the four decisions

**D1 — OpenShell sandboxes report under the existing `runtime` source kind.** No
contract change. The contract already defines `runtime` as "a deployment, and the
secrets it runs with", and LangSmith set the precedent. A new kind would need
`/4`, because kinds are a closed list on the wire.

**D2 — a new ladder criterion, `H3.egress_enforced`, on H3.** No contract bump:
the verifier checks each verdict's criterion against the live ladder, so an id
added to the ladder is accepted without a version change. That is also the
hazard — a scanner emitting an id the ingest does not define gets its **whole
report** refused, so the ingest must be live before any scanner build carries it.

**D3 — the first internal workload is the Powerpipe collectors.** Two real
`child_process` call sites: `aws-posture-provider.ts` (one) and
`cloud-posture/powerpipe-core.ts` (two). `bounded-exec.ts` matches a grep but is
the seam itself, and the scanner's `langchain.ts` matches only in a docblock. A
naive file count says four.

**D4 — split by role: pipelock mediates MCP, OpenShell does not.** pipelock is the
designed signer of agent action receipts, the externally verifiable evidence
behind `H4.receipts`, wired through 44 files. OpenShell produces no signed
per-decision receipts, so retiring pipelock would have removed an evidence source
with nothing to replace it.

**D4 was asked twice.** The first version of the question described pipelock as an
overlay defined but never activated, and on that description the answer was to
retire it. The description missed the receipt role entirely, and the answer
changed once that was stated. Recorded because the first answer was sound on the
facts it was given.

## 3. Why the repository skill is Inflect-original

Four NVIDIA skills are vendored byte-for-byte at the pinned commit, verified
against GitHub's own git blob SHAs, with a SHA-256 manifest and the upstream
Apache-2.0 licence (#4058). The repository's own policy-review skill (#3994) is
**not** derived from them, and the reason is a measurement rather than a
preference:

NVIDIA's `generate-sandbox-policy` scaffolds
`landlock: compatibility: best_effort` as a "sensible default", and
`hard_requirement` appears **zero times across all six vendored files**. Under
`best_effort`, a host without Landlock runs the sandbox with no filesystem
isolation **and reports success**. Our gate requires `hard_requirement`, so a
policy generated from that scaffold is rejected by our own gate.

A skill that produces output our gate refuses cannot be the basis of the skill
that reviews it. Vendoring the upstream four for reference and authoring our own
reviewer is the split that follows.

## 4. Why OpenShell routes no inference

Verified against the pinned binary rather than assumed. The gateway compiles in
**no inference invocation path**: no `api.anthropic.com`, `api.openai.com`,
`openrouter.ai` or `generativelanguage` host, and no `InvokeModel`-shaped route.
The single family of matches is `bedrock` / `bedrock-runtime`, and every one of
them is **configuration help text** — `e.g. "bedrock" for bedrock-runtime
endpoints` — naming an example endpoint an operator might allow, not a
destination the gateway calls.

What OpenShell actually interposes, measured on a running sandbox: a forward
proxy on `127.0.0.1:3128` and a policy DNS resolver bound to the isolation
boundary. A raw TCP connect from inside a sandbox returns `Network is
unreachable`. So an inference call made by a sandboxed workload would have to be
**allowed through** that boundary by policy; OpenShell is the thing that can
refuse it, never the thing that performs it.

That is the "backstop at most" position, and it is the strongest form the claim
supports. The full residency analysis belongs to 4.4 (#3966). One naming trap for
whoever picks that up: `debug-inference` is one of the four **vendored NVIDIA**
skills, so the word "inference" appears in this repository's skills tree for a
reason unrelated to our own routing.

## 5. Why the gateway is not on the app VM

A gateway creates sandboxes through a compute driver, and with Docker that means
**socket access, which is root-equivalent on the host**. The production app VM
runs eight compose services, so granting that there would put the whole stack
inside the blast radius of the component whose purpose is to contain things.

**There is no precedent for this in the repository, and an earlier version of
this note claimed there was.** It said the harness scanner has its own VM, citing
`deploy/harness-scanner/vm.sh`. That script's own header reads "THE HARNESS
SCANNER ON THE PRODUCTION VM", and its `VM_NAME` defaults to
`inflect-compliance` — the same default as `deploy/apply.sh` and
`deploy/check-drift.sh`. All three target one host. The scanner is an overlay on
the production VM, not a second VM, so the gateway VM would be this project's
first.

Corrected while delivering 4.3 (#3964), where the claim would have been
load-bearing: it was the stated reason the own-VM requirement was cheap.

Phase 4/5 added a second, independent reason the spike could not have known. The
development host runs **snap-packaged Docker**, and snapd's AppArmor confinement
denies `no_new_privs` transitions outright (Launchpad #1908448, open since 2020,
and not fixable until AppArmor itself supports it). OpenShell's Docker driver
sets `no_new_privileges` on sandbox containers — correctly, for a sandbox — so
driver and packaging are incompatible **by design**, and no release fixes it. It
reduces to one command with nothing of ours in it:

```
$ docker run --rm --security-opt no-new-privileges busybox:latest echo RAN
exec /bin/echo: operation not permitted
```

So the host requirement is not merely "its own VM" but "its own VM with Docker
from Docker's apt repository". A dedicated VM built that way reaches `Ready`
sandboxes with the same images and configuration the dev host cannot start at
all. Linux 6.2+ with Landlock remains required, and under `hard_requirement` the
gateway refuses to start without it — the behaviour to want rather than work
around.

## 4.4 residency — what is deferred, and one gap found while deferring it

**Deferred by owner condition: per-residency-class sandboxes (#3966).** The
reasoning follows, and a guard holds the state this describes — see the last
test in `tests/guards/flue-provider-is-never-set-per-run.test.ts`, which fails
the moment a policy starts varying by residency class.

Kernel network policy could backstop a `LOCAL_ONLY` decision by denying
non-local model egress. It is out of scope because the shapes do not line up:
one worker process serves many tenants, while OpenShell confines per sandbox.
A per-tenant backstop therefore needs **per-residency-class sandboxes** — a
topology change, not a policy edit — and #3966 rules it out "unless the owner
pulls it in". Recorded here as well as in
`tests/guards/flue-provider-is-never-set-per-run.test.ts`, because an option
deferred only in a comment nobody reads is indistinguishable from one that was
forgotten.

**And a gap the deferral surfaced, in our own policy.** The collector policy
(4.1) is provider-scoped rather than per-service, for the reason recorded
there: the host set is not derivable from this repository. One cost of that
width is now named:

```
GCP policy allows   *.googleapis.com
which admits        generativelanguage.googleapis.com   ← a model provider
```

So a GCP collector sandbox has an egress path to an inference API that
`model-selection.ts` never decided. It is narrow — the workload is Powerpipe
running a compliance benchmark, not an agent — but it is exactly the second
route #3966 exists to prevent, and it is admitted by a wildcard rather than by
an endpoint anyone wrote down.

It is **asserted as a known property** rather than silently left: a test pins
that the wildcard admits it, so the fact cannot be discovered later as a
surprise, and narrowing cannot be mistaken for something already done.
Narrowing needs a real run's denials, which is #3961's undelivered half and
needs a deployed gateway. The alternative available today — dropping
`*.googleapis.com` for a guessed service list — would break collection on the
first service the guess missed, and a broken collector returns ERROR, which is
fail-closed but useless.

## 4.3 deployment — three findings that changed the shape of it

**1. There is no gateway container image for this release.**
`ghcr.io/nvidia/openshell/gateway` holds 4000 tags whose highest semantic
version is **0.0.91**, built **2026-07-24**; `docker run … --version` on it
reports `openshell-gateway 0.0.91` against our binary's `0.1.5`. It is also
missing nine flags the 0.1.5 binary has, three of which this phase needs —
`--compute-driver`, `--enable-operator-auth`, `--oidc-jwks-allowed-origins`.
Using it would pair a 0.1.5 SDK with a 0.0.91 gateway, breaking this phase's own
rule that pre-1.0 the two move together. So the gateway runs from the
checksum-verified binary as a systemd unit, and what is an image here — the two
the Docker driver pulls — is digest-pinned.

This also means a **fourth** numbering space. The note above records two
(releases `0.1.x`, docs `v0.0.116`); the container images are a third at
`0.0.91`, and none of the three agree.

**2. A release tag was re-pushed inside 72 hours.** With no configuration the
gateway resolves its driver images by mutable tag — observed in its own Docker
socket traffic, `GET /images/ghcr.io/nvidia/openshell/sandbox:0.1.5/json`. The
digests in § 1 were recorded 2026-10-24. Re-resolved 2026-10-27:

```
sandbox:0.1.5     -> sha256:e9adf9ec…    recorded: sha256:d60222e1…
supervisor:0.1.5  -> sha256:fabcd01f…    recorded: sha256:07cc8b62…
```

Both recorded digests still exist and still pull, so the record was not wrong —
the tag moved. The pinned table above is therefore authoritative and `:0.1.5` is
not, which is the difference between pinning as ceremony and pinning as a
control.

**3. The telemetry setting is not self-verifying.** Anonymous telemetry is
default ON, which is why 4.3 requires `OPENSHELL_TELEMETRY_ENABLED=false`. The
variable is present in the 0.1.5 binary but absent from `--help`, an invalid
value is accepted silently, and three traced 18-second runs — unset, `false`,
`notabool` — were indistinguishable: no telemetry egress in any of them and
nothing in the logs at debug level. So the setting is a request, and the
enforcement is an egress rule denying
`https://events.telemetry.data.nvidia.com/v1.1/events/jsonstruct`.

**And one thing 4.3 cannot deliver.** The VM does not exist. GCP project
`hazel-design-419410` holds one commitment, `agrent-inflect-e2-3yr`
(`VCPU;MEMORY = 4;32768`, europe-west1, to 2029-09-21), and a commitment is
regional and aggregated across the instance family rather than per-VM. Both
existing VMs consume it exactly, so a third bills entirely on-demand. That is a
cost decision for the owner, not a deployment step, and nothing in
`deploy/openshell/` provisions anything.

## 0.1f — there is no JavaScript SDK, so there is nothing to isolate

#3931 asked whether `@nvidia/openshell-sdk` is ESM-only, because if it were,
phase 4 would need the `@flue/runtime` treatment: its own jest project and a
boundary module carrying "MUST NEVER BE IMPORTED FROM THE MAIN SRC GRAPH".

**That package does not exist.** Measured against the registry rather than a
README, which is what the issue asked for:

| | |
|---|---|
| `@nvidia/openshell-sdk` on npm | **404** |
| npm packages mentioning OpenShell | **39**, and NONE published by NVIDIA |
| The official SDK | `pypi/openshell` **0.1.6** — author NVIDIA Inc., source `github.com/NVIDIA/OpenShell`, `requires_python >=3.11` |

So the module-format question does not arise, and the isolation requirement is
**none** — for a stronger reason than a friendly module format. A Python package
cannot enter a Node import graph under any module format, so there is no import
to isolate and no second jest project to add.

What phase 4 does instead was already the right shape before this was asked.
`SandboxTransport` is four hand-written calls over the gateway's own gRPC
surface, and the repository depends on no OpenShell package from anybody:
`package.json` names none and the lockfile contains zero. 0.1f's concern is
therefore satisfied by construction, and a test below holds it that way rather
than leaving it as a property nobody re-checks.

### The trap, which is the half worth keeping

The ESM-only worry in #3931 is **true of a package that is not NVIDIA's**:

```
@openkaiden/opnshll-sdk   0.1.6
  "Official TypeScript SDK for the OpenShell gateway."
  type: module            → genuinely ESM-only
  maintainer: an individual, not NVIDIA
```

It calls itself official, it is ESM-only exactly as the issue feared, its
version mirrors the real release, and its name is a vowel-dropped lookalike of
`openshell`. Every signal #3931 would have used to identify the SDK points at
it. Adopting it would be a **supply-chain decision wearing a module-format
costume**, and the answer to 0.1f is the reason we will not need to take it.

### And a newer release exists

`v0.1.6` shipped **2026-10-27**, a week after the pinned `v0.1.5`, which is how
the PyPI SDK is at 0.1.6. The pin is one release behind and is deliberately
unchanged here: taking it runs 5.3's checklist in full, which is its own work
rather than a side effect of a spike answer. It is registered in
`KNOWN_NEWER_RELEASES` so the discovery is recorded without the pin moving —
that register exists because this finding could not otherwise be written down.

## 0.1e — telemetry CAN be turned off completely, and 4.3 was wrong about it

Measured on the lab VM against a DNS sinkhole: `events.telemetry.data.nvidia.com`
mapped to `127.0.0.1` with a listener on 443, a positive control connection
before every arm, and the gateway's `readyz` gated at the START AND END of each
300-second window — a window whose subject died partway measures nothing, which
is how the first attempt failed.

| setting | activity in the window | bytes to the telemetry host |
|---|---|---|
| default (variable unset) | create + list + delete | **3013** |
| default (variable unset) | create + list + delete (repeat) | **3013** |
| default (variable unset) | list only | **0** |
| `OPENSHELL_TELEMETRY_ENABLED=false` | create + list + delete | **0** |

Three findings, in order of how much they change:

1. **Telemetry is ON by default** and sends real bytes to NVIDIA.
2. **The variable turns it off completely** — zero bytes with identical activity.
3. **It is EVENT-DRIVEN, not periodic.** Five minutes of a running gateway with
   only `sandbox list` produced nothing; the sends follow sandbox lifecycle
   activity. The byte count was identical across two independent runs, which
   suggests a deterministic payload per unit of activity.

### This corrects 4.3 (#4416)

4.3 recorded that the setting "is not self-verifying" and that three traced
18-second runs — unset, `false`, `notabool` — were indistinguishable, concluding
that the setting is a request and the egress rule is the enforcement.

**The first half of that is wrong.** The setting is effective and its effect is
observable. The 18-second window was too short, and worse, those runs had no
sandbox lifecycle activity at all — so the probe was watching for an
event-driven send while generating no events. It was a probe with no
discriminating power, and it read as evidence of absence.

What survives: the egress rule is still worth having, as defence that does not
depend on a third party honouring its own flag. What does not survive is the
implication that the flag might not work. It works.

## 0.1g — what the audit log records, per decision kind

Measured on the pinned release with the OCSF writer configured and demonstrably
live: it wrote a record to exactly the configured path and registered eight
`*ocsf*` metric series, so the zeros below are observations rather than an inert
probe. `--config` is read and strictly validated — a bogus `compute_driver` is
rejected as a `configuration error`, and a bogus key or table fails to parse —
so `[openshell.gateway.ocsf_log] path` is an accepted setting.

| decision kind | in the OCSF log | queryable through the API |
|---|---|---|
| created | **no** | yes — `sandbox get`: id, phase, resource version, main process instance, restart count |
| policy changed | **no** | yes — `policy list`: version, hash, status, created |
| execution refused | not established | — |
| network denied | **no** | **no** |
| deleted | **no** | **no** — `sandbox get` answers "sandbox not found" |

The whole log held ONE record across the session: `class_uid 3002`,
`Authentication: Logon`, status `Failure`. An attribution test settles the
lifecycle rows — a create (sandbox confirmed present) followed by a delete
(confirmed absent) added **zero** records.

The network-denied row is a confirmed denial, not an assumption: an egress
attempt from inside a sandbox returned `connect: Permission denied`, and the
gateway's own stdout logged nothing about it either. The denial happens in the
sandbox's kernel enforcement and the gateway never sees it — which is the
third-party v0.1.2 finding this issue cites, holding on the pinned release.

### What this decides for 5.1

Not merely "OpenShell's logs are inputs". Of the five decision kinds, **none is
bridgeable from the OCSF log**. Two are bridgeable by POLLING the API, and
**deletion is bridgeable from neither after the fact** — the sandbox record is
gone and the log never held it.

So a deletion must be recorded by US at the moment we make it, because nothing
on the gateway side retains a trace we can read later. That is what 5.4's drill
arm already does: it confirms absence itself rather than trusting a record.

## 0.1d — the dropped-tool MCP rule defect is NOT established as fixed

| | |
|---|---|
| Upstream NVIDIA/OpenShell#4679 | **open**, label `state:triage-needed`, no milestone, never closed |
| The defect's own flow on the pinned release | **unreachable** — the CLI exposes no proposal or approval verb |
| Observing a dropped field directly | **not possible** — `policy get -o json` returns metadata only (version, hash, source, status) and no policy body |

So the honest answer is "not fixed, and not reproducible from our surface
either", with the reasons recorded rather than a verdict asserted. No release
claims the fix, and nothing in the pinned release lets us watch an approval drop
a field.

What makes that tolerable internally is D4: Inflect's own policies carry no MCP
rules, and `agent-action-receipt`'s D4 block enforces it, so the defect is
sidestepped here by construction rather than by upstream's fix.

**The phase 3 instruction therefore stands as written:** the audit skill must
treat advisor-approved MCP rules in a client estate as UNVERIFIED. That
instruction was correct only if the defect is live, and this is the measurement
that says it is — or more precisely, that nothing shows it is not.

## 4.1 — the GCP allowlist is narrowed, and one inference origin is irreducible

`*.googleapis.com` is gone. The GCP collector now names **38 explicit hosts**,
derived rather than guessed: the steampipe GCP plugin builds every API client it
will ever use in one file, `gcp/service.go`, so its services are enumerable from
its imports — 35 under `google.golang.org/api/<service>/v*` plus `aiplatform`
and `redis` under `cloud.google.com/go`, and `oauth2.googleapis.com` for token
acquisition. A cross-check against the plugin's 123 `table_gcp_*.go` files found
no service family outside that set.

4.1 recorded that the per-service set "is not derivable from this repository".
That stays true; it is derivable from the **plugin's** repository, which is a
different claim and the one that closed this. No credentials were needed and
nothing was read from any live estate.

### What it closes

4.4 (#4409) pinned two inference hosts reachable through wildcards. The GCP half
is now closed: **`generativelanguage.googleapis.com` is no longer reachable.**

### The half that cannot be closed by a host rule

`aiplatform.googleapis.com` survives the narrowing, deliberately. The plugin has
Vertex AI tables and audits its configuration, and Vertex AI serves
configuration reads and `:predict` / `:generateContent` **on the same origin**.
So no host-level allowlist can permit the audit and deny the inference — they
are one host. It is now named explicitly with its reason beside it, which is
strictly better than being admitted by a wildcard nobody reviewed.

Closing the residual needs an L7 rule on method and path. The gateway supports
one (`host:port:METHOD:path_glob`), and writing it safely needs a real run's
paths, so it is recorded as the residual rather than guessed at.

AWS is still `*.amazonaws.com`, and still admits `bedrock-runtime`. The same
derivation is possible for the AWS plugin but is a larger job: AWS endpoints are
regional, so a per-service list is region-parameterised, and the service count
is far higher than GCP's.

### If the derived list is wrong

A service the plugin needs and the list omits makes that query fail, and the
collector's existing semantics fail the collection **closed** — `ERROR`, never a
quiet `PASSED`. So an incomplete list is observable rather than silent, which is
what makes narrowing from a derived set an acceptable risk instead of a guess.

## Retention classification

**No new model.** `prisma/schema.prisma` declares no sandbox- or
OpenShell-named model, and `retention-policy-coverage` passes 7/7 on this
branch, so there is nothing for `docs/data-retention.md` to classify. Stated as a
measurement because the issue's wording ("the retention ratchet fails until you
do") implies a model exists, and silently omitting a classification is
indistinguishable from forgetting one.

Two retention facts that are **not** ours to classify but belong on the record,
because a reader will reasonably look for them here:

- The gateway's OCSF audit log rotates **daily and keeps 3** by default
  (`openshell-ocsf.<date>.log`), so that artefact deletes itself well inside most
  review cycles.
- Sandbox-level OCSF events exist only as **text on per-container stdout**, and
  the Docker driver removes a container within a second of exit. Nothing durable
  retains them unless a log driver ships them first.

Both are measured (0.1g, #4225) and both bear on what 5.1 can claim.
