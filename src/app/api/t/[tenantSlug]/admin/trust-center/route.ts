import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/security/permission-middleware';
import { getTrustCenter, upsertTrustCenter } from '@/app-layer/usecases/trust-center';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

const UpsertSchema = z.object({
    displayName: z.string().min(1).max(200),
    tagline: z.string().max(300).optional().nullable(),
    postureSummary: z.string().max(20_000).optional().nullable(),
    securityContact: z.string().max(200).optional().nullable(),
    indexable: z.boolean().optional(),
    // Omitted keeps the stored value (#5764).
    ndaRequired: z.boolean().optional(),
    publishedFrameworks: z
        .array(z.object({ key: z.string().max(64), statusLabel: z.string().max(64), badge: z.string().max(64).optional() }))
        .max(50)
        .optional(),
    publishedDocuments: z
        .array(z.object({ label: z.string().max(200), url: z.string().max(2000) }))
        .max(50)
        .optional(),
});

// Compose is ADMIN-tier; PUBLISHING (enable) is OWNER-tier — see ./enable.
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) => {
        const tc = await getTrustCenter(ctx);
        return jsonResponse(tc);
    }),
);

export const PUT = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const body = await req.json();
        const input = UpsertSchema.parse(body);
        const tc = await upsertTrustCenter(ctx, input);
        return jsonResponse(tc);
    }),
);
