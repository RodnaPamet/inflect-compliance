# 2026-10-30 — the local AI gateway is resolved in one place

**Issue:** #4545

## The finding

`TenantSecuritySettings.aiLocalBaseUrl` is written by any `admin.manage` holder
through `PUT /api/t/:slug/admin/security-settings`, whose schema is
`z.string().url()` and nothing more. `ai/risk-assessment`'s `buildLocalProvider`
passed that string to `LocalRiskSuggestionProvider`, which dials it with a bare
`fetch` and — where the deployment sets `AI_LOCAL_API_KEY` — attaches that key
as `Authorization: Bearer …`.

Two holes, and the second is worse than the first:

1. **SSRF.** A workspace admin picks the host the server dials: a private
   address, `169.254.169.254`, any internal host.
2. **Credential disclosure.** The key sent is the DEPLOYMENT's gateway
   credential, so whoever chose the host collects it.

Reachable on an `EXTERNAL` tenant with `AI_RISK_PROVIDER=local`, and on every
`LOCAL_ONLY` tenant.

## Why `safeFetch` is not the fix

Every other tenant-controlled sink routes through `safeFetch`
(`tests/guards/ssrf-egress-coverage.test.ts` holds that registry). This one
cannot. `assertPublicAddress` refuses private, loopback and link-local
addresses, and a local inference gateway is *supposed* to be on one —
`http://localhost:11434` for Ollama, an internal host for vLLM. Putting this
sink behind the public-address check would not harden the feature, it would
delete it.

So the defence sits upstream of the dial: the tenant does not choose the host at
all. A per-tenant value is honoured only when it names the gateway this
deployment already serves, and is otherwise refused by name. With that in place
there is no tenant-controlled URL left to guard, which is why this change adds
no `SINKS` entry.

## Flue already had the rule

`resolveFlueModel` refused exactly this, as `LOCAL_GATEWAY_NOT_SERVED` — "what
is decided here must be what is dialled there". The risk factory next door had
no such rule, and nothing anywhere could tell you the two disagreed.

That is the real defect, and it is the one worth designing against: the rule
existed, was correct, was well commented, and was **local to one subsystem**. So
this change does not copy it into a second place. It moves it to
`src/lib/ai/local-gateway.ts` and has both callers read it, and adds a guard
that fails when a third reader of `env.AI_LOCAL_BASE_URL` appears without going
through it.

## Files

| File | Role |
| --- | --- |
| `src/lib/ai/local-gateway.ts` | NEW. `resolveLocalGateway` — the one rule. Reads `@/env` and nothing else, so either layer can import it. |
| `src/app-layer/ai/risk-assessment/index.ts` | `buildLocalProvider` resolves through it and constructs on `gateway.baseUrl`; a refusal becomes the deterministic stub plus a WARN naming the reason. |
| `src/lib/agentic/flue/model-selection.ts` | Reads the shared rule instead of its own inline comparison. Behaviour unchanged — the refusals map one-to-one. |
| `tests/unit/ai/risk-suggestion-local-gateway.test.ts` | NEW. Behavioural: drives `generateSuggestions` against a stubbed `fetch` and asserts the CALL LOG. |
| `tests/guards/ssrf-egress-coverage.test.ts` | Derived population of `env.AI_LOCAL_BASE_URL` readers, plus the shape of both consumers. |
| `tests/guards/ai-residency-enforcement.test.ts` | One case inverted — see below. |

## Decisions

- **A refusal falls back to the stub; it does not throw.** That is this module's
  documented contract for every provider failure, and a knowledge-base template
  is a real answer. Flue refuses the run instead, correctly: a reasoning loop
  has no template substitute. The existing comment in
  `tests/unit/flue-model-selection.test.ts` already drew that distinction.

- **The comparison stays RAW** — no trailing-slash or case normalisation, exactly
  as Flue compared it. A looser comparison admits more strings, and every string
  it newly admits is one a workspace admin typed. A test pins the trailing-slash
  case as refused so the looseness cannot creep back in as a "fix".

- **The resolver returns the DEPLOYMENT url, never the tenant's**, even when the
  two are equal. So no caller can come to depend on the tenant string flowing
  through, and narrowing the rule later cannot silently change what is dialled.

- **The per-tenant MODEL override is untouched.** It selects among what the
  deployment's own gateway serves, so it cannot move traffic anywhere.
  Withdrawing it would be a silent feature loss riding along with a security
  fix; a test pins it.

- **The WARN does not echo the host the tenant typed.** A log line is not the
  place to reflect an attacker-chosen string. It names the reason code instead.

- **The NOT_SERVED refusal is checked before NOT_CONFIGURED.** An operator told
  "not configured" would go and set `AI_LOCAL_BASE_URL`; the honest answer is
  that the value they are looking at is not one this deployment can serve.

- **`tests/guards/ai-residency-enforcement.test.ts` had a case asserting the
  hole**, titled "a per-tenant local base URL overrides the env default" and
  passing `http://tenant-gw:9000`. The assertion it existed for — that no
  external provider is constructed — is kept in both halves of its replacement;
  only the claim about whose host gets dialled is inverted. Worth recording
  that the vulnerability was written down as the contract, because the test
  passing was never evidence of anything.

- **The guard's population is derived from git, not listed.** A curated list
  cannot catch its own omission, and an omission is precisely what happened here
  — one subsystem had the rule, the next did not. Exact set equality in both
  directions, so a new reader fails until classified and a stale entry fails too.

## Mutation proofs

| Mutation | Caught by |
| --- | --- |
| `NOT_SERVED` arm removed from the resolver | 5 new behavioural tests **and 2 existing Flue tests** |
| resolver called, then `sel.localBaseUrl` dialled anyway | `the risk factory dials the RESOLVED url, never the tenant string` |
| comparison re-inlined in `buildLocalProvider` | `never compares the tenant URL against the env var by hand` + the population check |
| a third, unclassified reader of `env.AI_LOCAL_BASE_URL` | `exactly the classified files read env.AI_LOCAL_BASE_URL` |

The first is the one that matters most: removing the shared rule reddens both
subsystems, which is the property the extraction was for.
