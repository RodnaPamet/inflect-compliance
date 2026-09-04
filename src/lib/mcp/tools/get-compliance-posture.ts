/**
 * MCP read tool: `get_compliance_posture`.
 *
 * The Phase-1 proof tool — a THIN wrapper over the existing
 * `getExecutiveDashboard` usecase (the same one the executive dashboard page
 * calls). It returns the tenant's high-level compliance posture: control
 * coverage/implementation %, control + risk distributions, evidence-expiry
 * pressure, and policy/task/vendor summaries.
 *
 * The wrapper does NOT touch Prisma — `getExecutiveDashboard` runs the read in
 * `runInTenantContext` (RLS) after `assertCanRead(ctx)`. The MCP layer adds the
 * `controls:read` resource-scope gate (posture is control-coverage-centric) on
 * top of the `mcp:read` capability gate, and audits the call.
 */
import { z } from 'zod';

import { getExecutiveDashboard } from '@/app-layer/usecases/dashboard';
import type { RequestContext } from '@/app-layer/types';

import { EXECUTIVE_DASHBOARD_REDACTION } from './dashboard-redaction';
import type { McpReadTool } from './types';

const argsSchema = z.object({}).strict();

export const getCompliancePostureTool: McpReadTool<Record<string, never>> = {
    name: 'get_compliance_posture',
    description:
        "Get the authenticated tenant's compliance posture: control coverage " +
        'and implementation %, control/risk distributions, evidence-expiry ' +
        'pressure, and policy/task/vendor summaries. Read-only; tenant-scoped.',
    inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
    },
    argsSchema,
    resourceScope: { resource: 'controls', action: 'read' },
    // `getExecutiveDashboard` gates on `assertCanRead`, and the human dashboard
    // route resolves `getTenantCtx` with no key. `controls.view` is the key for
    // the domain the payload LEADS with (coverage + implementation %), and it
    // is the gate for the CALL only — the payload spans six more domains, so
    // the sections below fall away per domain. Gating the call is not the same
    // claim as returning only what the principal may read, and this tool has to
    // make the second one.
    authorize: {
        keys: ['controls.view'],
        basis: 'effective',
        mirrors: 'GET /api/t/:slug/dashboard/executive',
    },
    redact: EXECUTIVE_DASHBOARD_REDACTION,
    run: async (ctx: RequestContext) => {
        return getExecutiveDashboard(ctx);
    },
};
