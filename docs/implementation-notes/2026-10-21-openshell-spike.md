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
as 0.1.x, so **the version string needs settling against the repository's own
releases before any policy is authored** — a documentation set that answers at
`v0.0.116` and a product described as 0.1.x are not obviously the same thing.

| Fact | Status | What was established |
| --- | --- | --- |
| 0.1a schema and sections | **VERIFIED** (docs) | `version: 1`. Static: `filesystem_policy`, `landlock`, `process`. Dynamic: `network_policies` **and `network_middlewares`** |
| 0.1b enforcement default | **VERIFIED** (NVIDIA docs) | An endpoint's `enforcement` defaults to **`audit`**: the proxy "logs violations but forwards traffic" without blocking |
| 0.1c Landlock default | **VERIFIED** (NVIDIA docs) | `compatibility: best_effort` is the default; it "may skip unavailable policy paths and emits a High-severity OCSF `DetectionFinding`". `hard_requirement` is recommended, with Linux 6.2+ |
| 0.1d dropped-tool MCP defect | PENDING | Needs the issue tracker read at the pinned release |
| 0.1e telemetry off | **UNVERIFIED — needs gateway** | The security best-practices page does not mention telemetry at all |
| 0.1f SDK module format | PENDING | Moot for now: the SDK is deferred. Still needed before it is ever taken |
| 0.1g audit-log coverage | **UNVERIFIED — needs gateway** | Per-decision coverage cannot be read from documentation |

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

Two facts need a gateway and are not guessed here: whether telemetry can be
turned off completely (0.1e), and what the audit log actually records per
decision kind (0.1g). Phase 5.1 depends on the second — a decision OpenShell
never records cannot be bridged into the hash-chained `AuditLog`, and claiming
otherwise would put the gap in Inflect's compliance record instead of the
vendor's.

One documentation URL the roadmap cites as a source,
`docs.nvidia.com/openshell/latest/reference/policy-schema`, does not resolve.
The facts attributed to it were re-established from the versioned
`sandboxes/policies` page and the security best-practices page instead.
