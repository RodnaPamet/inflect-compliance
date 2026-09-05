/**
 * MCP read tool — tenant grounding. `get_tenant_context` gives an agent the
 * baseline it needs before reasoning: the tenant's entity counts + recent
 * activity (via `getDashboardData`). The installed-framework catalogue is
 * available as the `inflect://frameworks` MCP resource and via
 * `get_framework_status`.
 *
 * RLS + `assertCanRead` in the usecase; MCP adds the `controls:read` gate
 * (controls are the compliance core) + audit.
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
    // what the principal may see. The feed needs the row-level rule because it
    // interleaves every domain in one array — a risk-blind principal must not
    // read "Risk X created" out of a grounding tool.
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
