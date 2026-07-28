import { NextRequest } from 'next/server';
import { listSubprocessors, addSubprocessor, removeSubprocessor } from '@/app-layer/usecases/vendor-audit';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { z } from 'zod';
import { jsonResponse } from '@/lib/api-response';

/**
 * Sub-processor relationships for a vendor — the 4th-party register.
 *
 * Gated at the Epic C.1 layer as well as in the usecase. The usecase asserts
 * were already present (read → `vendors.view`, mutations → `vendors.edit`);
 * what was missing here is the middleware, and its absence had two concrete
 * costs: a denial threw a bare 403 that wrote NO hash-chained `AUTHZ_DENIED`
 * audit row, and these routes were invisible to the permission-coverage
 * guardrail — so a future refactor could have dropped the usecase assert with
 * nothing in CI failing.
 */

type Params = { tenantSlug: string; vendorId: string };

const AddSubprocessorSchema = z.object({
    subprocessorVendorId: z.string().min(1),
    purpose: z.string().optional(),
    dataTypes: z.string().optional(),
    country: z.string().optional(),
}).strip();

export const GET = withApiErrorHandling(
    requirePermission<Params>('vendors.view', async (_req, { params }, ctx) =>
        jsonResponse(await listSubprocessors(ctx, params.vendorId)),
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('vendors.edit', async (req: NextRequest, { params }, ctx) => {
        const body = AddSubprocessorSchema.parse(await req.json());
        return jsonResponse(await addSubprocessor(ctx, params.vendorId, body), { status: 201 });
    }),
);

export const DELETE = withApiErrorHandling(
    requirePermission<Params>('vendors.edit', async (req: NextRequest, _routeArgs, ctx) => {
        const relationId = new URL(req.url).searchParams.get('relationId');
        if (!relationId) return jsonResponse({ error: 'relationId required' }, { status: 400 });
        return jsonResponse(await removeSubprocessor(ctx, relationId));
    }),
);
