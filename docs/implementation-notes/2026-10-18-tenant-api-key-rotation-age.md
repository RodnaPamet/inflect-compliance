# 2026-10-18 — A per-tenant API-key rotation age for credential hygiene

**Commit:** `feat(agentic): per-tenant API-key rotation age for credential hygiene (2b follow-up)` (#3708)

## Design

Step 2b's `KEY_OLDER_THAN_ROTATION_AGE` judged every tenant's agent keys by
`DEFAULT_KEY_ROTATION_DAYS` (90) and said so (`DEFAULT_NO_TENANT_SETTING`). A
tenant can now hold its own age.

```
PUT /api/t/:slug/admin/security-settings   { apiKeyRotationDays: 7..730 | null }
  requirePermission('admin.manage')        OWNER, ADMIN — AUTHZ_DENIED for the rest
  Zod (int 7..730 | null)                  400 with a sentence
  updateTenantSecurityConfig               re-checks the range; upserts the one column;
                                           API_KEY_ROTATION_AGE_CHANGED {before, after}
                                           + the usual SECURITY_SETTINGS_UPDATED
  DB CHECK TenantSecuritySettings_apiKeyRotationDays_range   the backstop for any writer

06:00 agent-credential-hygiene, per tenant, ONE transaction:
  tenantSecuritySettings.findUnique(apiKeyRotationDays)   one read, never per key
  resolveRotationAge(stored)  → { days, source }          NULL/absent → 90, DEFAULT_NO_TENANT_SETTING
                                                          7..730     → n,  TENANT_SETTING
                                                          otherwise  → throws → ERROR row
  planHygiene({ …, rotationAge })                         title + description name days AND source
  reconcile (unchanged): open / reopen / resolve
            + restate: a firing rotation finding whose stored title differs
                       (still open, or as it reopens) — its own audited UPDATE
  IntegrationExecution.resultJson.rotationAge = { days, source }   the age APPLIED
```

A longer age resolves what a shorter one raised, and a shorter one opens what a
longer one did not, through 2b's existing reconcile on the next complete read.
Nothing new was built for that; the integration test proves it.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/auth.prisma` | `TenantSecuritySettings.apiKeyRotationDays Int?` |
| `prisma/migrations/20261018160000_tenant_api_key_rotation_days/` | Nullable column, no default, no backfill; the range CHECK |
| `src/lib/agentic/credential-hygiene.ts` | Range constants, `RotationAge`, `resolveRotationAge`, source-aware finding text |
| `src/app-layer/usecases/agent-credential-hygiene.ts` | Reads the setting in the pass's transaction; restates; records the applied age |
| `src/app-layer/usecases/tenant-security-settings.ts` | The writer, the range re-check, the before/after audit event, the read |
| `src/app-layer/schemas/tenant-security-settings.schemas.ts` | `apiKeyRotationDays` in the patch schema |
| `src/app/t/[tenantSlug]/(app)/admin/security/ApiKeyRotationCard.tsx` | The setting on the security settings page |
| `messages/en.json`, `messages/bg.json` | `admin.security.apiKeyRotation.*` |

## Decisions

- **The existing PUT, not a sub-route.** The route is already patch-shaped and
  `.strict()`, already `admin.manage`, and already carries a per-field event
  with values (`LEGACY_MATCH_AI_MODE_CHANGED`). A sub-route would be a second
  writer on the row, which is exactly what the patch semantics exist to avoid,
  and a second rule in `route-permissions.ts` to keep in step.
- **A dedicated audit event with both values.** `SECURITY_SETTINGS_UPDATED`
  records field names only, by design (the row holds an HMAC secret). The age is
  not sensitive, and "since when did this workspace judge keys by 30 days, and
  by what before" is the question the row has to answer. The effective age and
  its source ride along, so a NULL reads as the 90 it means. A PUT that leaves
  the value where it was writes no rotation event.
- **NULL means the default; 90 is a choice.** A tenant that stores 90 reports
  `TENANT_SETTING`. "Use the default" is written as NULL — the card sends an
  explicit `null`, never 90 — so the row never claims a policy nobody chose.
  For the same reason the column has no database default.
- **An out-of-range stored value throws.** It cannot exist while the CHECK
  holds. Judging by it is wrong, and judging by the default while recording
  `DEFAULT_NO_TENANT_SETTING` would misdescribe a tenant that does have a
  setting, so the pass refuses and writes an ERROR row naming the value.
- **The CHECK leaves no drift residue.** `prisma migrate diff` does not model
  CHECK constraints in either direction, so the fresh-DB drift gate matches the
  committed residue unchanged — verified against a database built from the
  migrations alone. The three earlier `TenantSecuritySettings` CHECKs left none
  either. The constraint is documented on the column instead.
- **Restating, scoped to this rule.** Without it, a finding opened under 90 days
  that still fires under 60 keeps quoting 90 — an age the pass no longer
  applies. The title carries the days and the source, and it is plaintext
  (the description is encrypted at rest), so a title mismatch is the signal and
  both fields are rewritten, audited as a JOB `UPDATE`. The default's title is
  the wording 2b shipped, so this deploy restates nothing. The other rules quote
  constants, and widening the restatement to them was not this change.
- **A choice, not an empty box, in the UI.** The column is nullable, so the card
  offers "use the product default (90 days)" and "set this workspace's own" as
  a `RadioGroup`, with a `NumberStepper` (7..730) only for the second. An empty
  number input would make the default look like an unfinished form.
