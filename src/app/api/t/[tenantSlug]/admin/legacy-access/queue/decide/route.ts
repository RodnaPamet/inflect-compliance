/**
 * One reviewer decision about one legacy account.
 *
 * `identity_reconciliation.confirm` — OWNER and ADMIN. See the `PermissionSet`
 * docblock for why that is narrower than `access_reviews.decide`: a
 * confirmation is durable, and from then on the account resolves LINKED on
 * every run and is acted on without anybody looking.
 *
 * The action is a DISCRIMINATED union rather than a flat body with optional
 * fields. A flat body would accept `{ kind: 'ORPHAN', employeeId: '...' }` and
 * leave the usecase to decide which half to believe; the union makes that
 * request unparseable, so the contradiction is a 400 at the edge rather than a
 * judgement call in the middle.
 *
 * @module app/api/t/[tenantSlug]/admin/legacy-access/queue/decide
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { decideLegacyAccount } from '@/app-layer/usecases/legacy-reviewer-actions';

const Id = z.string().min(1).max(64);
/**
 * A reason long enough to be a reason. The usecase checks the length AFTER
 * sanitising, which is the check that matters; this one only keeps obviously
 * empty bodies from reaching it.
 */
const Reason = z.string().min(10).max(2000);

const Action = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('CONFIRM'), employeeId: Id }),
    z.object({ kind: z.literal('MANUAL'), employeeId: Id, justification: Reason }),
    z.object({ kind: z.literal('NON_PERSON'), ownerUserId: Id, justification: Reason }),
    z.object({
        kind: z.literal('EXTERNAL'),
        justification: Reason,
        // ISO in, Date out. The usecase compares against its own clock.
        expiresAt: z.string().datetime(),
    }),
    z.object({ kind: z.literal('ORPHAN'), justification: Reason }),
    z.object({ kind: z.literal('DEFER') }),
]);

const Body = z.object({
    connectionId: Id,
    accountKey: z.string().min(1).max(256),
    /** The run the reviewer was looking at. A newer one means 409. */
    executionId: Id,
    action: Action,
});

export const POST = withApiErrorHandling(
    requirePermission('identity_reconciliation.confirm', async (req: NextRequest, _routeArgs, ctx) => {
        const parsed = Body.safeParse(await req.json().catch(() => null));
        if (!parsed.success) {
            const paths = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].sort();
            throw badRequest(`Invalid decision at: ${paths.join(', ')}`);
        }

        const { action } = parsed.data;
        const result = await decideLegacyAccount(ctx, {
            ...parsed.data,
            action:
                action.kind === 'EXTERNAL'
                    ? { ...action, expiresAt: new Date(action.expiresAt) }
                    : action,
        });
        // 409 for a superseded result comes from the usecase as a `conflict`,
        // which `withApiErrorHandling` renders with its own status. Nothing here
        // re-maps it: a status decided in two places is a status that disagrees.
        return NextResponse.json({ result }, { status: 200 });
    })
);
