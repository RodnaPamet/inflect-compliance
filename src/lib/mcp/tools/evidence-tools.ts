/**
 * MCP read tool — evidence expiry. Thin wrapper over `listExpiringEvidence`
 * (evidence due/overdue within N days). RLS + `assertCanRead` in the usecase;
 * MCP adds the `evidence:read` gate + audit.
 */
import { z } from 'zod';

import { listExpiringEvidence } from '@/app-layer/usecases/evidence-retention';
import type { RequestContext } from '@/app-layer/types';

import type { McpReadTool } from './types';

const args = z
    .object({
        days: z.number().int().min(0).max(365).optional(),
    })
    .strict();

export const listEvidenceExpiringTool: McpReadTool<z.infer<typeof args>> = {
    name: 'list_evidence_expiring',
    description:
        'List evidence whose retention/review is due or overdue within the next ' +
        'N `days` (default 30). Ordered soonest-first; includes the linked control. ' +
        'Read-only, tenant-scoped.',
    inputSchema: {
        type: 'object',
        properties: {
            days: { type: 'integer', minimum: 0, maximum: 365, description: 'Look-ahead window in days (default 30).' },
        },
        additionalProperties: false,
    },
    argsSchema: args,
    resourceScope: { resource: 'evidence', action: 'read' },
    // `GET /api/t/:slug/evidence` resolves `getTenantCtx` and lets the usecase
    // assert `assertCanRead`; there IS an `evidence.view` key and every role
    // that passes `assertCanRead` on that route holds it, so naming the key is
    // the same decision stated in the vocabulary a custom role can narrow.
    authorize: {
        keys: ['evidence.view'],
        basis: 'effective',
        mirrors: 'GET /api/t/:slug/evidence',
    },
    run: async (ctx: RequestContext, a) => {
        return listExpiringEvidence(ctx, a.days ?? 30);
    },
};
