# Billing & entitlements

> **New to the codebase?** Start at [CONTRIBUTING.md](../CONTRIBUTING.md) — the developer onboarding guide.

> **Audience.** Operators choosing how to deploy the platform, and
> developers adding new gated features. The reference implementation
> lives at [`src/lib/billing/entitlements.ts`](../src/lib/billing/entitlements.ts).
>
> **Retention note.** Tenant cancellation and `BillingEvent`/`BillingAccount`
> retention have data-lifecycle implications (financial records have a regulatory
> floor; cancelled-tenant evidence retention is an open question). See
> [`docs/data-retention.md`](data-retention.md).

This document describes the **operating model** the codebase ships
with today. It is not a forward plan for future billing features.

---

## TL;DR

| Question | Answer |
|---|---|
| Is Stripe required to run the app? | No. |
| What happens with no Stripe configured? | Every tenant resolves to `ENTERPRISE`. All gated limits become unlimited. |
| What happens with Stripe configured? | Each tenant's effective plan is read from `BillingAccount.plan` and per-plan limits are enforced before mutations. |
| Where is the gate enforced? | Server-side, before the DB write. Not in the UI. |
| How does the platform decide which mode it is in? | One env var: `STRIPE_SECRET_KEY`. |

---

## The two modes

### `SAAS` mode

* Triggered when **`STRIPE_SECRET_KEY`** is set to a non-empty value.
* The deployment is treated as the hosted SaaS product.
* Each tenant's effective plan comes from the `BillingAccount` row
  written to by Stripe webhooks (`plan = FREE | TRIAL | PRO | ENTERPRISE`).
* A tenant **without** a `BillingAccount` row resolves to **`FREE`**
  — that is the safe default for a SaaS tenant who has not started a
  paid subscription.
* Per-plan limits (see below) are enforced at every gated mutation.

### `SELFHOSTED` mode

* Triggered when **`STRIPE_SECRET_KEY` is unset or empty**.
* The deployment is treated as on-prem / OSS.
* Every tenant resolves to **`ENTERPRISE`**, regardless of any
  `BillingAccount` row that may exist.
* Per-plan limits are **not enforced** — every gated resource is
  effectively unlimited.
* Self-hosted customers paid for the right to run the software; they
  did not buy a SaaS subscription, so the codebase declines to
  pretend otherwise.

The decision is **process-wide and read once at module load** in
[`entitlements.ts`](../src/lib/billing/entitlements.ts). There is no
runtime flip — restart the process to change modes.

```ts
// src/lib/billing/entitlements.ts (excerpt)
const BILLING_MODE: BillingMode = process.env.STRIPE_SECRET_KEY
    ? 'SAAS'
    : 'SELFHOSTED';
```

If you want the deterministic decision in code:

```ts
import { getBillingMode } from '@/lib/billing/entitlements';

if (getBillingMode() === 'SAAS') { /* … */ }
```

---

## Per-plan limits (SaaS mode)

The full limits table lives in `PLAN_LIMITS` in
[`entitlements.ts`](../src/lib/billing/entitlements.ts). Today it
gates one resource:

| Plan | `control` |
|---|---:|
| `FREE` | 10 |
| `TRIAL` | 100 |
| `PRO` | 100 |
| `ENTERPRISE` | unlimited |

`null` in the table means unlimited.

Notes on the choices:

* **`TRIAL` inherits `PRO`.** A paying-customer-on-trial gets the
  full working surface, not an artificially constrained one — the
  alternative is a UX cliff at the moment they enter billing details,
  which is exactly the wrong time for one.
* **`FREE` is "kick the tyres".** Ten controls is enough to map a
  couple of policy areas — far short of a full ISO 27001
  implementation, which is the upgrade trigger.
* **Status (CANCELED, PAST_DUE, …) is intentionally NOT factored
  in here.** The Stripe webhook handler is the source of truth for
  downgrade timing — it writes `plan` directly when a subscription
  ends. Adding a second branch in `getEffectivePlan` would race with
  the webhook and produce confusing user-facing failures.

---

## Where the gate runs

Gating happens **server-side at the mutation boundary**, immediately
after the per-resource RBAC assertion. Today, `createControl` is
gated:

