/**
 * `/api/t/:slug/admin/agents/harness-estates/:estateId` — change or remove one
 * declared estate (#3678). `admin.agent_registry`, as declaring it is.
 *
 * PATCH renames it, changes its cadence, or replaces its sources and their
 * owners; the scanner is fixed, so a scan history is never re-attributed.
 * DELETE removes the declaration; the scans stay, being the ingest's record.
 */
import { NextRequest } from 'next/server';

import {
    deleteHarnessEstate,
    updateHarnessEstate,
    UpdateHarnessEstateSchema,
} from '@/app-layer/usecases/agent-harness-estates';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; estateId: string };

export const PATCH = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (req: NextRequest, { params }, ctx) => {
            const { estateId } = await params;
            const body = UpdateHarnessEstateSchema.parse(await req.json());
            return jsonResponse(await updateHarnessEstate(ctx, estateId, body));
        },
    ),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_registry',
        async (_req: NextRequest, { params }, ctx) => {
            const { estateId } = await params;
            return jsonResponse(await deleteHarnessEstate(ctx, estateId));
        },
    ),
);
