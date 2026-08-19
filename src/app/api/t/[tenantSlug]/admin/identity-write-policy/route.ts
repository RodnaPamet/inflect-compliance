/**
 * GET  /api/t/{slug}/admin/identity-write-policy — read both directions.
 * PUT  /api/t/{slug}/admin/identity-write-policy — set one direction's mode.
 *
 * OWNER-only, via `admin.tenant_lifecycle`. That key is deliberately the same
 * one that guards tenant deletion and DEK rotation: this setting decides whether
 * the product may disable or create accounts in the customer's own identity
 * directory, which is authority of the same class — and ADMIN explicitly does
 * not hold it (`getPermissionsForRole('ADMIN').admin.tenant_lifecycle` is false
 * by type).
 *
 * `requirePermission` rather than a hand-rolled role check, so a denial writes an
 * `AUTHZ_DENIED` audit row. A 403 nobody can find later is not a gate.
 */
import { z } from 'zod';
import type { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import {
    getIdentityWritePolicy,
    setIdentityWriteMode,
    describeRefusal,
    DRY_RUN_MIN_DAYS,
} from '@/app-layer/usecases/identity-write-policy';

const Body = z.object({
    direction: z.enum(['leaver', 'joiner']),
    mode: z.enum(['DISABLED', 'DRY_RUN', 'PROPOSE', 'AUTOMATIC']),
});

const getHandler = requirePermission('admin.tenant_lifecycle', async (_req, _ctx, requestCtx) => {
    const policy = await getIdentityWritePolicy(requestCtx);
    const now = new Date();

    // Return the refusal reason for each direction's NEXT rung alongside the
    // current state, so the UI can explain why a control is unavailable instead
    // of only disabling it. "Greyed out with no reason" is how an operator
    // concludes the feature is broken.
    return jsonResponse({
        directions: Object.fromEntries(
            (['leaver', 'joiner'] as const).map((d) => {
                const ladder = ['DISABLED', 'DRY_RUN', 'PROPOSE', 'AUTOMATIC'] as const;
                const next = ladder[Math.min(ladder.indexOf(policy[d].mode) + 1, ladder.length - 1)];
                return [
                    d,
                    {
                        mode: policy[d].mode,
                        dryRunSince: policy[d].dryRunSince,
                        nextMode: next === policy[d].mode ? null : next,
                        blockedReason: next === policy[d].mode ? null : describeRefusal(policy[d], next, now),
                    },
                ];
            }),
        ),
        dryRunMinDays: DRY_RUN_MIN_DAYS,
    });
});

const putHandler = requirePermission('admin.tenant_lifecycle', async (req: NextRequest, _ctx, requestCtx) => {
    const { direction, mode } = Body.parse(await req.json());
    const state = await setIdentityWriteMode(requestCtx, direction, mode);
    return jsonResponse({ direction, ...state });
});

// `withApiErrorHandling` OUTSIDE `requirePermission`, matching
// tenant-dek-rotation: the permission denial must be raised inside the wrapper
// so it becomes the standard ApiErrorResponse (and its AUTHZ_DENIED audit row
// is written) rather than escaping as an unhandled throw.
export const GET = withApiErrorHandling(getHandler);
export const PUT = withApiErrorHandling(putHandler);
