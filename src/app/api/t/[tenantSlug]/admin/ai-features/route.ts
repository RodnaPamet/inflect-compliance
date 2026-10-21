/**
 * Read and flip the four AI switches for this tenant.
 *
 * `admin.tenant_lifecycle`, NOT `admin.view` — the same choice as
 * `process-canvas-module` and `identity-write-policy`. Turning AI off for a
 * workspace is a tenant-wide act with contractual weight for some customers, so
 * it belongs with the owner-level permissions rather than with the read-only
 * admin surface.
 *
 * A PUT here can only ever change the TENANT layer. The env flags are process
 * constants; see `usecases/ai-feature-toggles` for why that asymmetry is the
 * design and not a limitation, and why the response carries `forcedOffByEnv`.
 */
import { z } from 'zod';
import type { NextRequest } from 'next/server';
import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { readAiFeatureToggles, setAiFeatureToggles } from '@/app-layer/usecases/ai-feature-toggles';

/*
    A PARTIAL body, and `.strict()` so an unknown key is a 400.

    Every field optional lets the client send only the switch that moved, which
    is what stops two owners editing different toggles from overwriting each
    other. `.strict()` is the other half: without it a typo'd key
    (`aiAssistant`) would parse to `{}`, the usecase would find nothing changed,
    and the route would answer 200 having done nothing — a silent no-op is the
    worst of the three possible outcomes.

    `.refine` then rejects a genuinely empty patch for the same reason: a caller
    sending `{}` has made a mistake, and answering 200 teaches them it worked.
*/
const Body = z
    .object({
        ai: z.boolean().optional(),
        risk: z.boolean().optional(),
        assistant: z.boolean().optional(),
        questionnaire: z.boolean().optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, {
        message: 'Specify at least one toggle to change',
    });

const getHandler = requirePermission(
    'admin.tenant_lifecycle',
    async (_req: NextRequest, _ctx, requestCtx) => {
        return jsonResponse({ toggles: await readAiFeatureToggles(requestCtx) });
    },
);

const putHandler = requirePermission(
    'admin.tenant_lifecycle',
    async (req: NextRequest, _ctx, requestCtx) => {
        const patch = Body.parse(await req.json());
        const result = await setAiFeatureToggles(requestCtx, patch);
        // `changed` travels to the client so the UI can tell "you turned it off"
        // from "it was already off" without re-reading, and so a no-op is
        // visible rather than looking like a successful write.
        return jsonResponse({ toggles: result.states, changed: result.changed });
    },
);

// `withApiErrorHandling` OUTSIDE `requirePermission`, matching
// process-canvas-module and identity-write-policy: the permission denial must
// be raised inside the wrapper so it becomes the standard ApiErrorResponse (and
// its AUTHZ_DENIED audit row is written) rather than escaping as an unhandled
// throw.
export const GET = withApiErrorHandling(getHandler);
export const PUT = withApiErrorHandling(putHandler);
