import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { CreatePolicySchema } from '@/lib/schemas';
import * as policyUsecases from '@/app-layer/usecases/policy';
import { getTemplateExternalRef, getSuggestedControlLinks } from '@/app-layer/usecases/policy-template-mapping';
import { z } from 'zod';
import { normalizeQ } from '@/lib/filters/query-helpers';
import { jsonResponse } from '@/lib/api-response';
import { LIST_BACKFILL_CAP, applyBackfillCap } from '@/lib/list-backfill-cap';
import { recordListPageRowCount } from '@/lib/observability/list-page-metrics';

const PolicyQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().optional(),
    status: z.string().optional(),
    category: z.string().optional(),
    language: z.string().optional(),
    q: z.string().optional().transform(normalizeQ),
    reviewBucket: z.enum(['overdue', 'upcoming']).optional(),
    // Acknowledgement-completeness facet. Resolved server-side in the
    // repository (a `currentVersionId IN (…)` narrowing), so it composes with
    // the other filters and survives pagination.
    outstanding: z.enum(['true']).optional(),
    includeDeleted: z.enum(['true', 'false']).optional(),
}).strip();

// GET /api/t/[tenantSlug]/policies — list with filters + pagination
export const GET = withApiErrorHandling(requirePermission<{ tenantSlug: string }>('policies.view', async (req, _routeArgs, ctx) => {
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  const query = PolicyQuerySchema.parse(sp);

  if (query.includeDeleted === 'true') {
    const policies = await policyUsecases.listPoliciesWithDeleted(ctx);
    return jsonResponse(policies);
  }

  const hasPagination = query.limit || query.cursor;
  if (hasPagination) {
    const result = await policyUsecases.listPoliciesPaginated(ctx, {
      limit: query.limit,
      cursor: query.cursor,
      filters: {
        status: query.status,
        category: query.category,
        language: query.language,
        q: query.q,
        reviewBucket: query.reviewBucket,
        outstandingAck: query.outstanding === 'true',
      },
    });
    return jsonResponse(result);
  }

  // PR-5 — backfill cap.
  const policies = await policyUsecases.listPolicies(
    ctx,
    {
      status: query.status,
      category: query.category,
      language: query.language,
      q: query.q,
      reviewBucket: query.reviewBucket,
      outstandingAck: query.outstanding === 'true',
    },
    { take: LIST_BACKFILL_CAP + 1 },
  );
  const result = applyBackfillCap(policies);
  // KPI card counts come from the DB, not from `result.rows`. The rows are
  // capped and SSR-windowed; the cards' filters resolve tenant-wide, so a
  // count derived from the array could not predict its own click.
  const kpiCounts = await policyUsecases.listPolicyKpiCounts(ctx, {
    status: query.status,
    category: query.category,
    language: query.language,
    q: query.q,
    reviewBucket: query.reviewBucket,
    outstandingAck: query.outstanding === 'true',
  });
  // PR-6 — row-count observability.
  recordListPageRowCount({
    entity: 'policies',
    count: result.rows.length,
    truncated: result.truncated,
    tenantId: ctx.tenantId,
  });
  return jsonResponse({ ...result, kpiCounts });
}));

// POST /api/t/[tenantSlug]/policies — create (blank or from template)
export const POST = withApiErrorHandling(
  requirePermission<{ tenantSlug: string }>('policies.create', async (req, _routeArgs, ctx) => {
    const body = await parseJsonBody(req, CreatePolicySchema);

    if (body.templateId) {
      const policy = await policyUsecases.createPolicyFromTemplate(ctx, body.templateId, {
        title: body.title,
        description: body.description,
        category: body.category,
        ownerUserId: body.ownerUserId,
        language: body.language,
      });
      // Framework-aware templates surface control-link SUGGESTIONS alongside
      // the created policy — the tenant confirms them explicitly via
      // POST /policies/[id]/control-links. Links are NEVER auto-created.
      const ref = await getTemplateExternalRef(ctx, body.templateId);
      const suggestedControlLinks = ref ? await getSuggestedControlLinks(ctx, ref) : null;
      return jsonResponse({ ...policy, suggestedControlLinks }, { status: 201 });
    }

    const policy = await policyUsecases.createPolicy(ctx, {
      title: body.title,
      description: body.description,
      category: body.category,
      ownerUserId: body.ownerUserId,
      reviewFrequencyDays: body.reviewFrequencyDays,
      language: body.language,
      content: body.content,
      // Forward the editor's content type so a WYSIWYG (HTML) first version
      // round-trips as HTML instead of defaulting to MARKDOWN and losing state.
      contentType: body.contentType,
    });

    return jsonResponse(policy, { status: 201 });
  })
);
