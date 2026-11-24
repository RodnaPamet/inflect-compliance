import { z } from 'zod';
import type { NextRequest } from 'next/server';

import {
    getHostedManagedAgentsSetting,
    setHostedManagedAgentsOptIn,
} from '@/app-layer/usecases/hosted-managed-agents-opt-in';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

/*
    Hosted Managed Agents (Step 6b of docs/claude-managed-agents-design.md):
    whether an OWNER has opted this workspace in to agents hosted in Inflect's
    own Anthropic organisation. `.strict()`, so a mistyped key is a 400 rather
    than a silent no-op. The usecase also refuses an API key, an agent and a
    job, and opting out runs the clean-up of what Inflect created there.
*/
const Body = z.object({ optIn: z.boolean() }).strict();

const getHandler = requirePermission(
    'admin.tenant_lifecycle',
    async (_req: NextRequest, _ctx, requestCtx) => {
        return jsonResponse({ setting: await getHostedManagedAgentsSetting(requestCtx) });
    },
);

const putHandler = requirePermission(
    'admin.tenant_lifecycle',
    async (req: NextRequest, _ctx, requestCtx) => {
        const { optIn } = Body.parse(await req.json());
        return jsonResponse(await setHostedManagedAgentsOptIn(requestCtx, optIn));
    },
);

export const GET = withApiErrorHandling(getHandler);
export const PUT = withApiErrorHandling(putHandler);
