# 2026-11-16 — the collector waits for the credential it attached

**Commit:** `(this PR)` fix(openshell): wait for the gateway's provider-readiness observation before running the collector

## Design

`AttachSandboxProvider` does not install a credential. The vendored proto says so
in the response itself:

```proto
message AttachSandboxProviderResponse {
  Sandbox sandbox = 1;
  bool attached = 2;
  // Persisted intent; readiness requires current supervisor observations.
  ProviderMutationReceipt receipt = 3;
}
```

Readiness is a separate RPC — `GetSandboxProviderStatus` on the receipt's id —
and its `observed_time` is documented *"absent until the current supervisor
session supplies accepted evidence"*.

The product awaited one unary and ran powerpipe:

```
before:   create ──► attach(intent) ──► exec        credential may not be there
after:    create ──► attach(intent) ──► await READY ──► exec
                                            │
                                            └─► REFUSED ──► no exec, named failure
```

The wait lives in the collector's `onSandboxReady` hook, which the executor runs
after the sandbox exists and before the tool — the last place that can still
decline to run it.

Three layers, deliberately separate:

| layer | file | what it decides |
| --- | --- | --- |
| pure | `openshell/provider-readiness.ts` | READY / WAIT / REFUSED per state |
| transport | `openshell/grpc-transport.ts` | the bounded poll, and the typed refusal |
| collector | `cloud-posture/sandboxed-collector-exec.ts` | classify it so the ladder reads it |

## Files

| File | Role |
| --- | --- |
| `src/lib/agentic/openshell/provider-readiness.ts` | NEW. The eight states, the verdict table, `describeReadiness` |
| `src/lib/agentic/openshell/transport.ts` | `attachProvider` returns the attachment; `awaitProviderReady`; `ProviderNotReadyError`; the false docstring corrected |
| `src/lib/agentic/openshell/grpc-transport.ts` | Reads the attach response; polls `GetSandboxProviderStatus` under two bounds |
| `src/app-layer/integrations/cloud-posture/sandboxed-collector-exec.ts` | Waits between attach and exec; `SANDBOX_PROVIDER_NOT_READY` |
| `tests/guards/agent-action-receipt.test.ts` | Classifies the new module in the directory enumeration |
| `tests/guardrails/openshell-proto-matches-its-provenance.test.ts` | Five methods → six |

## Decisions

- **The verdict is a `Record` over the closed union, not a comparison.**
  `state === '…_READY'` is correct today and silently wrong the day the gateway
  adds a state. A re-vendored proto carrying a ninth state fails `tsc` until
  somebody classifies it — the shape `SIGNAL_STRENGTH` uses in the reconcile
  engine, for the same reason.

- **`UNSPECIFIED` waits; an UNRECOGNISED state refuses.** They look alike and are
  not. `UNSPECIFIED` is the proto's zero value — the answer a field carries while
  the gateway has not filled it in — and a propagating attachment legitimately
  reads that way for a moment; it is emphatically not READY, the same reading
  `DELETION_IS_SETTLED` gives its own UNSPECIFIED. A state this build has never
  heard of is different: waiting would spend the whole setup budget and then
  report a timeout, when the real fact is that we do not understand the gateway
  we are talking to. Refusing names the surprise when it arrives.

- **`SUPERSEDED` refuses rather than waits.** A newer desired state replaced the
  receipt this caller holds, so no amount of polling makes THIS one ready — and
  whatever did win was configured by somebody else, which is precisely the
  shared-credential confusion #5251 is about.

- **Bounded twice.** By the caller's `AbortSignal`, which covers the whole
  collection, and by `PROVIDER_READY_TIMEOUT_MS` (20s), which is this wait's own
  patience. A credential not installed within seconds of a persisted attachment is
  stuck, not propagating; refusing and letting the next scheduled scan try is
  better than spending the run's budget to report a timeout.

- **`ProviderNotReadyError` is NOT `SandboxUnreachableError`.** The gateway
  answered: it is up, it took the attachment, and it says the credential is not
  installed. Conflating them reports a withheld credential as an outage and sends
  an operator to check the gateway instead of the provider record. The collector
  gives it its own refusal constant for the same reason, beside — not replacing —
  `SANDBOX_PROVIDER_NOT_TENANT_SCOPED`.

- **`credentials_installed` is reported, never used as the gate.** It is one
  field of `ProviderReadinessObservation`, and a provider can have its credential
  installed while its policy is not yet active. The state is the gate; the
  observation goes in the refusal's text, where it is the most useful thing an
  operator can be told. `false` stays distinguishable from "not reported".

- **The docstring was fixed in the direction the code moved.** It previously said
  "The collector bridge does exactly that" about a wait that did not exist. That
  is worse than silence: it is the sentence a reviewer relies on to conclude the
  race is already handled. It now names `awaitProviderReady` and records what it
  used to claim.

- **Latent, not live — and that is why it is its own PR.** #5475 makes
  `collectorExecForDeploy()` refuse when no `providerName` is passed, and all
  three posture providers pass none, so the sandboxed path is inert today. #5476
  makes it live. Landing this first means #5476 builds on a path that can prove
  the credential was present, which its own acceptance criterion ("a scan for
  tenant A attaches a provider holding A's credential") requires and a persisted
  intent cannot give.
