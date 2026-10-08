/**
 * Read and set the column mapping for a legacy access connection.
 *
 * The mapping decides which legacy column means `email` and which means
 * `employeeNumber` — both STRONG signals that can produce a `LINKED` with no
 * human looking — so PUT is `admin.manage` and the usecase audits it. GET is the
 * same permission rather than a reader's, because the response enumerates a
 * customer's legacy SCHEMA; the surface a reviewer needs (why one row was
 * suggested) is the convention and the signal list, not the whole column map.
 *
 * @module app/api/t/[tenantSlug]/admin/legacy-access/mapping
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import {
    getLegacyAccessMapping,
    saveLegacyAccessMapping,
} from '@/app-layer/usecases/legacy-access-mapping';
import {
    CANONICAL_STATUSES,
    EntitlementLayoutSchema,
} from '@/lib/legacy-access/canonical';

const Body = z.object({
    connectionId: z.string().min(1).max(64),
    fields: z.record(z.string().min(1).max(64), z.string().min(1).max(256)),
    entitlements: EntitlementLayoutSchema,
    statusValues: z.record(z.string().min(1).max(64), z.enum(CANONICAL_STATUSES)).optional(),
    columnSetFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const parsed = Body.safeParse(await req.json().catch(() => null));
        if (!parsed.success) {
            const paths = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].sort();
            throw badRequest(`Invalid mapping request at: ${paths.join(', ')}`);
        }
        // Every refusal the usecase can raise — an unmapped `accountKey`, no
        // identity-bearing field, a denylisted column, two fields on one column —
        // arrives as a `badRequest` naming EVERY problem at once, so an
        // administrator fixing a form is not made to rediscover the requirement
        // list one round trip at a time.
        const mapping = await saveLegacyAccessMapping(ctx, parsed.data);
        return NextResponse.json({ mapping }, { status: 200 });
    })
);

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const connectionId = new URL(req.url).searchParams.get('connectionId');
        if (!connectionId) throw badRequest('connectionId is required');
        const mapping = await getLegacyAccessMapping(ctx, connectionId);
        return NextResponse.json({ mapping });
    })
);
