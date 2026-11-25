/**
 * `/api/t/:slug/admin/agents/probe-runs` — submit and list probe runs
 * (`scanent-probes/1`; active flavour, step 8a).
 *
 * POST takes a prober's signed report as the raw body: what a run of attacker
 * probes made agents in an authorised engagement do. The gate is
 * `admin.agent_probes_ingest`, the key a prober's API key carries through the
 * `admin:agent_probes_ingest` scope and nothing else; the usecase then refuses
 * any report not signed by a prober key this tenant registered
 * (`admin.agent_registry`), and any whose engagement scope was not signed by an
 * approver key the owner registered (`admin.tenant_lifecycle`). GET lists the
 * runs under the inventory read, as the harness list is (#3710): the read-only
 * `admin.agent_registry_view`, or the register key — with no excerpt and no
 * endpoint.
 *
 * The body is read through the byte-capped stream the harness ingest uses
 * (`readSignedReportBody`), at the same contract bound.
 */
import { NextRequest } from 'next/server';

import { ingestProbeReport, listProbeRuns } from '@/app-layer/usecases/probe-runs';
import { MAX_REPORT_BYTES } from '@/lib/agentic/harness-contract';
import { readSignedReportBody } from '@/lib/agentic/scan-report-body';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_probes_ingest',
        async (req: NextRequest, _routeArgs, ctx) => {
            const raw = await readSignedReportBody(req, MAX_REPORT_BYTES, 'probe_report_refused');
            return jsonResponse(await ingestProbeReport(ctx, raw), { status: 201 });
        },
    ),
);

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        { keys: ['admin.agent_registry_view', 'admin.agent_registry'], mode: 'any' },
        async (req: NextRequest, _routeArgs, ctx) => {
            const take = Number(req.nextUrl.searchParams.get('take') ?? '50');
            return jsonResponse(await listProbeRuns(ctx, { take: Number.isFinite(take) ? take : 50 }));
        },
    ),
);
