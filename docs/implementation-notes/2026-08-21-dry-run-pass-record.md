# 2026-08-21 — What a dry run leaves behind

**Commit:** `<pending>` feat(jml): give a dry-run leaver pass a record, and somewhere to read it

The write ladder mandates seven days of DRY_RUN before a tenant may be promoted,
and its own refusal text says the point is to compare the pass against "what HR
and IT actually did". A dry run decided, logged a histogram, and threw every
decision away — so there was nothing to compare with. Worse, the promotion gate
counts ELAPSED days since `dryRunSince` rather than observed runs, so the window
could be satisfied by time passing while nobody watched anything.

## Design

### One terminal row, not a RUNNING row updated later

`identity-sync` writes a RUNNING `IntegrationExecution` and updates it at the
end. The leaver pass deliberately does not mirror that. It runs with
`attempts: 1` — argued on journal integrity, since the INDETERMINATE handling
assumes one dispatch per decision — and spans no transaction, so a two-phase
write has a real orphan mode: a process that dies mid-pass leaves a RUNNING row
nothing will ever finish, and an operator counting runs reads it as one that
happened.

So a single row is written after `disableAccountsForLeaver` returns, inside the
existing `try` so the writer is still closed by the `finally`.

A failed insert is caught and logged, never rethrown. The directory decisions are
already made and already reported; losing the record of them is worth an alert,
not the appearance of a failed pass — and with `attempts: 1` nothing would
re-dispatch anyway.

### Keyed by link id, and the reasons scrubbed

`IntegrationExecution` is not encrypted at rest — the Epic B manifest is
String-only, so a `Json` column cannot join it — and these rows outlive the pass.
The identifier that goes in must mean nothing outside an authorised read, so
every decision is keyed by `IdentityAccountLink.id`.

That alone is not enough. `DisableResult.reason` is deliberately un-redacted —
it is written for an operator reading a tenant-scoped surface — but provider
messages routinely embed the account: *"Entra refused to disable account
`<guid>`"*, *"No observed directory record for `<id>`"*. Persisting them verbatim
would put back exactly what keying by link id takes out, so each reason goes
through `redactDirectoryIdentifiers` on the way in.

`DisableResult` carried no link id, so pairing a decision with its candidate
would have rested on positional alignment between two arrays — correct until
somebody filters one of them. The pairing is now made in the batch loop, where
both are in scope, as `LeaverDisableResult = DisableResult & { linkId }`.

### Where it can be read, and where it deliberately cannot

The tenant-wide "automated checks" list **excludes** this `automationKey`. Two
reasons, and the second is the stronger:

1. A leaver pass is not a control check. It produces no evidence and attests
   nothing — listing it beside evidence-producing checks would misdescribe it.
2. That page is reachable with `controls.view`, while the authority to run these
   passes at all is OWNER-only. Where a row is stored must not quietly decide who
   can see it.

The per-connection executions page keys on `connectionId`, and the pass writes
NULL there — also deliberately. Its unit is (tenant, provider): in DRY_RUN the
snapshot writer resolves whether the tenant has zero, one or several connections,
so any `connectionId` written would be a guess in exactly the case the
connection-scoping work was about. A small lie on a row an operator is meant to
trust is worse than an absent field.

That left no surface at all, which does not discharge the operator's decision —
it was "opaque linkId **+ read surface**". So `GET
/api/t/:slug/admin/identity-leaver-passes` ships with the record, gated
`admin.tenant_lifecycle`: the same OWNER-only key as the write policy these
passes execute under, because naming which of a customer's people the product
would have disabled is authority of the same class as granting the disable.

The path is a **sibling** of `admin/identity-write-policy` rather than nested
under `admin/integrations`, and that dissolves a hazard rather than navigating
it. Route matching is first-match-wins and the `admin/integrations` rule resolves
to `admin.manage`, so a nested path would have required inserting a rule above it
— and getting that wrong leaves the permission map documenting a weaker gate than
the handler enforces, which no guardrail catches.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/identity-leaver-pass.ts` | `recordPassExecution`; `listLeaverPasses`; `LEAVER_PASS_AUTOMATION_SUFFIX`; `MAX_REPORTED_DECISIONS` finally has a reader |
| `src/app-layer/usecases/identity-disable-account.ts` | `LeaverDisableResult` — the decision paired with its link id where both are in scope |
| `src/app-layer/usecases/integrations.ts` | `listAllControlChecks` excludes the leaver suffix, at the query rather than in a caller |
| `src/app/api/t/[tenantSlug]/admin/identity-leaver-passes/route.ts` | the read surface |
| `src/lib/security/route-permissions.ts` | the rule, beside `identity-write-policy` |
| `tests/guardrails/admin-route-coverage.test.ts` | the new route registered |
| `public/openapi.json` | regenerated — the route is auto-discovered and lands as an `x-stub` entry |

## Decisions

- **`MAX_REPORTED_DECISIONS` was already there, unreferenced.** A reservation
  from an earlier attempt at this task, and 4× larger than reachable: the
  blast-radius breaker REFUSES above 50 rather than trimming, so a pass produces
  0 or at most 50 decisions. It is kept as the bound that stops one JSON column
  becoming unbounded if that ever changes, and a truncated report says so in the
  row rather than quietly ending early.
- **`PARTIAL` means truncation, not a bad outcome.** `FAILED` and
  `INDETERMINATE` are results the pass is reporting correctly, and they live in
  `counts`. The enum's own doc — "produced output, and that output is
  INCOMPLETE" — is about the report, not the directory.
- **The exclusion lives at the query, not in the route or the page.** Filtering
  downstream would let the next caller of the usecase reintroduce the exposure
  without touching anything that looks security-relevant.
- **`resultJson` is returned verbatim by the read.** The per-decision list IS
  the artefact; a summary of a summary would defeat persisting one.
