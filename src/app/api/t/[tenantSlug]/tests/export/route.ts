/**
 * GET /api/t/[tenantSlug]/tests/export?controlId=X&format=csv|json&period=90
 * Exports test evidence bundle.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { exportTestEvidenceBundle } from '@/app-layer/usecases/test-hardening';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

const QuerySchema = z.object({
    controlId: z.string().optional(),
    // Validated, not cast — an unknown format used to slip through as a bad
    // string cast to the union type.
    format: z.enum(['csv', 'json']).default('json'),
    period: z.coerce.number().int().min(1).max(3650).optional(),
});

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
        controlId: url.searchParams.get('controlId') ?? undefined,
        format: url.searchParams.get('format') ?? undefined,
        period: url.searchParams.get('period') ?? undefined,
    });
    if (!parsed.success) {
        return jsonResponse({ error: 'Invalid query', details: parsed.error.flatten() }, { status: 400 });
    }
    const { controlId, format, period: periodDays } = parsed.data;

    const result = await exportTestEvidenceBundle(ctx, { controlId, format, periodDays });

    if (format === 'csv') {
        return new NextResponse(result as string, {
            status: 200,
            headers: {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="test-evidence-export.csv"`,
            },
        });
    }

    return jsonResponse(result);
});
