# 2026-11-24 — Workspace default language (NIS2 dispatch task titles)

**Commit:** `feat(i18n): workspace default language, used for NIS2 dispatch task titles`

## Design

Owner decision 2026-11-24 (#5868): NIS2 gap-assessment dispatch creates its
tasks with titles in the workspace's default language.

A stock notification is re-worded on read (#5929), because its row is never
edited and the reader's locale is known when it is shown. A task is different:
a person may rename it, so the stored title IS the record, and re-wording it
on read would overwrite their edit with a translation. Its language therefore
has to be chosen when the server writes it. The dispatcher's browser locale is
the wrong input (the person dispatching is not the person who reads the task),
and there was no workspace-level language, so this adds one.

```
Admin hub (/admin) ── WorkspaceLanguageCard ── PUT /api/t/:slug/admin/workspace-language
                                                     │ requirePermission('admin.manage')
                                                     ▼
                                     usecases/workspace-language.ts  ── logEvent WORKSPACE_LANGUAGE_CHANGED
                                                     │ (only writer)
                                                     ▼
                                        Tenant.defaultLocale  (TEXT, CHECK IN ('en','bg'), DEFAULT 'en')
                                                     ▲
                                                     │ readWorkspaceLocale(db, tenantId)
gap-assessment-assignment.ts::dispatchAssignments ── workspaceTranslator(locale, 'workspaceText.nis2GapTask')
                                                          (next-intl createTranslator over messages/<locale>.json)
```

The notification the same dispatch writes is unchanged: it stays the stored
English stock sentence and keeps being read back in each reader's language.

## Files

| File | Role |
| --- | --- |
| `prisma/schema/auth.prisma` | `Tenant.defaultLocale String @default("en")` |
| `prisma/migrations/20261124120000_tenant_default_locale/` | Additive column + CHECK `Tenant_defaultLocale_supported` |
| `src/lib/i18n/workspace-text.ts` | Server translator in a given locale (`workspaceTranslator`), and the workspace's locale read (`readWorkspaceLocale`) |
| `src/app-layer/usecases/workspace-language.ts` | The column's only writer, `admin.manage`, audited |
| `src/app-layer/schemas/workspace-language.schemas.ts` | Strict PUT body over `SUPPORTED_LOCALES` |
| `src/app/api/t/[tenantSlug]/admin/workspace-language/route.ts` | GET/PUT, `requirePermission('admin.manage')` |
| `src/lib/security/route-permissions.ts` | Route rule for the above |
| `src/app/t/[tenantSlug]/(app)/admin/WorkspaceLanguageCard.tsx` | The control: endonym radios, what it affects, what it does not |
| `src/app/t/[tenantSlug]/(app)/admin/page.tsx` | Renders the card in a "Workspace" section for `admin.manage` holders |
| `src/app-layer/usecases/gap-assessment-assignment.ts` | Dispatch words each task title in the workspace language |
| `messages/{en,bg}.json` | `workspaceText.nis2GapTask.*`, `workspaceLanguage.*`, `auditCodes.action.WORKSPACE_LANGUAGE_CHANGED` |
| `__mocks__/next-intl.js` | `createTranslator` over the caller's catalogue, so a test sees the language the code chose |

## Decisions

- **`Tenant`, not `TenantSecuritySettings`.** `Tenant` already carries the
  workspace's display and content preferences (`currencySymbol`,
  `reminderDaysBefore`, `maxRiskScale`, `region`), always exists, and so takes a
  real NOT NULL default. `TenantSecuritySettings` is security posture and module
  switches, and its row is created lazily, so every reader would need a
  missing-row fallback and the "default `en`" would be a code default rather
  than a stored one.
- **TEXT + CHECK, not a Postgres enum.** An enum change is an `ALTER TYPE`,
  which fails still-running containers mid-deploy (the `@@map("WorkItem*")`
  lesson). A new language is a widened CHECK.
- **No backfill.** A constant default is a catalogue change, and `'en'` is what
  every workspace wrote before, so the English title is byte-for-byte unchanged
  for every workspace that does not change the setting (a unit test pins it).
- **`admin.manage`**, the key of the other workspace-wide admin settings
  (security settings, risk matrix, notifications), not `admin.tenant_lifecycle`:
  the setting changes the wording of future records, not what the workspace
  has or who may reach it. Asserted at the route and in the usecase.
- **On the admin hub, after the navigation.** There is no general workspace
  settings page (`/admin/settings` is linked from the incident page but does
  not exist). The hub already holds the one other preference control (theme),
  so the card sits there in a "Workspace" section, after the pill sections so
  the hub stays a map first. It is rendered only for `admin.manage` holders, so
  nobody is offered a write the server refuses.
- **Plural chosen in code, not ICU.** `count.one` / `count.other` with `{n}`
  mirror the stock notification phrases and keep the global next-intl Jest mock
  (plain `{param}` interpolation) faithful. Both supported languages have only
  the CLDR `one` / `other` forms.
- **Unknown stored value reads as English.** `resolveLocale` is applied at the
  read, as the request config does for a cookie; the CHECK makes the case
  unreachable through the database, but a dispatch never fails over wording.
- **Other server-written product text in editable records is left as it is**
  (owner decision: NIS2 titles only). The PR lists them.