```ts
// src/app-layer/usecases/control/mutations.ts
export async function createControl(ctx, data) {
    assertCanCreateControl(ctx);                    // RBAC
    await assertWithinLimit(ctx, 'control');         // GAP-18 plan gate
    // … create the control …
}
```

Every path that creates controls asks the same gate, with the number
it would create as `assertWithinLimit`'s third argument: a framework
install (a pack, several packs, a single template or a bulk install,
`usecases/framework/install.ts`) and installing controls from templates
(`usecases/control/mappings.ts`) count the controls that do not already
exist and refuse the whole install before any row is written (#5263).

The gate runs **before any write** so the DB never observes a row
that violated the plan. Read paths and UI rendering are NOT
considered the enforcement boundary — anything visible to the user
must be considered "advisory" until the server-side gate has run.

### Tier gating, as distinct from numeric limits

`assertWithinLimit` answers "how many of these may this tenant
have?". A second, simpler question — "is this tenant's plan high
enough to use this capability at all?" — is answered by reading
`getEffectivePlan(ctx)` directly and comparing tiers.

The AI feature gate is the one consumer today. It is **off by
default**: `AI_RISK_PLAN_REQUIRED` is empty unless an operator sets
it, and while it is empty the AI gate performs no plan resolution
and no DB read at all. When it IS set (`free` / `trial` / `pro` /
`enterprise`), `checkPlanEntitlement` in
`src/app-layer/ai/risk-assessment/feature-gate.ts` refuses any
tenant below that tier, and `enforceFeatureGate` surfaces the
refusal as a `403`.

Both modes carry through unchanged. Under `SELFHOSTED`,
`getEffectivePlan` returns `ENTERPRISE` without touching the DB, so
setting `AI_RISK_PLAN_REQUIRED` on a self-hosted deployment refuses
nobody. Under `SAAS`, the tier comes from `BillingAccount.plan`
(absent row → `FREE`), exactly as it does for the numeric limits.

The gate **fails closed**: if `AI_RISK_PLAN_REQUIRED` names no
recognised plan, or the plan cannot be resolved at all, the request
is refused rather than allowed. An entitlement check whose error
path is "allow" is not an entitlement check.

If you add another tier-gated capability, read
`getEffectivePlan(ctx)` through this module — do not re-derive a
plan from a `BillingAccount` query of your own.

### Feature entitlements

A capability that is simply in a plan or not is a `GatedFeature`
in `src/lib/billing/entitlements.ts`, read with
`isEntitledTo(ctx, feature)` (or the pure `planIncludes(plan,
feature)`), from the `PLAN_FEATURES` table beside `PLAN_LIMITS`.
The caller refuses with its own named reason.

The one feature today is `hostedManagedAgents`: Managed Agents runs
hosted in Inflect's own Anthropic organisation (Step 6b of
`docs/claude-managed-agents-design.md`), whose session-hours and
tokens Inflect pays for. **No plan includes it**, ENTERPRISE (and so
every self-hosted tenant) included, so every hosted run is refused
`managed_agents_hosted_not_entitled` and no workspace can opt in.
Which plans include it is a product and pricing decision for the
owner; opening one is a one-line diff in `PLAN_FEATURES`.

### Failure shape

When the gate trips, it throws `forbidden(...)` from
`@/lib/errors/types`. The HTTP wrapper surfaces this as **`403`**
with a body that includes:

```
plan_limit_exceeded: FREE plan allows 10 control(s); tenant currently has 10. Upgrade to add more.
```

The string contains the four pieces a client / billing UI needs to
render an upgrade CTA:

| Token | Meaning |
|---|---|
| `plan_limit_exceeded` | Stable error code, machine-grep-friendly |
| `FREE` | The plan that is currently in effect |
| `10 control(s)` | The limit + resource (singular/plural literal) |
| `tenant currently has 10` | The current count for that resource |

---

## Adding a new gated mutation (developer guide)

The entitlement layer is designed to make new gates a one-line
change at the call site plus a one-line change in the limits table.

**1.** Add the resource to the `GatedResource` union and the
`PLAN_LIMITS` table in
[`entitlements.ts`](../src/lib/billing/entitlements.ts):

