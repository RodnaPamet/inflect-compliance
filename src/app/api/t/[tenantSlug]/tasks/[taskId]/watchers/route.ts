import type { NextRequest } from 'next/server';
import { listTaskWatchers, addTaskWatcher, removeTaskWatcher } from '@/app-layer/usecases/task';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { parseJsonBody } from '@/lib/validation/route';
import { jsonResponse } from '@/lib/api-response';
import { z } from 'zod';

type TaskWatcherParams = { tenantSlug: string; taskId: string };

// Inline body schema (no `.openapi()` — the watcher surface is an
// internal UI affordance, not part of the public API contract, so it
// stays out of the OpenAPI snapshot). `userId` is optional: omitted =
// the caller watches the task themselves (the common one-click case).
const AddWatcherSchema = z.object({ userId: z.string().optional() }).strip();

// GET — list a task's watchers (id/name/email per row).
export const GET = withApiErrorHandling(requirePermission<TaskWatcherParams>('tasks.view', async (_req, { params }, ctx) => {
    const { taskId } = await params;
    const watchers = await listTaskWatchers(ctx, taskId);
    return jsonResponse(watchers);
}));

// POST — add a watcher. Body `userId` defaults to the current user so
// the detail-page "Watch" toggle can POST an empty body.
//
// Gated on `tasks.view`, not `tasks.edit`: watching yourself is a personal
// subscription and a READER must be able to do it. Watching SOMEONE ELSE is
// still a write, and `addTaskWatcher` escalates to the write gate when the
// target is not the caller — the coarse HTTP gate opens the door, the
// usecase makes the finer decision (same split as the bulk-delete route).
export const POST = withApiErrorHandling(requirePermission<TaskWatcherParams>('tasks.view', async (req: NextRequest, { params }, ctx) => {
    const { taskId } = await params;
    const body = await parseJsonBody(req, AddWatcherSchema);
    const watcher = await addTaskWatcher(ctx, taskId, body.userId ?? ctx.userId);
    return jsonResponse(watcher, { status: 201 });
}));

// DELETE — remove a watcher. `?userId=` selects which watcher to drop;
// omitted = the current user unwatches themselves. Same view-gate + usecase
// escalation as POST above.
export const DELETE = withApiErrorHandling(requirePermission<TaskWatcherParams>('tasks.view', async (req: NextRequest, { params }, ctx) => {
    const { taskId } = await params;
    const userId = req.nextUrl.searchParams.get('userId') ?? ctx.userId;
    await removeTaskWatcher(ctx, taskId, userId);
    return jsonResponse({ ok: true });
}));
