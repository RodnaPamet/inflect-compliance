# 2026-10-30 — the dashboard API's audit-log rows follow the audit-log gate

**Commit:** `fix(dashboard): the dashboard API returns audit-log rows only to audit-log readers`

## Design

`getDashboardData` backs `GET /api/t/:slug/dashboard`, its legacy twin
`GET /api/dashboard`, and the agent tool `get_tenant_context`. It returns
`{ stats, recentActivity }`, where `recentActivity` is the audit log's ten
latest rows. #4496 limited the Board's Recent Activity card to audit-log
readers and left these two doors open. The owner's decision of 2026-10-30
closes them:

```
getDashboardData(ctx)
  ├─ assertCanRead            → stats, for every reader (unchanged)
  └─ ctx.permissions.canAudit → recentActivity: ten rows
                       else   → recentActivity: [] (not queried)
```

`canAudit` is the flag `listAuditLogs` asserts. It is read off the context as
built, so there is one rule and each door supplies its own context:

| Caller | `canAudit` |
| --- | --- |
| A person | Owner, Admin or Auditor; a custom role by its base role |
| A key at `/api/t/**`, not bound to an agent | its scopes resolve to ADMIN: `*` or `admin:write`. Not narrowed by its creator, exactly as at `GET /audit-log` |
| A key at `/api/t/**`, bound to an agent | as above AND its creator is an Owner, Admin or Auditor (`finaliseApiKeyAuth` narrows it) |
| Any key at `/api/mcp` | as above AND its creator is an Owner, Admin or Auditor (`buildMcpInvocation` narrows every key) |
| A workflow run a person starts | that person's role |
| A run a key started | the key AND the person (`rebuildRunContext`) |

`admin:*` resolves to EDITOR, not ADMIN: `keyAuthorityFromScopes` names
`admin:write` exactly. So the usual agent key, `mcp:read` plus domain read
scopes, never gets the rows.

The tool's per-domain row filter (`TENANT_CONTEXT_ROW_REDACTION`) still
applies to the rows an audit-log reader gets. Both rules only narrow.

## Files

| File | Role |
| --- | --- |
| `src/app-layer/usecases/dashboard.ts` | the gate, and the doors and rule in the docstring |
| `src/lib/mcp/tools/context-tools.ts` | the header names who gets the rows; the description says so to the model |
| `tests/integration/dashboard-api-audit-rows-gate.test.ts` | per role, per key shape at REST (checked against `GET /audit-log`), and at `/api/mcp` with three creators |
| `tests/integration/mcp-tool-authz-per-invocation.test.ts` | the domain-filter test uses a key that may read the audit log |

## Decisions

- **An empty array, not an absent field.** The field has always been present,
  the usecase's own docstring said not to change the return shape, every
  existing mock returns `recentActivity: []`, and the published OpenAPI entry
  is a stub with no schema to change. An empty array is also what a quiet
  tenant returns, so the tool's description tells the model the list is empty
  for a caller that may not read the audit log.
- **No check in the tool.** The funnel already hands the usecase a context
  narrowed by the key's creator. A second `canAudit` check in the tool could
  only agree with the usecase or drift from it.
- **The description change is its own commit.** The description is hashed into
  the tool's manifest pin, so a tenant that has pinned `get_tenant_context`
  refuses it (`DESCRIPTION_CHANGED`) until someone holding
  `admin.agent_registry` re-approves it. Keeping it separate lets that cost be
  dropped without dropping the gate.
- **The whole dashboard is not refused.** The counts were never the audit log's,
  and the in-app assistant reads only `stats` from the same usecase.
