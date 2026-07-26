import { NextRequest } from 'next/server';
import { z } from 'zod';
import { getLegacyCtx } from '@/app-layer/context';
import { listTasks, createTask } from '@/app-layer/usecases/task';
import { CreateTaskSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';

/**
 * @deprecated Use /api/t/[tenantSlug]/tasks.
 *
 * Kept for backward compatibility, but brought to parity with the
 * tenant-scoped route on the two things that actually matter here:
 *
 *  - the list read is BOUNDED. It previously called `listTasks(ctx)` with no
 *    `take`, so a large tenant serialised its entire task table into one
 *    response.
 *  - query params are parsed with Zod instead of being read raw, so a
 *    malformed value is a 400 at the boundary rather than reaching the
 *    repository.
 *
 * Authorization is unchanged and unaffected by this: both usecases enforce
 * the granular tasks.* flags at the policy layer, which is the choke point
 * every surface — this one included — passes through.
 */
const LEGACY_LIST_CAP = 200;

const LegacyTaskQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(LEGACY_LIST_CAP).optional(),
    status: z.string().optional(),
    type: z.string().optional(),
    severity: z.string().optional(),
    priority: z.string().optional(),
    source: z.string().optional(),
    assigneeUserId: z.string().optional(),
    controlId: z.string().optional(),
}).strip();

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const ctx = await getLegacyCtx(req);
    const query = LegacyTaskQuerySchema.parse(
        Object.fromEntries(req.nextUrl.searchParams.entries()),
    );
    const { limit, ...filters } = query;
    const tasks = await listTasks(ctx, filters, { take: limit ?? LEGACY_LIST_CAP });
    return jsonResponse(tasks);
});

export const POST = withApiErrorHandling(async (req: NextRequest) => {
    // Body FIRST, then context — deliberately. `withValidatedBody` used to
    // impose this order, and it matters: a malformed body must surface as a
    // 400 from the schema rather than a 500 from context resolution failing
    // first on an unauthenticated caller.
    const body = await parseJsonBody(req, CreateTaskSchema);
    const ctx = await getLegacyCtx(req);
    const task = await createTask(ctx, body);
    return jsonResponse(task, { status: 201 });
});
