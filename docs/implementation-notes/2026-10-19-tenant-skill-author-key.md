# 2026-10-19 — Tenant skill authoring is its own key (#3778)

**Commit:** see the pull request for #3778.

## Design

```
before (#3680)                          after (#3778)
admin.agent_skill_review                admin.agent_skill_author        admin.agent_skill_review
  create a skill                          create a skill                  approve
  create a version (edit)                 create a version (edit)         reject
  attach the evaluation record            attach the evaluation record    retire
  submit                                  submit
  approve, reject, retire
  read one skill                          read one skill  ◀── either key ──▶  read one skill
```

The four-eyes rule a person holds is unchanged: whoever holds both keys, the
usecase refuses an approval by the version's author (`SELF_APPROVAL`) and a
CHECK makes one unrepresentable. What the split adds is a second line that
holds by key: a custom role carrying the authoring half alone writes and
submits, and is refused every approval, rejection and retirement at the route
(`AUTHZ_DENIED`) and in the usecase.

## Files

| File | Role |
| --- | --- |
| `src/lib/permissions.ts` | `admin.agent_skill_author`: the type, `PERMISSION_SCHEMA`, `AGENT_ADMIN_KEYS`, OWNER/ADMIN/AI_ADMIN hold it, `DERIVED_FROM` |
| `src/lib/auth/api-key-auth.ts` | `*` subtracts it, as it does the review key |
| `src/lib/security/route-permissions.ts` | three rules: the review acts, the read (either key), the authoring catch-all |
| `src/app/api/t/[tenantSlug]/admin/agents/skills/tenant/**` | create, version, evaluation, submit take the author key; the read takes either |
| `src/app-layer/usecases/tenant-skills.ts` | `assertMayAuthorSkills`, `assertMayReviewSkills`, `assertMayReadTenantSkill`; `canApprove` requires the review key |
| `src/app/t/[tenantSlug]/(app)/agents/[agentId]/**` | `canAuthorSkills` beside `canReviewSkills`; the sheet offers each half's acts to its holder |

## Decisions

- **Why split at all.** The owner's decision on #3778, found while drafting the
  managed-service methodology (#3682): a provider writes a tenant's skills and
  the tenant approves them, and with one key the product could refuse a
  provider's approval of its own version but not of a colleague's.
- **Nobody lost an act.** OWNER, ADMIN and AI_ADMIN hold both halves. A custom
  role stored before the split takes the authoring half from its own
  `agent_skill_review` (`DERIVED_FROM`), never from its base role, so a role
  that could author through the review key still can, and one that could not
  does not gain it. This is the `audits.workpaper_view` pattern (#3749).
- **Reading takes either key.** The author edits from a skill's versions and
  the reviewer approves from them; the read admits both at the route
  (`mode: 'any'`, the inventory-read precedent) and in the usecase.
- **`canApprove` asks for the review key.** The detail payload's per-version
  `canApprove` used to depend only on authorship and the caller being a
  person; with two keys, a holder of the authoring half alone is offered no
  approval it cannot make.
- **No bearer token holds either half.** `*` subtracts both; no scope maps to
  either. An agent that could write skill text could teach itself.
