/**
 * GET /api/t/[tenantSlug]/users/assignable — list ACTIVE tenant
 * members in a minimal shape (id + name + email + image) for
 * assignment pickers (task, risk, evidence, etc.).
 *
 * Distinct from `/admin/members` which is admin-gated and exposes
 * session counts + invite/deactivated rows. Any signed-in tenant
 * member can read this roster — gated by the usecase's
 * `assertCanRead`.
 *
 * `?audience=task-reviewer` narrows the roster to the members a task's
 * reviewer may be — those whose role can edit tasks (#4278). Any other
 * `audience` value is a 400, not a silently full roster.
 *
 * Cache: edge read-tier rate-limit applies automatically (GAP-17 —
 * every tenant-scoped GET).
 */
import { NextRequest } from 'next/server';
import { getTenantCtx } from '@/app-layer/context';
import { listAssignableUsers } from '@/app-layer/usecases/tenant-admin';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { z } from 'zod';

const AssignableQuerySchema = z
    .object({ audience: z.enum(['task-reviewer']).optional() })
    .strip();

export const GET = withApiErrorHandling(
    async (
        req: NextRequest,
        { params: paramsPromise }: { params: Promise<{ tenantSlug: string }> },
    ) => {
        const params = await paramsPromise;
        const ctx = await getTenantCtx(params, req);
        const query = AssignableQuerySchema.parse(
            Object.fromEntries(req.nextUrl.searchParams.entries()),
        );
        const users = await listAssignableUsers(ctx, {
            taskReviewersOnly: query.audience === 'task-reviewer',
        });
        return jsonResponse(users);
    },
);
