# 2026-08-16 — denials that left no trail

**Commit:** `<pending>` fix(authz): destructive routes gate at the layer that audits

## Design

`AUTHZ_DENIED` is written by exactly one place: `requirePermission` in
`src/lib/security/permission-middleware.ts`. A usecase-layer `assertCanAdmin`
throw produces a correct 403 and **no audit row at all**.

That gives two ways for a denial to go unrecorded. The repo had both.

### 1. No route gate (11 routes)

Eleven Controls/Risks bulk and purge/restore routes ran bare
`withApiErrorHandling` while their Assets equivalents used
`requirePermission`:

```
controls/bulk/{delete,status,assign}
risks/bulk/{delete,status,assign,import}
controls/[controlId]/{purge,restore}
risks/[id]/{purge,restore}
```

**Authorization was never wrong.** Every one of the eleven usecases asserts —
verified individually, including the four that reach `assertCanAdmin`
indirectly through `purgeEntity` / `restoreEntity`. The gap was the audit
row: a denied bulk-delete or purge on Controls or Risks left no
security-event trail, while the identical action on Assets did.

### 2. A gate declared *weaker* than the usecase asserts (4 routes)

The more dangerous half, because the route **looks** gated:

| route | declared | usecase asserts |
|---|---|---|
| `risks/[id]` DELETE | `risks.edit` | `assertCanAdmin` |
| `tasks/[taskId]` DELETE | `tasks.edit` | `assertCanAdmin` |
| `assets/[id]` DELETE | `assets.edit` | `assertCanAdmin` |
| `assets/bulk/delete` | `assets.edit` | `assertCanAdmin` |

`.edit` is true for EDITOR. So an EDITOR **passed** the middleware and was
refused by the usecase — meaning the one denial class the gate exists to
record was the one it could not see.

`assets/bulk/delete` is the route that was cited in
`api-permission-coverage.test.ts` as the model the others should follow
("gated so denials audit at the C.1 layer, matching the usecase asserts").
It did not match its own usecase's assert.

**What hid it:** `tests/guards/tenant-crud-authz-coverage.test.ts` pinned
all three DELETE keys, and its docblock stated the reasoning —

> *granular `.view` is true for every role and `.create`/`.edit` are true for
> OWNER/ADMIN/EDITOR (= the coarse `canWrite` set), so wiring these keys
> preserves WHO is allowed; only the denial shape changes.*

True for view / create / edit. **False for delete**, where the usecase is an
ADMIN tier the note did not account for. The guard then held the mismatch in
place — it failed when this change corrected the key, which is how the
three-route class surfaced at all.

## Files

| file | role |
|---|---|
| 11 × `controls|risks` bulk + purge/restore `route.ts` | `requirePermission` with the key matching each usecase's assert |
| `assets/bulk/delete`, `risks/[id]`, `tasks/[taskId]`, `assets/[id]` | key corrected `.edit` → `admin.manage` |
| `tests/guards/tenant-crud-authz-coverage.test.ts` | table corrected; parity note now states where parity does *not* hold |
| `tests/guardrails/bulk-and-lifecycle-routes-audit-denials.test.ts` | new — both failure modes |

## Decisions

- **The key must match the tier the usecase asserts.** Not the weakest key
  that lets the right people through — behaviour is identical either way,
  since the usecase denies regardless. What differs is whether the denial is
  *recorded*. A key weaker than the assert is not a lenient gate, it is an
  unlogged one.

- **Corrected the reference rather than copying it.** The obvious move was to
  mirror `assets/bulk/delete` onto the eleven ungated routes. That would have
  propagated its mismatch to eleven more places.

- **Converted the bulk routes to `parseJsonBody`.** `withValidatedBody` and
  `requirePermission` have incompatible handler signatures (the former passes
  `body` as the third argument, the latter `ctx`). `parseJsonBody` is what the
  sibling `POST /risks` and `POST /controls` already use with
  `requirePermission`, so the routes converge on one shape rather than
  inventing a composition.

- **Both failure modes are falsified.** Reverting one route to the ungated
  shape fails two assertions; weakening a key back to `.edit` while leaving
  the gate in place fails one. The second is the one a structural check
  usually misses.

- **`tests/guards` could not have caught either.** It sees routes and keys but
  not the usecase asserts behind them, so key-vs-assert alignment is a
  cross-layer fact — which is why the new ratchet states the intended tier per
  route explicitly rather than deriving it.
