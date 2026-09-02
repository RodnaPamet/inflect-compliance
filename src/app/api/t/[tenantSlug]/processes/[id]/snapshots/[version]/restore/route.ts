import { z } from 'zod';
import { restoreProcessMapSnapshot } from '@/app-layer/usecases/process-map';
import { withApiErrorHandling } from '@/lib/errors/api';
import { parseJsonBody } from '@/lib/validation/route';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';
import { badRequest } from '@/lib/errors/types';

/**
 * Epic P5-PR-B — restore the active map to a target snapshot.
 *
 * Body: { expectedVersion: number } — the version the client
 * believes is current. Forwarded to `replaceGraph` so the
 * Epic-P1 optimistic-concurrency check still gates the write.
 *
 * Returns the freshly-saved map (now at the post-restore
 * version, which is `expectedVersion + 1` — never the target
 * version, since history is preserved by the snapshot system).
 *
 * ═══ THE GATE (#2197) ═══
 *
 * Destructive because the CURRENT version is what it overwrites, and until
 * #2197 the only authorization was `assertCanWrite` inside the usecase — which
 * refuses correctly and writes NOTHING, so a refused rollback of a process map
 * left no audit row. `processes.edit` mirrors that assert: TRUE for exactly
 * OWNER / ADMIN / EDITOR, which is `computePermissions(...).canWrite`.
 *
 * The body moved to `parseJsonBody` because `withValidatedBody` passes the body
 * in the third argument slot `requirePermission` uses for the resolved ctx.
 * One observable consequence: a malformed body from an under-privileged caller
 * now answers 403 where it answered 400, because the gate runs first.
 */
const Body = z.object({
    expectedVersion: z.number().int().min(1),
});

type Params = { tenantSlug: string; id: string; version: string };

export const POST = withApiErrorHandling(
    requirePermission<Params>('processes.edit', async (req, { params }, ctx) => {
        // Body first, then the version segment — the same order the
        // `withValidatedBody` composition produced, so a request that is
        // wrong in both ways keeps answering with the same error it did.
        const body = await parseJsonBody(req, Body);
        const target = Number.parseInt(params.version, 10);
        if (!Number.isFinite(target) || target < 1) {
            throw badRequest('Invalid version');
        }
        const map = await restoreProcessMapSnapshot(
            ctx,
            params.id,
            target,
            body.expectedVersion,
        );
        return jsonResponse(map);
    }),
);
