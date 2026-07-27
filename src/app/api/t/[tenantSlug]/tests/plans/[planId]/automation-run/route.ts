/**
 * POST /api/t/[tenantSlug]/tests/plans/[planId]/automation-run
 * Creates a completed test run from an automation/integration result.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getTenantCtx } from '@/app-layer/context';
import { createAutomatedTestRun } from '@/app-layer/usecases/control-test';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

const EvidenceLinkSchema = z.object({
    kind: z.enum(['FILE', 'LINK', 'INTEGRATION_RESULT']),
    fileId: z.string().optional().nullable(),
    url: z.string().url().max(2048).optional().nullable(),
    integrationResultId: z.string().optional().nullable(),
    note: z.string().max(2000).optional().nullable(),
});

const AutomationRunSchema = z.object({
    result: z.enum(['PASS', 'FAIL', 'INCONCLUSIVE']),
    notes: z.string().max(10_000).optional().nullable(),
    integrationResultId: z.string().optional().nullable(),
    // Bounded so a malformed/hostile payload can't attach an unbounded set.
    evidenceLinks: z.array(EvidenceLinkSchema).max(50).optional(),
});

export const POST = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string; planId: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    let raw: unknown;
    try {
        raw = await req.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const parsed = AutomationRunSchema.safeParse(raw);
    if (!parsed.success) {
        return jsonResponse(
            { error: 'Invalid request body', details: parsed.error.flatten() },
            { status: 400 },
        );
    }
    const run = await createAutomatedTestRun(ctx, params.planId, parsed.data);
    return jsonResponse(run, { status: 201 });
});
