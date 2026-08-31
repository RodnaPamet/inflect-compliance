# 2026-08-31 — destructive route denial audit, tranche 4

**Commit:** `9a06d0567 fix(authz): gate the risk + asset link/detach routes so their refusals are audited`

Fourth tranche of #2117. Five route modules, seven handlers. Census 13 → 8.
Predecessors: `2026-08-24-destructive-routes-audit-denials.md` and
`2026-08-25-destructive-route-denial-audit-tranche-2.md`.

## Design

Unchanged from the earlier tranches: wrap the handler in
`requirePermission(<key>, …)` so a refusal writes `AUTHZ_DENIED`, and **leave the
usecase assert in place** so a non-HTTP caller still hits a check. The pair is
fail-closed by construction — the gate can only refuse callers the assert would
have admitted, never admit one it would refuse.

| Route | Verbs | Key |
| --- | --- | --- |
| `assets/[id]/evidence/attached/[evidenceId]` | DELETE | `assets.edit` |
| `assets/[id]/risks/[riskId]` | DELETE | `assets.edit` |
| `risks/[id]/evidence/attached/[evidenceId]` | DELETE | `risks.edit` |
| `risks/correlations` | PUT, DELETE | `risks.edit` |
| `risks/hierarchy/[nodeId]/links` | POST, DELETE | `risks.edit` |

## Files

| File | Role |
| --- | --- |
| the five `route.ts` above | gate added, assert retained, body reading moved to `parseJsonBody` |
| `tests/unit/security/destructive-route-denial-audit.test.ts` | seven rows; reset roster derived from the table |
| `tests/guardrails/destructive-route-denial-census.test.ts` | five entries removed |

## Decisions

- **Why these five and not the other four.** `assertCanWrite` reads
  `ctx.permissions.canWrite` — `level >= 3` in `computePermissions`, i.e. OWNER /
  ADMIN / EDITOR — while `requirePermission` reads `ctx.appPermissions`, a
  different bag, keyed by a `PermissionKey` derived from `PermissionSet`. A gate
  equals its assert only where a domain key happens to carry the same
  population. `assets.edit` and `risks.edit` do, exactly. The rest do not, and
  that is not an oversight — see the residual below.

- **Custom roles are the only behaviour change, and it tightens.**
  `ctx.permissions` is computed from the built-in role alone and ignores
  custom-role overrides; `appPermissions` does not. A tenant that revoked
  `risks.edit` from a custom role now gets an audited refusal instead of a silent
  write. Same coarse-to-granular swap tranches 1–3 argued.

- **The asset↔risk unmap is not an `assertCanWrite` route.**
  `unmapAssetFromRisk` calls a file-local `assertCanManage` testing `ctx.role`
  against a literal `['OWNER','ADMIN','EDITOR']` list. Same population, different
  mechanism, and a reader checking that gate against `assertCanWrite` would find
  nothing. Recorded in the route file.

- **`PUT /risks/correlations` is gated, not only the DELETE.** Overwriting a
  coefficient erases a correlation without removing its row — driven to 0, the
  dependence vanishes from every aggregate reading the matrix. A module with one
  gated and one ungated destructive handler counts as ungated, by design.

- **`withValidatedBody` → `parseJsonBody` on both body-reading routes.**
  `withValidatedBody` hands the parsed body in the third argument
  `requirePermission` uses for `ctx`. Consequence is deliberate: authorization
  now runs *before* body parsing, so an unauthorized caller sending malformed
  JSON is refused rather than told its JSON is malformed.

- **The reset roster is now derived.** It was a hand-maintained list of every
  usecase mock, carrying a comment warning that an omitted name leaves stale
  calls and fails the "usecase was not reached" assertion for an unrelated
  reason. The warning did not prevent it: seven new rows, seven omitted names,
  exactly the seven predicted failures. `ROUTES.map(r => r.usecase)` makes the
  row its own registration. Verified as a strict superset of all 34 previously
  listed mocks rather than trusting the green run.

## The residual, and why it is not a to-do list

What is left on the census is what this mechanism **cannot** take:

- **`/api/sso`** — `requirePermission`'s handler type requires a `tenantSlug`
  route param and resolves via `getTenantCtx`. That route has no slug in its path
  and uses `getLegacyCtx`, which resolves the tenant from the session. It is also
  an uncalled duplicate of the gated `/api/t/:slug/sso` the UI actually reaches,
  so the fix is deprecation, not gating.
- **business-continuity ×2, process-snapshot restore** — `assertCanWrite` with no
  `PermissionSet` domain to match. Tranche 3 left these deliberately and said so
  in `route-permissions.ts`; binding them to a neighbouring register's flag would
  change the caller set for a reason unrelated to the route.
- **SCIM ×2** — bearer-token auth, no session-derived role.
- **`account/avatar`, `security/mfa/enroll`** — self-service; the session *is* the
  authorization.

Each now carries its own issue. The general fix for the second group is a choice
between adding the missing `PermissionSet` domains and making the policy layer
itself audit — the latter closes the class everywhere, including routes that can
never carry the tenant gate, and is worth costing before the former is committed
to.
