/**
 * MCP read tool — tenant grounding. `get_tenant_context` gives an agent the
 * baseline it needs before reasoning: the tenant's entity counts and, for a
 * caller that may read the audit log, its ten latest entries (via
 * `getDashboardData`). The installed-framework catalogue is available as the
 * `inflect://frameworks` MCP resource and via `get_framework_status`.
 *
 * RLS + `assertCanRead` in the usecase; MCP adds the `controls:read` gate
 * (controls are the compliance core) + audit.
 *
 * ── WHO GETS THE AUDIT-LOG ROWS ─────────────────────────────────────────
 *
 * The usecase decides, not this file: `recentActivity` holds rows only when the
 * context it is handed holds `canAudit`, the gate `listAuditLogs` asserts, and
 * is an empty array otherwise (owner decision, 2026-10-30). The context is
 * `inv.ctx`, which the funnel has already narrowed, so the tool follows the
 * same rule as `GET /api/t/:slug/dashboard` with no second check here:
 *
 *   • a bearer key at `/api/mcp`: its scopes must resolve to ADMIN (`*` or
 *     `admin:write`; `admin:*` resolves to EDITOR) AND its creator must be an
 *     Owner, Admin or Auditor now, because `buildMcpInvocation` intersects
 *     every key with its principal. A key carrying `mcp:read` and domain read
 *     scopes, the usual agent key, gets no rows;
 *   • a workflow run a person starts: that person's own role;
 *   • a run a key started: the key AND the person, as above.
 *
 * Rows that do come back are still filtered by their domain's view key
 * (`TENANT_CONTEXT_ROW_REDACTION`). The two rules narrow; neither widens.
 */
import { z } from 'zod';

import { getDashboardData } from '@/app-layer/usecases/dashboard';
import type { RequestContext } from '@/app-layer/types';

import {
    TENANT_CONTEXT_REDACTION,
    TENANT_CONTEXT_ROW_REDACTION,
} from './dashboard-redaction';
import type { McpReadTool } from './types';

const args = z.object({}).strict();

export const getTenantContextTool: McpReadTool<Record<string, never>> = {
    name: 'get_tenant_context',
    description:
        'Grounding for the tenant: entity counts (assets, risks, controls, ' +
        'evidence, open tasks, findings) and recent activity — the baseline an ' +
        'agent needs before reasoning. Read-only, tenant-scoped.',
    inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
    },
    argsSchema: args,
    resourceScope: { resource: 'controls', action: 'read' },
    // Same shape as `get_compliance_posture`: `controls.view` gates the call,
    // and the per-domain counts plus the recent-activity FEED are filtered to
    // what the principal may see. Whether the feed has rows at all is the
    // usecase's audit-log gate (header); the row-level rule then applies to
    // the rows it returns, because the feed interleaves every domain in one
    // array — a risk-blind auditor must not read "Risk X created" out of a
    // grounding tool.
    authorize: {
        keys: ['controls.view'],
        basis: 'effective',
        mirrors: 'GET /api/t/:slug/dashboard',
    },
    redact: TENANT_CONTEXT_REDACTION,
    redactRows: TENANT_CONTEXT_ROW_REDACTION,
    run: async (ctx: RequestContext) => {
        return getDashboardData(ctx);
    },
};
