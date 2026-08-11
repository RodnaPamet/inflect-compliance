/**
 * Evidence bundles for a task.
 *
 * WHY THIS IS STILL UNDER `/issues`
 * ---------------------------------
 * The rest of the `/issues` surface was a parallel write API over the same
 * `Task` rows and was deleted — every one of those thirteen routes had a
 * `/tasks` twin with strictly stronger gates. These three (bundles, bundle
 * items, freeze) are the exception: they carry behaviour with no `/tasks`
 * equivalent, so deleting them would have removed a feature rather than a
 * duplicate.
 *
 * They keep the path and gain the gate. Every handler now goes through
 * `requirePermission`, which is what the deleted routes lacked: without it the
 * granular custom-role `tasks.*` flags were unreachable (the coarse
 * `ctx.permissions` set is computed from the BASE role and never reads
 * `permissionsJson`), and a denial wrote no `AUTHZ_DENIED` row, so a bypass
 * left no trace in the access trail.
 */
import { listBundles, createBundle } from '@/app-layer/usecases/issue';
import { parseJsonBody } from '@/lib/validation/route';
import { CreateBundleSchema } from '@/lib/schemas';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; issueId: string };

// NOTE: `withValidatedBody` is deliberately NOT used here. It returns a
// two-argument `(req, ctx)` handler, so nesting it inside `requirePermission`
// — whose handler contract is `(req, routeArgs, ctx)` — would silently hand it
// `routeArgs` where it expects the RequestContext. `parseJsonBody` is the
// composable half, and it is what the `/tasks` routes already use.
export const GET = withApiErrorHandling(
    requirePermission<Params>('tasks.view', async (_req, routeArgs, ctx) => {
        const params = await routeArgs.params;
        const bundles = await listBundles(ctx, params.issueId);
        return jsonResponse(bundles);
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('tasks.edit', async (req, routeArgs, ctx) => {
        const params = await routeArgs.params;
        const body = await parseJsonBody(req, CreateBundleSchema);
        const bundle = await createBundle(ctx, params.issueId, body.name);
        return jsonResponse(bundle, { status: 201 });
    }),
);