```ts
export type GatedResource = 'control' | 'risk';     // ← add here
//                                       ^^^^^^

const PLAN_LIMITS: Record<Plan, Record<GatedResource, number | null>> = {
    FREE: { control: 10, risk: 25 },                 // ← add here
    TRIAL: { control: 100, risk: 250 },
    PRO: { control: 100, risk: 250 },
    ENTERPRISE: { control: null, risk: null },
};
```

**2.** Teach `getCurrentCount` how to count the new resource. The
`switch` is exhaustive — TypeScript will surface every site that
needs updating:

```ts
async function getCurrentCount(ctx, resource) {
    return runInTenantContext(ctx, async (db) => {
        if (resource === 'control') return db.control.count(/* … */);
        if (resource === 'risk')    return db.risk.count(/* … */);  // ← add
        const _exhaustive: never = resource;
        return _exhaustive;
    });
}
```

**3.** Call the gate at the create-site, AFTER the RBAC assertion
and BEFORE any DB write:

```ts
export async function createRisk(ctx, data) {
    assertCanCreateRisk(ctx);
    await assertWithinLimit(ctx, 'risk');           // ← add
    // … create the risk …
}
```

That's the entire surface. The gate inherits SaaS-vs-self-hosted
behaviour automatically — self-hosted is unlimited because
`getEffectivePlan` returns `ENTERPRISE` short-circuit, which then
returns `null` from `getLimit`, which short-circuits the count
query.

### What NOT to do

* **Do not gate in the UI.** The UI is welcome to render a CTA when
  the gate would trip (e.g. "8 / 10 controls used — upgrade?"), but
  the *enforcement* must live behind the API.
* **Do not introduce a second mode-detection mechanism.**
  Everything routes through `getBillingMode()` so the decision is
  visible in one place. If you find yourself reading
  `process.env.STRIPE_SECRET_KEY` somewhere else, prefer importing
  from this module.
* **Do not branch on `BillingStatus`** to decide if a limit
  applies. Status is the webhook handler's concern — the
  entitlement layer reads `plan` only.
* **Do not duplicate the limits table.** Tests and call sites read
  `PLAN_LIMITS` through `getLimit(plan, resource)`. Anywhere else
  re-encoding "FREE allows 10 controls" is a place that will silently
  drift.

---

## Operator runbook

### "How do I run this self-hosted with no enforcement?"

Don't set `STRIPE_SECRET_KEY` in your deployment env. The platform
detects the absence at boot and resolves every tenant to
`ENTERPRISE`. No additional configuration required.

### "How do I verify the platform is in self-hosted mode?"

Check the running process's env: `STRIPE_SECRET_KEY` should be
**unset or empty**. If it is, every tenant resolves to `ENTERPRISE`
and `assertWithinLimit` returns immediately without consulting
the DB. There is no separate "self-hosted feature flag".

### "We're self-hosted but want to enforce limits internally"

Out of scope for this iteration. The intentional model is binary:
SaaS *or* self-hosted-unlimited. If you need fine-grained quotas
in a self-hosted deployment, file an issue — that is a deliberate
new mode (e.g. "self-hosted-with-quotas") and would need its own
config surface, not a flag flip on the existing two.

### "A tenant has been downgraded but is still creating controls"

Check `BillingAccount.plan` for the tenant — that is the source of
truth. The webhook handler is responsible for moving the row from
`PRO` back to `FREE` when a subscription cancels. If the row is
still `PRO`, the webhook didn't fire or didn't apply (look at
`BillingEvent` for the trail).

### Setting a plan by hand

