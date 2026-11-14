/**
 * `/api/t/:slug/admin/agents/integration-scans` — submit and list third-party
 * application scans (`scanent-integrations/1`).
 *
 * POST takes the scanner's second signed report as the raw body: the
 * applications a directory (Entra, Okta, GitHub) has granted access to. The
 * gate is `admin.integrations_ingest`, the key a scanner's API key carries
 * through the `admin:integrations_ingest` scope and nothing else; the usecase
 * then refuses any report not signed by a scanner key this tenant registered —
 * the same keys that sign harness reports, registered under
 * `admin.agent_registry`. GET lists the scans under the inventory read, as the
 * harness list is (#3710): the read-only `admin.agent_registry_view`, or the
 * register key.
 *
 * The body is read through the byte-capped stream the harness ingest uses
 * (`readSignedReportBody`), at the same contract bound.
 */
import { NextRequest } from 'next/server';

import { ingestThirdPartyAppReport, listThirdPartyAppScans } from '@/app-layer/usecases/third-party-app-scans';
import { MAX_REPORT_BYTES } from '@/lib/agentic/harness-contract';
import { readSignedReportBody } from '@/lib/agentic/scan-report-body';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.integrations_ingest',
        async (req: NextRequest, _routeArgs, ctx) => {
            const raw = await readSignedReportBody(req, MAX_REPORT_BYTES, 'third_party_app_report_refused');
            return jsonResponse(await ingestThirdPartyAppReport(ctx, raw), { status: 201 });
        },
    ),
);

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        { keys: ['admin.agent_registry_view', 'admin.agent_registry'], mode: 'any' },
        async (req: NextRequest, _routeArgs, ctx) => {
            const take = Number(req.nextUrl.searchParams.get('take') ?? '50');
            return jsonResponse(await listThirdPartyAppScans(ctx, { take: Number.isFinite(take) ? take : 50 }));
        },
    ),
);
