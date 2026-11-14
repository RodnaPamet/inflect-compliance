import { z } from 'zod';
import { extractVendorDocument } from '@/app-layer/usecases/vendor-doc-extraction';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; vendorId: string; docId: string };

const BodySchema = z.object({
    assessmentId: z.string().optional(),
    text: z.string().max(500_000).optional(),
    materializeExceptions: z.boolean().optional(),
});

/**
 * POST /api/t/:slug/vendors/:vendorId/documents/:docId/extract
 * Parse + AI-extract the document → PROPOSE cited assessment answers (a human
 * approves before anything is scored). Gated under `vendors.edit`.
 * (`[docId]` matches the sibling document route's slug — Next requires one
 * name per dynamic segment.)
 */
export const POST = withApiErrorHandling(
    requirePermission<Params>('vendors.edit', async (req, { params }, ctx) => {
        const { vendorId, docId } = await params;
        const body = await parseJsonBody(req, BodySchema);
        // The URL's vendor is passed through so a document of another vendor
        // is refused rather than extracted under this one (#5318).
        const result = await extractVendorDocument(ctx, { ...body, documentId: docId, vendorId });
        return jsonResponse(result, { status: 201 });
    }),
);
