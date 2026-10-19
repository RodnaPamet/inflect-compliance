/**
 * `/api/t/:slug/admin/agents/harness-scans` — submit and list harness scans
 * (#3665, UC1).
 *
 * POST takes a signed `inflect-agent-harness/1` or `/2` report as the raw body
 * (docs/agent-harness-contract.md). The gate is `admin.agent_harness_ingest`,
 * the one key a scanner's API key carries; the usecase then refuses any report
 * not signed by a scanner key this tenant registered. GET lists the scans,
 * under the inventory read like the rest of the register (#3710): the
 * read-only `admin.agent_registry_view`, or the register key.
 *
 * The body is read through a byte-capped stream that ABORTS at the contract's
 * size bound, rather than read whole and measured: a length check after
 * `req.text()` has already allocated what it was meant to refuse.
 */
import { NextRequest } from 'next/server';

import { ingestHarnessReport, listHarnessScans } from '@/app-layer/usecases/agent-harness-scans';
import { MAX_REPORT_BYTES } from '@/lib/agentic/harness-contract';
import { badRequest } from '@/lib/errors/types';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

async function readCapped(req: NextRequest, maxBytes: number): Promise<string> {
    const declared = Number(req.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw badRequest('harness_report_refused: TOO_LARGE');
    const reader = req.body?.getReader();
    if (!reader) throw badRequest('harness_report_refused: NOT_JSON: empty body');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel();
            throw badRequest('harness_report_refused: TOO_LARGE');
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_harness_ingest',
        async (req: NextRequest, _routeArgs, ctx) => {
            const raw = await readCapped(req, MAX_REPORT_BYTES);
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
