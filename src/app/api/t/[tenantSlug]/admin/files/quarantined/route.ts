/**
 * The quarantine list — admin API.
 *
 *   GET /api/t/:tenantSlug/admin/files/quarantined?limit=&cursor=
 *
 * The read side of the false-positive escape hatch. `POST
 * .../files/:fileId/clear-quarantine` shipped as the only way back from
 * a terminal `scanStatus: INFECTED`, but it takes a `fileId` and nothing
 * in the product produced one — an operator had to lift the id out of a
 * hash-chained audit log. The door existed with no handle; this is the
 * handle.
 *
 * GATED ON `admin.tenant_lifecycle` — the SAME OWNER-only key as the
 * reversal it feeds, and the choice is argued in
 * `assertCanViewQuarantinedFiles`. Short version: this list is the only
 * source of the argument the OWNER-only write consumes, and it is a map
 * of the malware in a customer's evidence library (names, sizes,
 * uploaders, engine signatures) — reconnaissance a compromised ADMIN
 * session would want. An ADMIN investigating an incident still reads
 * every `FILE_QUARANTINED` audit row at the far lower `audit.view` bar;
 * what OWNER buys is the ACTIONABLE view.
 *
 * PAGED, ALWAYS. One bad signature update condemns every matching upload
 * at once, so this is precisely the query that must never answer "all of
 * them" — `limit` is clamped to `MAX_QUARANTINE_PAGE_SIZE` and the reply
 * carries a `nextCursor`.
 *
 * A malformed `limit` / `cursor` is IGNORED rather than 400-ing. This is
 * an incident surface reached under time pressure, often by hand; a
 * typo in a query string should hand back the first page, not an error.
 * The usecase clamps whatever it is given.
 */
import type { NextRequest } from 'next/server';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { listQuarantinedFiles } from '@/app-layer/usecases/file-quarantine';

export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.tenant_lifecycle',
        async (req: NextRequest, _routeArgs, ctx) => {
            const url = new URL(req.url);
            const rawLimit = url.searchParams.get('limit');
            const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
            const result = await listQuarantinedFiles(ctx, {
                limit:
                    parsedLimit !== undefined && Number.isFinite(parsedLimit)
                        ? parsedLimit
                        : undefined,
                cursor: url.searchParams.get('cursor') ?? undefined,
            });
            return jsonResponse(result);
        },
    ),
);
