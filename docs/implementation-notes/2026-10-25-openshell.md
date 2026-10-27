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

The precedent is already in the repository: the harness scanner has its own VM
(`deploy/harness-scanner/vm.sh`, `.github/workflows/scanner-vm.yml`).

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
