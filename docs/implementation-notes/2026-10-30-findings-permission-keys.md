# 2026-10-30 — Findings get permission keys of their own

**Commit:** see PR for #4535

## Design

Findings were the one register with no key in `PermissionSet`. The routes relied on the usecases' coarse `assertCanRead` / `assertCanWrite`. Two owner decisions (2026-10-30): add `findings: { view, create, edit }`, and migrate existing API keys so none of them loses access.

- **Defaults reproduce the coarse tiers**, so no built-in role moves.
  - `view` = `canRead`: every role.
  - `create` and `edit` = `canWrite`: OWNER, ADMIN and EDITOR.
  - A unit test compares the two for every `Role` value.
- **Routes.**
  - The tenant routes (`GET`/`POST /findings`, `GET`/`PUT /findings/{id}`) take a literal `requirePermission`.
  - The flat legacy twins under `/api/findings` call `assertPermission` on the legacy context: same key, same `AUTHZ_DENIED` row.
  - `findings` is a privileged root in `api-permission-coverage`, and the four rules are in `route-permissions.ts`.
  - The usecases keep their coarse asserts behind the keys.
- **Convert to finding** (`POST /vulnerabilities/{id}/convert-to-finding`) creates a finding, so it now asks `findings.create` beside `assets.edit`, as convert-to-risk asks `risks.create`. The Vulnerabilities page and the asset page's buttons follow the same keys.
- **API keys.**
  - `SCOPE_ACTION_MAP` gains `findings: { read: ['view'], write: ['create', 'edit'] }`, and the API Keys page gains the scope group.
  - Migration `20261030120000_findings_scopes_for_existing_api_keys` adds `findings:read` to every live non-`*` key, and `findings:write` to each one with a `:write` or `:*` scope.
  - That is exactly what the coarse tier gave each key (`keyAuthorityFromScopes`). The integration test asserts the property through the real auth code, not a copy of the rule.
- **Pages.** The Findings page refuses a role without `findings.view` with a `ForbiddenPage`. It also splits `canWrite` into `canCreate` (the New button and dialog) and `canEdit` (the status actions and the detail sheet).

## Decisions

- **The keys go at the routes, not in `createFinding`.** About a dozen callers create findings under contexts that are not a person acting on the register: jobs, the audit FAIL cascade, auditor share comments, scanner ingestion, vendor monitoring. Gating the usecase would refuse those for custom roles nobody configured with findings in mind.
- **`list_findings` (MCP) stays on `audits:read`.** Moving it to `findings:read` would take the tool away from every MCP key minted for it. The migration gives those keys `findings:read` anyway, so a later move is possible.
- **A `*` key needs no migration.** It resolves to ADMIN's set, which now carries every findings key.
- **Revoked keys are skipped.** They authenticate nothing, and leaving them alone keeps the migration to the rows it is about.
