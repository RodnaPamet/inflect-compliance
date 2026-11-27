# 2026-11-27 — The evaluation nightlies are switched in the product

**Commit:** `feat(evals): switch the garak, Ragas and Inspect nightlies from the org settings card`

Owner request: "There should be UI for turning on evals, incl both Garak and
Ragas." Owner decisions of 2026-11-27: the on/off state lives in the product
DB, not in GitHub repository variables; a scheduled run asks production and
fails closed; only an ORG_OWNER of an operator organization may flip a switch;
every change writes an org audit row; production holds no GitHub credential.

## Design

```
 org settings page ──► OrgEvaluationsCard (server) ── canSwitch? ──► OrgEvalNightlySwitch ('use client')
        │                       ▲                                         │ PUT {nightly, enabled}
        │ getEvalNightlySwitches│                                         ▼
        └───────────────────────┴── usecases/eval-nightly-switches.ts ◄── /api/org/[slug]/eval-nightlies
                                       │  requireOrgPermission('canSwitchEvalNightlies')  (ORG_OWNER, audited)
                                       │  evalSwitchRefusal(slug ∈ EVALS_SWITCH_ORG_SLUGS)  (audited here)
                                       ▼
                               EvalNightlySwitch (platform table, ≤3 rows, absent = off)
                                       ▲
                                       │ readEvalNightlySwitchesForCi()
 GitHub runner (schedule) ──curl──► GET /api/evals/nightly-switches   Bearer EVALS_SWITCH_READ_TOKEN
   garak.yml / rag-eval.yml /        (MACHINE_CALLER_PREFIXES entry; 503 unset, 401 terse, no-store)
   agent-evals.yml first step  ◄── { garak, ragas, inspect } booleans
     jq .[$NIGHTLY] == true → run; anything else → off + ::warning::<reason class>
```

The write path mirrors `org-agent-switches.ts`: write, then audit both values
in the acting organization's chain, a no-op writes nothing, an audit failure
is logged and does not undo the switch. The read path is two readers of one
private `readStates()`, so the card and CI cannot disagree about "absent is
off".

## Files

| File | Role |
|---|---|
| `prisma/schema/evals.prisma`, migration `20261127120000_eval_nightly_switches` | The table, its CHECK on the key set, SET NULL references, `app_user` grants without DELETE, and `ORG_EVAL_NIGHTLY_SWITCHED` |
| `src/lib/evals/evaluation-nightlies.ts` | Static facts: Ragas added, the switch variable removed, the key list the CHECK, the zod enum and the workflows share |
| `src/lib/evals/eval-switch-access.ts` | Pure "owner of an operator organization" decision |
| `src/lib/evals/eval-switch-token.ts` | Constant-time bearer check over SHA-256 digests |
| `src/app-layer/usecases/eval-nightly-switches.ts` | Read for the card, read for CI, the audited set |
| `src/app/api/org/[orgSlug]/eval-nightlies/route.ts` | The card's GET/PUT |
| `src/app/api/evals/nightly-switches/route.ts` | The CI read, GET only |
| `src/lib/auth/guard.ts` | `MACHINE_CALLER_PREFIXES` entry for the CI read |
| `src/lib/permissions.ts` | `canSwitchEvalNightlies`, ORG_OWNER only |
| `.github/workflows/{garak,rag-eval,agent-evals}.yml` | The gate asks production; `vars.*_ENABLED` retired |
| `src/app/org/[orgSlug]/(app)/settings/*` | The card shows live state; switches for the operator's owner only |
| `src/app/org/[orgSlug]/(app)/audit/AuditLogTable.tsx` | Words for the new action and the operator refusal |

## Decisions

- **A new owner-only key rather than reusing `canManageOwners`.** The
  permission middleware writes the key into the `ORG_AUTHZ_DENIED` row, and a
  refusal reading "canManageOwners" for an evaluation switch would mislead the
  trail. The cost was a mechanical line in every test that spells out an
  `OrgPermissionSet` literal.
- **The operator list is an allowlist, and checked in the usecase.** The card's
  visibility list is an opt-OUT so new organizations see it; a switch spends
  the platform's money, so it must be granted and never inherited by a new
  organization. It is environmental, so the middleware cannot ask it: the
  usecase audits that refusal itself (`reason: EVALS_SWITCH_NOT_OPERATOR_ORG`).
- **Absent is off, and `app_user` has no DELETE.** The migration turns nothing
  on. Turning a nightly off is an UPDATE that keeps who and when; a DELETE
  would read the same as "never switched".
- **A platform table, not columns on `Organization`.** The state is one fact
  for the deployment, read by CI with no organization in hand. A column per
  organization would need a rule for which organization's value CI believes.
- **The token is at least 32 characters or the endpoint is off (503).** A
  `.min(32)` in the env schema would fail the whole deployment's boot over one
  endpoint's misconfiguration; treating a short token as none fails only the
  nightlies, closed.
- **The gate is inlined in each workflow, not a shared script.** The checkout
  runs after the gate step (nothing is fetched for a night that is off), so a
  repository script is not on disk yet. The three copies are held identical
  but for the label by a unit test, which also runs each one in bash against a
  stand-in `curl` for every failure class.
- **`--proto =https`.** The token never leaves the runner over plain HTTP; an
  `http://` URL is a failed request, so the nightly stays off.
- **Per-IP rate limit before the token check**, on the shared read preset
  (`API_READ_LIMIT`) under its own scope: three requests a night are the
  expected traffic, and a guess costs the guesser the same budget.
- **Ragas' budget decision is D-EV-11 as amended 2026-11-17**, the decision
  that set its USD 4.00 share of USD 6.50 (`evals/cost-meter/shares.json`);
  D-EV-1 set the cap, not the split.
