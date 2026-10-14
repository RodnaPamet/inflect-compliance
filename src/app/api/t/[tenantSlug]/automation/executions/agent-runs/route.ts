import { NextRequest } from 'next/server';

import { getTenantCtx } from '@/app-layer/context';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { listCanvasAgentRuns } from '@/app-layer/usecases/automation-executions';

/**
 * GET — what the agent nodes on a process canvas are doing (#3472).
 *
 * One row per INVOKE_AGENT rule, carrying the latest agentic run that rule
 * started. Read-gated by the usecase (`assertCanReadAutomationHistory`), the
 * same gate its sibling `executions/live` uses — this is the same history,
 * followed one join further.
 *
 * A SIBLING ROUTE rather than a wider `executions/live`. That endpoint's shape
 * is consumed by `MonitorTab` as well as the canvas, and widening a response
 * two surfaces read to serve one of them makes the other carry a payload it
 * discards on every poll. The canvas opens a second subscription only in Run
 * Mode, which is the only time either answer matters.
 */
type Ctx = { params: Promise<{ tenantSlug: string }> };

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: Ctx) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    return jsonResponse(await listCanvasAgentRuns(ctx));
});
