# 2026-10-30 — the local AI gateway rule has one definition

**Issue:** #4545 · **follows** #4556

## What this is, and what it is not

#4545 was an SSRF plus a credential leak: `TenantSecuritySettings.aiLocalBaseUrl`
is writable by any `admin.manage` holder, the risk-suggestion provider dialled it
with a bare `fetch`, and attached `AI_LOCAL_API_KEY` as a bearer.

**That hole was closed by #4556**, inline in `buildLocalProvider`. This change
fixes nothing further and alters no behaviour. It addresses the reason the hole
existed.

## The reason

`resolveFlueModel` had already refused exactly this, as
`LOCAL_GATEWAY_NOT_SERVED` — *"what is decided here must be what is dialled
there."* The risk factory next door did not, and **nothing anywhere could tell
you the two disagreed.**

After #4556 the repository held two copies of one rule: Flue's at
`model-selection.ts:209` and the factory's new one. Two copies of a rule
eventually disagree, and the direction a drifted copy disagrees in is the
direction that grants access. So:

| File | Role |
| --- | --- |
| `src/lib/ai/local-gateway.ts` | NEW. `resolveLocalGateway` — the rule. Reads `@/env` and nothing else, so either layer can import it without dragging a module graph across the seam. |
| `src/app-layer/ai/risk-assessment/index.ts` | #4556's fix, refactored onto the shared rule. Same answers, same log line. |
| `src/lib/agentic/flue/model-selection.ts` | Reads the shared rule instead of its own inline comparison. |
| `tests/guards/ssrf-egress-coverage.test.ts` | A git-derived population of `env.AI_LOCAL_BASE_URL` readers, asserted by exact set equality. |
| `tests/unit/ai/local-gateway-one-rule.test.ts` | NEW. The property the two callers' own suites cannot state. |

## Decisions

- **`safeFetch` is deliberately not involved**, and the guard now says so where
  somebody would otherwise "fix" the omission. `assertPublicAddress` refuses
  private, loopback and link-local addresses, and a local inference gateway is
  *supposed* to be on one — `http://localhost:11434` for Ollama. Guarding this
  sink that way would delete the feature rather than harden it. The defence is
  upstream of the dial: the tenant does not choose the host.

- **#4556's reason codes and log sentences are kept VERBATIM.** The first
  attempt renamed them (`NOT_SERVED`, a reworded WARN) and #4556's own test
  caught it. It was right to: a logged `reason` is observable, alerts key on it,
  and a refactor that unifies two copies must not also reword the output — that
  makes a behaviour-preserving change look behavioural and breaks whatever reads
  the old string. Keeping them also means the shared rule speaks Flue's existing
  vocabulary, so `resolveFlueModel` passes the reason **through** rather than
  translating it, and there is no table to disagree in.

- **The comparison stays RAW** — no trailing-slash or case normalisation,
  exactly as Flue compared it. A looser comparison admits more strings, and
  every string it newly admits is one an administrator typed. Pinned by a test.

- **The resolver returns the DEPLOYMENT's url, never the tenant's**, even when
  the two are equal. No caller can come to depend on the tenant string flowing
  through, so narrowing the rule later cannot silently change what is dialled.

- **The guard's population is derived from git, not listed.** A curated list
  cannot catch its own omission, and an omission is exactly what happened here.
  Exact set equality in both directions: a new reader fails until classified, a
  stale entry fails too.

- **No new behavioural tests of the dial.** `risk-local-gateway-tenant-url`
  (#4556) covers the request and the credential, and `ai-residency-enforcement`
  covers the provider choice. Re-testing them here would be duplication that
  rots. The new suite tests what neither can: that one rule exists, and that
  both callers agree with it **over a table of addresses** rather than happening
  to match on the ones somebody thought of.

## The process lesson, which is the one worth carrying

This branch was opened six minutes after #4556, for the same issue, because the
check for competing work sampled **40 of 2031 remote branches** —
`git branch -r | ... | head -40`. The scan could not have found #4556 and would
have printed nothing either way, so its silence carried no information. A probe
with no discriminating power.

#4558 was already in the merge queue when the overlap surfaced; it was dequeued
in favour of #4556, which was first and also carried `docs/ai-architecture*`
changes this branch does not. Then main was merged in and this reduced to the
delta above.