A tenant cannot set its own plan: in SaaS mode the plan decides
entitlements, so the workspace route that once let an OWNER set it was
removed (#5379, owner decision 2026-11-12). The platform operator sets a
plan by hand with `POST /api/admin/tenants/:slug/plan`, gated by
`PLATFORM_ADMIN_API_KEY`, through `setTenantPlanAsPlatform` in
`src/app-layer/usecases/tenant-lifecycle.ts`; the change is audited in the
tenant's own trail as its system user. A hand-made `BillingAccount` row
carries a `manual:<tenantId>` placeholder customer, which is replaced by a
real Stripe customer when the tenant first opens checkout or the portal,
keeping the plan the operator set.

### How the webhook applies a subscription event

`handleWebhookEvent` in [`src/lib/stripe.ts`](../src/lib/stripe.ts)
never writes the subscription a Stripe event carries. Stripe does not
deliver events in order and re-delivers late ones, so that snapshot can
be older than the state already stored. For `checkout.session.completed`,
`customer.subscription.created` / `.updated` / `.deleted` and
`invoice.payment_failed` / `.payment_succeeded`, the event only names
the subscription. The handler re-fetches it from Stripe and writes the
live answer. The order events arrive in therefore decides nothing, and
an invoice event's type sets no status of its own (#5316).

* An invoice names its subscription in
  `parent.subscription_details.subscription` (current API versions, and
  the only field the pinned SDK's types expose) or in the top-level
  `subscription` (older API versions), as an id or an expanded object.
  An invoice that names no subscription changes nothing.
* `BillingAccount` stores one `stripeSubscriptionId`. Every event but
  `checkout.session.completed` is applied only when the stored id is
  null or equals the subscription the event names. An event about any
  other subscription is recorded in `BillingEvent`, changes nothing, and
  logs one line ("concerned a non-current subscription"). A completed
  checkout is what sets a new subscription, so it is exempt.
* The write itself is conditional on the `stripeSubscriptionId` read
  before the Stripe round trip (an `updateMany` naming that value, null
  included). If another event changed it in the meantime, typically a
  checkout committing a new subscription, the write matches no row,
  changes nothing and logs one line ("changed during the re-fetch"). The
  event is still recorded: the account already holds newer state, and a
  re-delivery would find it and change nothing either. A completed
  checkout writes unconditionally, because it replaces whatever is
  stored, including a deletion that committed during its own re-fetch.

* A live status of `canceled` or `incomplete_expired`, or Stripe
  answering `resource_missing`, is written as a deletion: `status =
  CANCELED`, `plan = FREE`, `stripeSubscriptionId = null`. The
  exception is an account that stores no subscription: it never
  subscribed or already had the deletion applied, so the event changes
  nothing (one log line, the event recorded). That keeps a late event
  about an old subscription from resetting a plan an operator set with
  `changeTenantPlan` to FREE. A completed checkout of an ended
  subscription is still written as a deletion.
* Any other live status is written as it stands: plan from the
  subscription's `metadata.plan`, status mapped from Stripe's, period
  end and trial end from the subscription.
* If the re-fetch fails for any other reason (network, rate limit,
  Stripe outage), nothing is written and the event is not recorded in
  `BillingEvent`. `/api/stripe/webhook` answers `503`, so Stripe
  delivers the event again, and the retry re-fetches.

Signature verification and the `BillingEvent.stripeEventId` idempotency
check run before any of this. `/api/stripe/webhook` answers:

* `400` when the signature does not verify;
* `503` when the live subscription could not be re-fetched;
* `500` for any other processing error (a database error, say), so
  Stripe delivers the event again rather than dropping it;
* `200` otherwise, including events it ignores.

The `BillingEvent` row is written only after the account write
succeeds, so an event that failed is not recorded and its re-delivery is
processed rather than skipped as a duplicate. A failure is logged with
the event id and type and the error's class and code, never the payload.

### "We just added a new gated resource and limits aren't applying"

Three things to verify in order:
1. The resource is listed in `GatedResource` AND `PLAN_LIMITS`.
2. `getCurrentCount` has a `switch` arm that returns the actual
   count for the resource (not `0`, not `undefined`).
3. The create-site calls `await assertWithinLimit(ctx, '<resource>')`
   AFTER the RBAC `assert*` and BEFORE the DB write.

If all three are correct, the gate is firing — confirm with a
unit test that mocks `BillingAccount.findUnique` to return your
target plan and the resource count to the limit value.

---

## See also

* [`src/lib/billing/entitlements.ts`](../src/lib/billing/entitlements.ts) — the implementation.
* [`src/lib/stripe.ts`](../src/lib/stripe.ts) — Stripe wrapper used in SaaS mode for checkout / portal flows.
* [`tests/unit/billing/entitlements.test.ts`](../tests/unit/billing/entitlements.test.ts) — exhaustive test for the SaaS / self-hosted decision and the `assertWithinLimit` enforcement path.

## Billing as a sub-processor

Stripe is a sub-processor in **SaaS mode only** (`STRIPE_SECRET_KEY` set);
self-hosted mode never calls it. See the Stripe entry in
[`docs/sub-processors.md`](./sub-processors.md) for the data shared and
the legal basis.
