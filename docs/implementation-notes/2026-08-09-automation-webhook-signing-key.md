# 2026-08-09 — Automation webhooks were signed with the ciphertext

**Commit:** `<pending>` fix(automation): resolve the tenant DEK on the dispatcher rule read

## Design

`action-executor.ts` signs every outbound automation webhook:

```ts
const signingSecret = rule.webhookSecretEncrypted ?? cfg.secretRef;
const sig = createHmac('sha256', signingSecret).update(body).digest('hex');
headers['X-Inflect-Signature'] = `sha256=${sig}`;
```

`AutomationRule.webhookSecretEncrypted` is in the Epic B manifest, so it is
stored as a `v2:` ciphertext under the tenant's own DEK. The encryption
middleware resolves that DEK from `getAuditContext()`.

All three callers of `executeAction` are BullMQ jobs, and every one of them
read the rule through bare `prisma` with no ambient audit context:

| Caller | Read |
|---|---|
| `automation-event-dispatch.ts` | `findMany` (the primary dispatcher) |
| `rule-chain-dispatch.ts` | `findFirst` |
| `subflow-dispatcher.ts` | `findFirst` |

The reason is a two-store seam that reads as a single store from the outside.
`runJob` establishes a **request** context via `runWithRequestContext`, which
is AsyncLocalStorage (`src/lib/observability/context.ts`). The encryption
middleware reads `getAuditContext()`, a **module-level stack**
(`src/lib/audit-context.ts`) — deliberately not ALS, because Prisma's
middleware runs in a detached async context that loses ALS state. So a job
carrying a perfectly good `tenantId` still left `getAuditContext()`
undefined, `resolveTenantDekPair` returned `NO_DEK_PAIR`, the v2 decrypt
threw, and the middleware's fail-open catch passed the **raw ciphertext**
through as if it were plaintext.

Measured against a real database with the encryption extension applied:

```
WITH tenant context : "super-secret-signing-key"
NO context (the job): "v2:ac6vmmoIVg/ugIvfcH68YwWf/0ul5xlmhyHZNWAB4HgjJ4sl2Y4ZI/…"
```

The second value is what became the HMAC key.

## Impact

Two distinct things, worth separating:

1. **Signature verification never worked.** Consumers compute the HMAC with
   the plaintext secret they configured; we computed it with the ciphertext.
   Uniform across all three paths — which also means no working integration
   can break when this is fixed.

2. **Encrypting the column bought nothing for signing.** The effective
   signing key was the exact byte string sitting in the `AutomationRule`
   row, so an attacker with database read access could forge a valid
   `X-Inflect-Signature` without ever touching the KEK. Preventing that is
   the one thing encrypting a signing secret at rest is for.

The ciphertext itself was never transmitted — only the digest — so this is
not a secret-disclosure bug.

## Files

| File | Role |
|---|---|
| `src/app-layer/automation/tenant-dek-read.ts` | New. `readRulesWithTenantDek` + the `AUTOMATION_DISPATCH_SOURCE` constant. |
| `src/app-layer/jobs/automation-event-dispatch.ts` | Rule read wrapped. |
| `src/app-layer/jobs/rule-chain-dispatch.ts` | Rule read wrapped. |
| `src/app-layer/jobs/subflow-dispatcher.ts` | Rule read wrapped. |
| `tests/integration/automation-dispatch-tenant-dek.test.ts` | Behavioural: real DB, real extension, real DEK. |
| `tests/guards/automation-dispatch-tenant-dek.test.ts` | Structural: catches a fourth dispatcher and the `source: 'job'` trap. |

## Decisions

- **The scope is the READ only.** Widening the audit context over
  `executeAction` would change what the audit middleware attributes for
  writes made inside it — a separate decision with its own blast radius.
  Decrypting the row needs only the read.

- **`source: 'automation'`, and the guard exists because of it.**
  `BYPASS_SOURCES` in the encryption middleware is `{seed, job, system}`.
  These *are* jobs, so `source: 'job'` is the natural label — and it
  resolves to `NO_DEK_PAIR`, silently restoring the exact bug. The bypass
  set is for genuinely cross-tenant work; these dispatchers are
  single-tenant (the `tenantId` arrives on the payload and every query
  already filters by it). Mutation-testing confirms `'job'` fails both the
  guard and the behavioural test.

- **The regression is pinned, not just the fix.** The integration test also
  asserts that the *unwrapped* read returns `v2:`-prefixed ciphertext. Without
  that, a harness that happened to leave an ambient context lying around
  would make the positive assertion pass for the wrong reason.

- **`BYPASS_SOURCES` is dead code in production.** Nothing in `src/` sets
  `source` to `seed`, `job`, or `system` — every site sets `'api'`. Left in
  place rather than removed: it is the documented contract for cross-tenant
  work, and removing it would invite someone to re-add the concept without
  the DEK reasoning attached. Noted here so the next reader does not assume
  the branch is exercised.

- **Not fixed here: the fail-open catch itself.** Returning ciphertext in
  place of plaintext is what made this silent, and it is tracked separately.
  Ordering matters — shipping the null-return first would have converted
  "wrong signature" into "no signature at all", silently, via the
  `?? cfg.secretRef` fallback. Root cause first.

## Not affected

Five other jobs read encrypted models without a tenant context
(`deadline-monitor`, `retention-notifications`, `schedule-trigger-sweep`,
`calendar-deadlines`, `automation-runner`). They pull the columns over the
wire because they omit `select:`, but none of them *reads* the decrypted
value, so no ciphertext reached a user-visible surface. Writes are also
unaffected: with no DEK the middleware encrypts under the global KEK (v1),
which reads back correctly without tenant context.
