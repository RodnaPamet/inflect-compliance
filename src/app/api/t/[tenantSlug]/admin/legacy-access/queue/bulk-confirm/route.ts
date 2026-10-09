/**
 * Confirm several SUGGESTED rows at once.
 *
 * Returns 200 with a PER-ROW outcome list even when some rows failed, because a
 * bulk call that half-succeeds has to say which half. A 4xx for the whole
 * request would leave the reviewer unable to tell which of fifty accounts were
 * written, and their only safe move would be to redo all fifty.
 *
 * The request is still refused outright for the two things that make the whole
 * call wrong rather than one row: an empty list, and more rows than the cap.
 *
 * @module app/api/t/[tenantSlug]/admin/legacy-access/queue/bulk-confirm
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import {
    BULK_MAX_ROWS,
    bulkConfirmLegacyAccounts,
} from '@/app-layer/usecases/legacy-reviewer-actions';

const Body = z.object({
    connectionId: z.string().min(1).max(64),
    executionId: z.string().min(1).max(64),
    rows: z
        .array(
            z.object({
                accountKey: z.string().min(1).max(256),
                employeeId: z.string().min(1).max(64),
            })
        )
        .min(1)
        // Bounded HERE as well as in the usecase, so an oversized body is
        // rejected before it is parsed into fifty-plus objects. The constant is
        // imported rather than repeated — two caps that can disagree are worse
        // than one.
        .max(BULK_MAX_ROWS),
});

export const POST = withApiErrorHandling(
    requirePermission('identity_reconciliation.confirm', async (req: NextRequest, _routeArgs, ctx) => {
        const parsed = Body.safeParse(await req.json().catch(() => null));
        if (!parsed.success) {
            const paths = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].sort();
            throw badRequest(`Invalid bulk confirmation at: ${paths.join(', ')}`);
        }
        const outcomes = await bulkConfirmLegacyAccounts(ctx, parsed.data);
        const confirmed = outcomes.filter((o) => o.ok).length;
        return NextResponse.json(
            { outcomes, confirmed, refused: outcomes.length - confirmed },
            { status: 200 }
        );
    })
);
