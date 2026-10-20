/**
 * `POST /api/t/:slug/admin/agents/audit-pilot` — set up the pilot auditor and
 * its five procedure plans as the caller, who becomes the auditor's owner
 * (#3676 step 3c; reachable in the product since #3807).
 *
 * Body `{ apply, agentName?, controls? }`. `apply: false` is the dry run: it
 * reports each step and writes nothing. Both answer 200 with the usecase's
 * result, a named refusal included (`{ ok: false, refusal, detail }`), because
 * a refusal here is the answer to "can the pilot be set up yet?", not a
 * failure of the request. A refusal a usecase raises while applying is thrown
 * and answered as that usecase's error.
 *
 * `admin.agent_registry`, the key the `admin/agents(/.*)?` rule records and the
 * key the register's writes take. The usecase asks the rest: a person (never a
 * key, an agent or a job), an ACTIVE second-line member who may own an
 * auditor, holding `admin.agent_tool_exposure` and `tests.create` too.
 */
import type { NextRequest } from 'next/server';

import { setUpAuditPilotAsOwner } from '@/app-layer/usecases/audit-pilot-setup';
import { AuditPilotSetupSchema } from '@/app-layer/schemas/audit-pilot-setup.schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { parseJsonBody } from '@/lib/validation/route';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('admin.agent_registry', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await parseJsonBody(req, AuditPilotSetupSchema);
        return jsonResponse(
            await setUpAuditPilotAsOwner(ctx, {
                apply: body.apply,
                agentName: body.agentName,
                controls: body.controls,
            }),
        );
    }),
);
