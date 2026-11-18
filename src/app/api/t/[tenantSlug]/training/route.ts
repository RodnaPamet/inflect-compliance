import type { NextRequest } from 'next/server';
import { listTrainingAssignments, assignTraining, AssignTrainingSchema } from '@/app-layer/usecases/training';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * PR-6 — training assignments. List (personnel.view) + assign (personnel.manage).
 *
 * GET is cursor-paged, newest first (#5764 item 6), and filters in SQL:
 *
 *   ?q=        employee name, work email or course name (contains, any case)
 *   ?status=   ASSIGNED, IN_PROGRESS, COMPLETED, OVERDUE; comma-separated or
 *              repeated. OVERDUE includes an open assignment past its due date.
 *   ?limit=    1..TRAINING_PAGE_SIZE (100), the default
 *   ?cursor=   the `nextCursor` of the page before
 *
 * A malformed `limit` or `cursor` is ignored rather than refused, as on the
 * quarantine list: a typo hands back the first page.
 *
 * With `cursor` or `limit` the reply is `{ rows, nextCursor, total }`, the
 * shape the page's "Load more" reads. Without either it keeps the older
 * `{ assignments, truncated }` keys, now holding the first page, and adds
 * `nextCursor` and `total` so a reader can go on from there.
 */
export const GET = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('personnel.view', async (req: NextRequest, _a, ctx) => {
        const params = new URL(req.url).searchParams;
        const rawLimit = params.get('limit');
        const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
        const cursor = params.get('cursor');
        const page = await listTrainingAssignments(ctx, {
            cursor,
            limit: parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined,
            q: params.get('q'),
            status: params.getAll('status'),
        });
        if (cursor !== null || rawLimit !== null) {
            return jsonResponse({ rows: page.rows, nextCursor: page.nextCursor, total: page.total });
        }
        return jsonResponse({
            assignments: page.rows,
            truncated: page.nextCursor !== null,
            nextCursor: page.nextCursor,
            total: page.total,
        });
    }),
);
export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>('personnel.manage', async (req, _a, ctx) => {
        const body = await parseJsonBody(req, AssignTrainingSchema);
        return jsonResponse(await assignTraining(ctx, body), { status: 201 });
    }),
);
