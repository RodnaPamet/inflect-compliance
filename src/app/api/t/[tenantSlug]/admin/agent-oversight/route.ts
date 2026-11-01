import { z } from 'zod';
import type { NextRequest } from 'next/server';

import {
    getAgentOversightSettings,
    setAgentOversightSettings,
} from '@/app-layer/usecases/agent-oversight-settings';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

/*
    The Owner's agent oversight switches (round 15). A PARTIAL body, `.strict()`
    so a mistyped key is a 400 rather than a silent no-op, and an empty body is
    refused for the same reason.
*/
const Body = z
    .object({
        composeNeedsSecondApprover: z.boolean().optional(),
        exactParameterEditNeedsSecondApprover: z.boolean().optional(),
        auditorReadsDecisionLog: z.boolean().optional(),
        auditorReadsReceipts: z.boolean().optional(),
        auditorReadsQuarantine: z.boolean().optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, {
        message: 'Specify at least one setting to change',
    });

const getHandler = requirePermission(
    'admin.tenant_lifecycle',
    async (_req: NextRequest, _ctx, requestCtx) => {
        return jsonResponse({ settings: await getAgentOversightSettings(requestCtx) });
    },
);

const putHandler = requirePermission(
    'admin.tenant_lifecycle',
    async (req: NextRequest, _ctx, requestCtx) => {
        const patch = Body.parse(await req.json());
        const result = await setAgentOversightSettings(requestCtx, patch);
        return jsonResponse(result);
    },
);

export const GET = withApiErrorHandling(getHandler);
export const PUT = withApiErrorHandling(putHandler);
