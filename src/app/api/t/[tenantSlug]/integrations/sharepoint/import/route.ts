import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { importSharePointItems } from '@/app-layer/integrations/providers/sharepoint';

/**
 * SP-3 — manual import of picked SharePoint files as evidence (synchronous).
 * Gated by `evidence.upload`. Capped server-side (SP_IMPORT_MAX_ITEMS).
 */
const Body = z.object({
    connectionId: z.string().min(1),
    items: z
        .array(z.object({ driveId: z.string().min(1), itemId: z.string().min(1), name: z.string().optional() }))
        .min(1),
    controlId: z.string().optional(),
    category: z.string().optional(),
    // `folder` was the one field the upload modal renders that this schema
    // did not accept, so it was unreachable end-to-end on the SharePoint
    // path even though `uploadEvidenceFile` has always taken it. `category`
    // was accepted here all along and simply never sent by the client.
    folder: z.string().optional(),
});

export const POST = withApiErrorHandling(
    requirePermission('evidence.upload', async (req: NextRequest, _routeArgs, ctx) => {
        const body = Body.parse(await req.json());
        return jsonResponse(await importSharePointItems(ctx, body), { status: 201 });
    }),
);
