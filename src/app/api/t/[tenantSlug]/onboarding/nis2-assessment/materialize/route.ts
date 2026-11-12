import { materializeNis2Gaps } from '@/app-layer/usecases/nis2-readiness';
import { withApiErrorHandling } from '@/lib/errors/api';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { z } from 'zod';

const MaterializeSchema = z
    .object({
        minCriticality: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
        createTasks: z.boolean().optional(),
        dryRun: z.boolean().optional(),
    })
    .strip();

// POST → explicitly convert serious gaps to Findings (+ Tasks).
// Idempotent + reconciling. NEVER automatic. Mutation-tier rate-limited.
// `findings.create` AND `findings.edit`: it creates findings, and reopens or
// closes the ones it created before.
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        { keys: ['findings.create', 'findings.edit'], mode: 'all' },
        async (req, _routeArgs, ctx) => {
            const body = await parseJsonBody(req, MaterializeSchema);
            const result = await materializeNis2Gaps(ctx, body);
            return jsonResponse(result);
        },
    ),
);
