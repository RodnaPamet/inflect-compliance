import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listEvidence, listEvidencePaginated, createEvidence, listEvidenceWithDeleted } from '@/app-layer/usecases/evidence';
import { withValidatedBody } from '@/lib/validation/route';
import { CreateEvidenceSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { z } from 'zod';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

const EvidenceQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    type: z.string().optional(),
    // A raw string, NOT `z.enum`, because the list page's status facet is
    // `multiple: true` and comma-joins its selections. A single-member enum
    // could not express `?status=DRAFT,SUBMITTED`, so every two-value
    // selection 400'd here and the table rendered empty — which reads as
    // "no evidence matches" rather than as an error.
    //
    // Validation is not lost, it moves one layer in:
    // `EvidenceRepository._buildWhere` runs `parseEnumListFilter` over this
    // value, rejects any member that is not a real `EvidenceStatus` with a
    // 400 naming the offender, and returns `{ in: [...] }` for the
    // multi-value form. That branch was unreachable while this enum stood in
    // front of it. `type` was already a bare string for the same reason.
    status: z.string().optional(),
    controlId: z.string().optional(),
    // EP-3 Part 5 — category filter (exact match).
    category: z.string().optional(),
    // Tag filter — normalised (lower-cased) exact match, server-side so
    // the result set matches what the tag chip claims.
    tag: z.string().optional(),
    q: z.string().optional().transform(normalizeQ),
    archived: z.enum(['true', 'false']).optional(),
    expiring: z.enum(['true', 'false']).optional(),
    // B8 follow-up — Folder filter. `__none__` is the sentinel
    // matching null/empty folder values; any other value is an
    // exact-match. Optional everywhere — omitted ⇒ no filter.
    folder: z.string().optional(),
    // Retention tab + freshness bucket. Both used to be applied CLIENT-side
    // over whatever rows the backfill cap returned — `freshness` was even
    // sent by the UI and silently dropped by this schema's `.strip()`, which
    // is why the page carried a banner explaining that its KPI counts and its
    // rows disagreed. Values are validated in the repository's predicate
    // switch, which returns no filter for anything it does not recognise.
    tab: z.string().optional(),
    freshness: z.string().optional(),
    includeDeleted: z.enum(['true', 'false']).optional(),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
    const query = EvidenceQuerySchema.parse(sp);

    if (query.includeDeleted === 'true') {
        const evidence = await listEvidenceWithDeleted(ctx);
        return jsonResponse(evidence);
    }

    const filters = {
        type: query.type,
        status: query.status,
        controlId: query.controlId,
        category: query.category,
        tag: query.tag,
        folder: query.folder,
        q: query.q,
        tab: query.tab,
        freshness: query.freshness,
        archived: query.archived === 'true' ? true : query.archived === 'false' ? false : undefined,
        expiring: query.expiring === 'true',
    };

    // If pagination params present, use paginated response
    if (query.limit !== undefined || query.cursor !== undefined) {
        const result = await listEvidencePaginated(ctx, {
            limit: query.limit,
            cursor: query.cursor,
            filters,
        });
        return jsonResponse(result);
    }

    // PR-5 — backfill cap. Ask for cap+1 rows; helper slices and
    // reports `truncated`.
    const evidence = await listEvidence(ctx, filters, { take: LIST_BACKFILL_CAP + 1 });
    const result = applyBackfillCap(evidence);
    // PR-6 — row-count observability.
    recordListPageRowCount({
        entity: 'evidence',
        count: result.rows.length,
        truncated: result.truncated,
        tenantId: ctx.tenantId,
    });
    return jsonResponse(result);
});

export const POST = withApiErrorHandling(withValidatedBody(CreateEvidenceSchema, async (req, { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> }, body) => {
    const params = await paramsPromise;
    const ctx = await getTenantCtx(params, req);
    const evidence = await createEvidence(ctx, body);
    return jsonResponse(evidence, { status: 201 });
}));
