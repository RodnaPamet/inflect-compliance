# 2026-10-25 — Policy acknowledgements: notification links, rollback re-notify, auditor roster

**Commit:** see the PR for #4128

## Design

Three defects in the acknowledgement loop, each invisible from inside the product.

**Links.** A tenant page lives under `/t/<slug>/…` and the bell renders a stored
`Notification.linkUrl` as-is. Seven senders stored a bare tenant path
(`/policies/<id>` three times, `/evidence`, `/framework-updates`, `/vendors/<id>`
twice, `/audits/nis2-gap/respond/<id>`), so the link 404'd. They now build the
prefix through `src/app-layer/notifications/tenant-link.ts`:
`resolveTenantSlugForLinks(db, ctx)` takes `ctx.tenantSlug`, or looks the slug up
by `ctx.tenantId` when the context has none (a job or system context — the
`leaver.ts` fallback), and `tenantPageLink(slug, path)` returns `null` when no
slug is known (the `agentic.ts` rule: no link beats a 404). The two global
fan-outs read the slug once rather than per row: `framework-delta` with one
`tenant.findMany` before its per-tenant loop, the vendor review reminder with a
`tenant.slug` join, as `task-due` does.

Rows already stored keep the old link, so the bell resolves them:
`src/lib/notifications/notification-href.ts` rewrites exactly the five path
shapes those senders wrote, on a segment boundary, against the workspace in the
URL. Everything else is returned as stored.

**Rollback re-notify.** The rollback's dedupe key was
`POLICY_ACK_REQUIRED:<restoredVersionId>:<userId>`, which the restored version's
own request or publish had already used. `dedupeKey` is unique, the insert fell
into a silent `.catch`, and only people new to the campaign were told. The key
now carries the rollback's identity, the lifecycle version it produced:
`POLICY_ACK_REQUIRED:<restoredVersionId>:rollback-<lifecycleVersion>:<userId>`.

**Roster.** `getPolicyAcknowledgementRoster` gated on `assertCanAdmin`, which
refused the AUDITOR the attestation log exists for. It now gates on
`assertCanAudit` (OWNER, ADMIN, AUDITOR). The panel takes a separate
`canViewRoster` (the page passes `permissions.canAudit`) from `canAdmin`, which
still gates the request action. `requirePolicyAcknowledgement` is unchanged.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/notifications/tenant-link.ts` | Slug resolution + `/t/<slug>` link builder for senders |
| `src/lib/notifications/notification-href.ts` | Client-safe resolver for legacy stored links |
| `src/components/layout/notifications-bell.tsx` | Resolves each row's link against the URL's workspace |
| `src/app-layer/usecases/policy-attestation.ts` | Request link; roster gate `assertCanAudit` |
| `src/app-layer/usecases/policy.ts` | Publish and rollback links; per-rollback dedupe key |
| `src/app-layer/usecases/{evidence,framework-delta,vendor-monitoring,vendor-reassessment-reminder,gap-assessment-assignment}.ts` | Same link fix |
| `src/components/policies/PolicyAcknowledgementsPanel.tsx`, `…/policies/[policyId]/page.tsx` | `canViewRoster` gate, request stays `canAdmin` |

## Decisions

- **The roster widening is a read widening, by owner decision.** Acknowledgement
  evidence is what an auditor asks for (ISO 27001 §7.3). `canAudit` is exactly
  OWNER, ADMIN and AUDITOR, including a custom role whose base role is one of
  them. The route has no `requirePermission` and no `route-permissions.ts` rule;
  the usecase is the gate.
- **The rollback's identity is `lifecycleVersion`, not a random id.** Every
  publish and rollback bumps it, so a second rollback gets a new key and is
  notified, while the same lifecycle step replayed dedupes. `logEvent` returns
  nothing, so the audit row's id was not available without changing a shared
  signature. Two rollbacks racing on the same policy both produce N+1 and share
  one notification, which is acceptable for a race whose end state is one of them.
- **The bell reads the slug from `useParams`, not `useTenantHref`.** The bell is
  also mounted in the org chrome, which has no `TenantProvider`; `useTenantHref`
  throws there. In the org chrome there is no workspace to resolve against, so
  legacy links stay as stored.
- **The bell rewrites an allowlist, not "anything without `/t/`".** An absolute
  automation link, `/org/…`, `/account/…` and every route nobody wrote without a
  prefix pass through untouched.
- **Not changed:** the publish key is still `POLICY_ACK_REQUIRED:<versionId>:<userId>`.
  It only collides when a version that was live before is published again
  through `publishPolicy`, which is a different path from rollback.
