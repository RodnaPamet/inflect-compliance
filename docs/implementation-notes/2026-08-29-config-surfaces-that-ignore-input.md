# 2026-08-29 — Two config surfaces that accepted input and then ignored or refused it

**Commit:** `<pending> fix(config): honour AI_RISK_PLAN_REQUIRED; reject metadata-only SAML at save`

Two unrelated configuration surfaces shared one failure shape: the operator
supplies a value, the system reports success, and the value then does nothing
(a) or turns into a runtime refusal the operator never saw coming (b).

## Design

### (a) `AI_RISK_PLAN_REQUIRED` was accepted and discarded

`src/app-layer/ai/risk-assessment/feature-gate.ts` ran a four-predicate
default-deny allow-list. Predicate 4 called `checkPlanEntitlement`, whose whole
body was:

```ts
// TODO: Implement plan-based gating when billing/entitlements are available
return { allowed: true };
```

Billing shipped (GAP-18, `src/lib/billing/entitlements.ts`). The TODO did not
move. So an operator who set `AI_RISK_PLAN_REQUIRED=pro` to restrict AI to
paying tenants got an unconditional ALLOW — the worst possible default for an
entitlement check, and one that looks identical, from outside, to the gate
working.

The obstacle was shape, not policy: gates 1-3 are synchronous (env flags +
`ctx.permissions`), while resolving a plan is a DB read. The fix splits on that
seam rather than making everything async:

```
checkFeatureGate(ctx, feature)          sync   gates 1-3        (signature unchanged)
checkFeatureGateWithPlan(ctx, feature)  async  gates 1-3 + plan (new)
enforceFeatureGate(ctx, feature)        →Promise<void>  the authoritative seam
```

`enforceFeatureGate` is **not** an `async function`, deliberately. It runs the
synchronous gates first and throws them SYNCHRONOUSLY; only the plan gate rides
on the returned Promise. A caller that forgets `await` therefore gets exactly
the enforcement this function had before the plan gate existed — a missing
`await` on a security gate can weaken it, and this shape makes that
structurally impossible here. The five call sites were all already inside
`async` functions and now `await`.

Plan resolution goes through `getEffectivePlan` — the same seam the numeric
limits use — so both documented billing modes carry through for free:

| mode | trigger | plan | DB read |
|---|---|---|---|
| `SELFHOSTED` | `STRIPE_SECRET_KEY` unset/empty | always `ENTERPRISE` → always allowed | none |
| `SAAS` | `STRIPE_SECRET_KEY` set | `BillingAccount.plan`, absent row → `FREE` | one |

Two fail-closed paths, because "allow" is the wrong error default for an
entitlement check: an env value naming no recognised plan (operator typo), and
a plan that cannot be resolved at all (DB down, import failure). Both refuse.

The billing module is imported lazily inside `checkPlanEntitlement`, mirroring
`appendAuditEntry`'s lazy pull of the audit stream. With `AI_RISK_PLAN_REQUIRED`
empty — the default, and every existing deployment — the gate short-circuits
before the import: no DB client is pulled into the AI path and behaviour is
byte-for-byte what it was.

### (b) `SamlConfigSchema` accepted a provider that could never sign in

The refinement read:

```ts
(data) => data.metadataUrl || (data.entityId && data.ssoUrl && data.certificate)
```

Nothing in the codebase fetches or parses IdP metadata XML.
`/api/auth/sso/saml/start` reads the stored config and refuses outright:

```ts
if (!samlConfig.ssoUrl || !samlConfig.entityId) {
    throw configurationError('SAML configuration incomplete — ssoUrl and entityId required');
}
```

So a metadata-only provider saved with a success message and produced a
`configurationError` at first sign-in — the admin's feedback loop was a support
ticket from a user, not the form they had just submitted.

The refinement became a `superRefine` requiring `entityId` + `ssoUrl` +
`certificate` unconditionally. `metadataUrl` stays in the schema as a
reference/documentation field. The message distinguishes the two cases, and
issues are attached per missing field (`config.entityId`, …) plus once at the
root so a plain error read still explains itself.

Metadata fetch/parse was considered and rejected for this change: fetching an
admin-supplied URL server-side is an SSRF surface that needs its own design,
which is not the "genuinely straightforward" bar for a conservative fix to a
security-adjacent path. If it is ever built, the refinement relaxes in the same
diff as the fetcher.

## Files

| File | Role |
|---|---|
| `src/app-layer/ai/risk-assessment/feature-gate.ts` | Real plan resolution replaces the stub; sync/async gate split; fail-closed paths |
| `src/app-layer/usecases/{assistant,risk-suggestions,questionnaire}.ts` | Five `enforceFeatureGate` call sites now `await` |
| `src/app-layer/schemas/sso-config.schemas.ts` | `SamlConfigSchema` requires entityId + ssoUrl + certificate; metadataUrl is reference-only |
| `docs/billing.md` | New "Tier gating, as distinct from numeric limits" section — the second consumer of `getEffectivePlan` |
| `tests/unit/ai/feature-gate-plan-entitlement.test.ts` | Behavioural: refuse-below / allow-at / allow-above, self-hosted unaffected, both fail-closed paths |
| `tests/unit/saml-config-saveable-implies-signinable.test.ts` | Behavioural: metadata-only rejected at save + the saveable⇒sign-in-able property |
| `tests/unit/{saml-flow,sso-config}.test.ts` | Six assertions encoded the old permissive contract; updated |

## Decisions

* **`checkFeatureGate` kept its synchronous signature.** Making it async would
  have rippled through three existing test files for no gain: it has zero
  callers in `src/`, and the authoritative seam every usecase uses is
  `enforceFeatureGate`. It is now documented as an advisory pre-check.
* **`enforceFeatureGate` returns a Promise but is not `async`.** See above —
  the sync gates must keep throwing synchronously so a forgotten `await` cannot
  regress the flag/role enforcement. There is a test that calls it unawaited
  and asserts it still throws.
* **The plan gate runs LAST, after the role gate.** A caller denied on role
  should not cost a billing lookup, and the refusal reason a user sees should
  be the actionable one. Asserted (`dbReads === 0` on a role denial).
* **`getEffectivePlan`, not a fresh `BillingAccount` query.** `docs/billing.md`
  explicitly forbids a second mode-detection mechanism. Reusing the seam is why
  self-hosted needed no special-casing in the gate at all.
* **The SAML test is a property, not a shape assertion.** "Everything the save
  boundary accepts, the sign-in boundary can use" is the invariant that was
  broken; pinning the specific refinement expression would go green against a
  future rewrite that reintroduces the same hole differently. The property runs
  over ten candidate configs and carries a not-vacuous companion, because a
  property that vacuously holds over an all-rejected candidate set reads exactly
  like one that passes.
* **Six existing assertions were changed, not deleted.** They asserted
  metadata-only SAML configs SAVE — i.e. they encoded the defect. Three others
  used a metadata-only config as filler while testing email-domain lowercasing
  and default flags; those got a complete config so they now pass for the reason
  their names claim.
