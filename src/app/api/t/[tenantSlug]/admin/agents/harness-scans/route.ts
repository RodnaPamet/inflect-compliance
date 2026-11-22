/**
 * `/api/t/:slug/admin/agents/harness-scans` — submit and list harness scans
 * (#3665, UC1).
 *
 * POST takes a signed `inflect-agent-harness/2` report as the raw body
 * (docs/agent-harness-contract.md); the retired `/1` is refused. The gate is `admin.agent_harness_ingest`,
 * the one key a scanner's API key carries; the usecase then refuses any report
 * not signed by a scanner key this tenant registered. GET lists the scans,
 * under the inventory read like the rest of the register (#3710): the
 * read-only `admin.agent_registry_view`, or the register key.
 *
 * The body is read through a byte-capped stream that ABORTS at the contract's
 * size bound (`readSignedReportBody`, shared with the third-party application
 * ingest), rather than read whole and measured: a length check after
 * `req.text()` has already allocated what it was meant to refuse.
 */
import { NextRequest } from 'next/server';

import { ingestHarnessReport, listHarnessScans } from '@/app-layer/usecases/agent-harness-scans';
import { MAX_REPORT_BYTES } from '@/lib/agentic/harness-contract';
import { readSignedReportBody } from '@/lib/agentic/scan-report-body';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_harness_ingest',
        async (req: NextRequest, _routeArgs, ctx) => {
            const raw = await readSignedReportBody(req, MAX_REPORT_BYTES, 'harness_report_refused');
            return jsonResponse(await ingestHarnessReport(ctx, raw), { status: 201 });
        },
    ),
);

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        { keys: ['admin.agent_registry_view', 'admin.agent_registry'], mode: 'any' },
        async (req: NextRequest, _routeArgs, ctx) => {
            const take = Number(req.nextUrl.searchParams.get('take') ?? '50');
            return jsonResponse(await listHarnessScans(ctx, { take: Number.isFinite(take) ? take : 50 }));
        },
    ),
);
