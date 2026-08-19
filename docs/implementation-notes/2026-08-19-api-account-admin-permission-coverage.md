# 2026-08-19 — the two API roots the C.1 guardrail never walked

**Commit:** `(this PR)` fix(security): scan /api/account + /api/admin, and gate diagnostics on the platform key

## Design

`tests/guardrails/api-permission-coverage.test.ts` enforces that privileged API
routes call `requirePermission`. It works by walking `PRIVILEGED_ROOTS` — an
explicit list of directories — so its coverage is exactly as good as that list.
A directory absent from it is not *exempt*; it is **never looked at**, and there
is no signal of the difference. That is the failure this closes.

Two roots were missing.

**`/api/account`** — the filed finding. Session-scoped rather than
tenant-scoped, so `requirePermission` (which resolves a tenant role) genuinely
does not apply to the three routes there today. But "the gate does not apply"
and "nothing checks whether a gate applies" are different states, and the
directory was in the second one.

**`/api/admin`** — found by the new tests, not by inspection. Two of its routes
had carried `EXCLUDED_ROUTES` entries since Epic 1 PR 2, with accurate reasons.
No root covered the directory, so those entries excluded nothing: the scan never
reached the files they named. The exclusions read as evidence the directory had
been triaged, while being inert.

That is the shape worth remembering — **an exemption list with no membership
check is indistinguishable from a considered decision.** Both look like a
reviewed carve-out with a written reason attached.

## The route the gap was hiding

`GET /api/admin/diagnostics` did:

```ts
const ctx = await getLegacyCtx(req);
if (!ctx.permissions.canAdmin) throw forbidden('Admin access required');
```

Two independent defects, neither visible from the call site:

1. **Wrong authority.** `getLegacyCtx` resolves the context from the *caller's
   own* `session.tenantId`. So the check asked "are you an admin of your own
   tenant?" and returned, to every yes in every tenant, the same server-wide
   payload: Node version, platform, `NODE_ENV`, release version, heap usage,
   log level, and which observability backends are wired. None of that has a
   tenant dimension — there is no reading under which one tenant's admin is
   more entitled to it than another's. That asymmetry is the tell that a tenant
   role was the wrong axis, not merely a too-weak one.

2. **Unaudited denial.** A bare `forbidden(...)` throw writes no `AUTHZ_DENIED`
   row; only `requirePermission` does. This is the Epic D.3 finding class
   exactly — and it evaded `no-legacy-admin-guard` by hand-rolling the check
   rather than naming the banned `requireAdminCtx` helper. A ratchet that bans
   an identifier does not ban the pattern.

Now gated by `verifyPlatformApiKey`, matching its two siblings. Nothing in the
product called it — only `docs/observability.md` and the generated OpenAPI — so
the blast radius is operators, who now use the platform key.

The 503/401 split is preserved deliberately: `verifyPlatformApiKey` throws 503
when `PLATFORM_ADMIN_API_KEY` is unset and 401 when it mismatches. Collapsing
both to 401 would send an operator to rotate a credential that was never
configured.

## Files

| File | Role |
| --- | --- |
| `tests/guardrails/api-permission-coverage.test.ts` | +2 roots, +4 exclusions, +2 tests (dangling, unreachable) |
| `src/app/api/admin/diagnostics/route.ts` | tenant-role check → platform key |
| `tests/unit/admin-diagnostics-authz.test.ts` | behavioural: axis, 503≠401, no secret in payload |
| `docs/observability.md` | records the platform-key requirement + the two statuses |

## Decisions

- **`/api/account`'s three routes are excluded, not gated.** They are genuinely
  session-scoped. The value is the forced triage on the *next* route added
  there, which is the same reason `/issues` is a root.

- **The `avatar/[userId]` reason says what it does, not what is convenient.**
  It is the one route here that reads *another* user, it is unscoped by tenant,
  and it is documented as a deliberate low-sensitivity read. Writing "self-
  service" would have been shorter and false, and would have buried a
  behaviour question worth someone deciding on its own merits rather than
  inheriting from a directory name.

- **Two new exclusion tests, not one.** Dangling (points at a deleted file) and
  unreachable (no root covers it) are different failures. Only the second one
  found `/api/admin`; a stale-path check alone would have passed, because those
  two files exist.

- **Diagnostics is excluded rather than `requirePermission`-wrapped.** Wrapping
  it would have fixed the audit half and left the authority half wrong — a
  tenant role is not the right question for a server-wide payload.
