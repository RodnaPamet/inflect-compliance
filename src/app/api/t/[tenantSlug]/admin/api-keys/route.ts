import { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { listApiKeys, createApiKey } from '@/app-layer/usecases/api-keys';
import { withApiErrorHandling } from '@/lib/errors/api';
import { API_KEY_CREATE_LIMIT } from '@/lib/security/rate-limit-middleware';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

const CreateApiKeySchema = z.object({
    name: z.string().min(1).max(100),
    scopes: z.array(z.string()).min(1),
    expiresAt: z.string().nullable().optional(),
    /**
     * The registered agent this credential acts as. Without it a tenant that
     * enforces agent registration — which is every tenant with no settings row,
     * i.e. every newly created one — can mint no usable MCP credential.
     */
    agentId: z.string().nullable().optional(),
    /**
     * The ceiling this credential may drive its agent to, 0-6. Requires
     * `agentId` and may not exceed the agent's own registered level — both
     * refused in the usecase, where the agent row is resolved under RLS.
     */
    maxAutonomyLevel: z.number().int().min(0).max(6).nullable().optional(),
});

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        const keys = await listApiKeys(ctx);
        return jsonResponse(keys);
    }),
);

// API key minting is the canonical post-compromise amplification surface:
// a stolen session can create persistent machine credentials. Override
// the default API_MUTATION_LIMIT with the tight API_KEY_CREATE_LIMIT
// (5/hr, 1hr lockout) and a dedicated scope so the budget never
// competes with ordinary mutation traffic.
export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await req.json();
        const input = CreateApiKeySchema.parse(body);
        const result = await createApiKey(ctx, input);
        return jsonResponse(result, { status: 201 });
    }),
    {
        rateLimit: { config: API_KEY_CREATE_LIMIT, scope: 'api-key-create' },
    },
);
