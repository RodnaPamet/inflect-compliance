# 2026-09-01 — delete the ungated `/api/sso`

**Commit:** the `fix(authz): delete /api/sso, an uncalled duplicate of the gated
route` commit on branch `fix/delete-ungated-api-sso` (deletes
`src/app/api/sso/route.ts`). Recorded by content rather than sha because the
note ships in the same commit it describes.

Closes #2196, split out of #2189. `/api/sso` was one of the census entries in
`tests/guardrails/destructive-route-denial-census.test.ts` whose denials went
unrecorded: it resolved its tenant through `getLegacyCtx(req)` (session
`tenantId`, or an API key) and carried no route-level gate, so a refusal wrote
no `AUTHZ_DENIED` row.

## Design

There was nothing to gate, because there was nothing to keep. The route is a
line-for-line duplicate of `src/app/api/t/[tenantSlug]/sso/route.ts` — same four
verbs, same five usecases, same `UpsertSsoConfigInput.parse`, same `maskSecrets`
helper — and the twin carries `requirePermission('admin.manage', …)` on every
one of them. The only difference was how the tenant is resolved and whether the
denial is audited.

Measured before deleting, not assumed:

- **Zero callers.** The admin SSO page calls `fetch(apiUrl('/sso'))` three
  times, where `apiUrl` is `useTenantApiUrl()` — which returns
  `` `/api/t/${tenantSlug}${path}` `` (`src/lib/tenant-context-provider.tsx:88`).
  The UI has always hit the gated twin. Grepping `/api/sso` across `src`,
  `tests`, `scripts`, `public` and `docs` returns the route's own JSDoc, the
  generated OpenAPI stub, one test comment and one historical note — no fetch,
  no client, no script. The `'/sso'` in `tests/e2e/admin-regression.spec.ts:55`
  is a UI page path in the admin-subpage list, not an API path.
- **Semantic parity.** The two modules differ only in the gate and the context
  helper; the handler bodies are otherwise identical.

## The rationale, stated precisely

The reason is **not** "a 308 would break tenant selection". That argument is
refuted: `getLegacyCtx` resolves the same oldest-membership tenant a redirect
target would (`src/app-layer/context.ts` ~:84, from the JWT's `memberships[0]`),
so a redirect would preserve slug selection unchanged.

The honest reason is simpler, and it generalises to the ~15 other twinned legacy
routes still on `getLegacyCtx`: **two surfaces over one contract, with zero
callers on one of them.** A 308 or a 410 keeps the path alive as a thing to
maintain, document and re-audit, in exchange for compatibility with a caller
that does not exist. Deletion is the smaller surface and the honest statement of
what shipped.

The API-key caller #2196 raised **could never have reached either route**, and
that is a stronger argument than the one this paragraph first made.

`getTenantCtx` does accept API keys (`src/app-layer/context.ts:40-43`), but the
handler is downstream of the edge. `/api/t/:slug/sso` is in none of
`PUBLIC_PATH_PREFIXES`, `PUBLIC_API_REGEXES` or `MACHINE_CALLER_PREFIXES`, so
`src/middleware.ts:200-210` runs first. `getToken` does read
`Authorization: Bearer`, but then JWE-decodes it; an `iflk_…` key throws in
`_decode`, `getToken` returns null, and the request is `unauthorizedJson()`'d.
`tryApiKeyAuth` never executes. That is the same class as the S9 finding —
SCIM, MCP and webhooks 401'd before their own auth ran — and it is tracked
separately as #2224.

The consequence for THIS change is that the deleted route sat behind the same
edge gate, so it was equally unreachable to a cookieless key-holder. The only
credential that could ever have reached `POST /api/sso` is a NextAuth session
cookie, and the only browser UI that could carry one calls the gated twin. So
the "an external consumer might depend on this published endpoint" risk is
provably zero rather than merely unobserved.

Confirmed against production as well as by reading: **zero requests to
`/api/sso` in 30 days** of caddy and app logs on the deployment VM.

## Files

| File | Role |
| --- | --- |
| `src/app/api/sso/route.ts` | **Deleted.** The ungated duplicate. |
| `tests/guardrails/destructive-route-denial-census.test.ts` | Census entry removed; the `todo` ratchet bound tightened 4 → 3. |
| `tests/unit/tenant-isolation-structural.test.ts` | `'sso'` removed from `ALLOWED_LEGACY_ROUTES` — the directory no longer exists, so the entry was a claim about a missing file. |
| `tests/unit/saml-config-saveable-implies-signinable.test.ts` | Header comment named both save routes; now names the one that exists. |
| `public/openapi.json` | Regenerated via `npm run openapi:generate`. The `/api/sso` `x-stub` entry is gone. |

## Decisions

- **Tightened the census bound rather than leaving it slack.**
  `expect(todo.length).toBeLessThanOrEqual(4)` is an upper bound and would have
  passed at 3. Leaving it is slack a later diff can spend without a reviewer
  seeing a number change, which is exactly what a ratchet exists to prevent. It
  does not block #2197: the three remaining `todo` entries are all its, and
  closing them removes lines, moving the bound down again rather than into it.
- **`tests/guardrails/admin-route-coverage.test.ts:102` was deliberately NOT
  touched.** It contains an identically-spelled `'sso/route.ts'`, but its
  `BASE_DIR` is `src/app/api/t/[tenantSlug]` — that entry asserts the *twin*
  carries `requirePermission`. Removing it would have silently deleted the
  surviving route's coverage assertion while CI stayed green.
- **`tests/contracts/__snapshots__/` was not regenerated.** The per-schema
  snapshots contain zero `/api/sso` references (their `sso` substring hits are
  "association" and "isSubprocessor"), so `jest -u` would only have absorbed
  unrelated drift. All 92 snapshots pass untouched.
- **Deletion, not a redirect or a 410.** See the rationale section — the
  tenant-selection objection to a 308 does not hold, so the choice rests on
  surface size, not on a technical blocker.

## Out of scope

MFA enforcement is gated on `isTenantPath` in `src/middleware.ts` (~:251), which
matches only `/t/` and `/api/t/`. An `mfaPending` session therefore reached this
flat route, and still reaches ~92 other flat ones. Filed as #2223; deleting one
route neither fixes nor worsens it.
