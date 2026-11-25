/**
 * GET  /api/t/{slug}/admin/managed-agents — whether the Managed Agents engine
 *      is on for this workspace, who decided, and the owner's stored toggle.
 * PUT  /api/t/{slug}/admin/managed-agents — an owner turns it on or off.
 *
 * #5964 (owner decisions 2026-11-25). The GET is `admin.view`, so every admin
 * sees the switch, as they see the engine it gates (`admin/agent-driver`). The
 * PUT is `admin.tenant_lifecycle`, OWNER-only, and the usecase also refuses an
 * API key, an agent and a job. `.strict()`, so a mistyped key is a 400 rather
 * than a silent no-op.
 */
import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { getManagedAgentsSwitch, setManagedAgentsSwitch } from '@/app-layer/usecases/managed-agents-switch';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

const Body = z.object({ enabled: z.boolean() }).strict();

const getHandler = requirePermission('admin.view', async (_req: NextRequest, _ctx, requestCtx) =>
    jsonResponse({ setting: await getManagedAgentsSwitch(requestCtx) }),
);

const putHandler = requirePermission(
    'admin.tenant_lifecycle',
    async (req: NextRequest, _ctx, requestCtx) => {
        const { enabled } = Body.parse(await req.json());
        return jsonResponse({ setting: await setManagedAgentsSwitch(requestCtx, enabled) });
    },
);

export const GET = withApiErrorHandling(getHandler);
export const PUT = withApiErrorHandling(putHandler);
