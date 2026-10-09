/**
 * The assignment policies valid for ONE access package (#3329).
 *
 * Separate from the package list, and read per package, because fetching every
 * package's policies to build one payload is an N+1 against a customer's
 * directory on every form load.
 *
 * The usecase re-checks that each returned policy belongs to the requested
 * package rather than trusting the far end's `$filter`. That is the check which
 * closes the undetectable-swap case: `accessPackageId` and
 * `assignmentPolicyId` are both opaque GUIDs, so a form offering policies from
 * the wrong package composes a grant Graph ACCEPTS and that grants the wrong
 * thing.
 */
import { NextRequest, NextResponse } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { badRequest } from '@/lib/errors/types';
import { listAssignmentPolicies } from '@/app-layer/usecases/entra-entitlement-discovery';

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const accessPackageId = new URL(req.url).searchParams.get('accessPackageId');
        // Required, not defaulted. There is no sensible "all policies" answer
        // here: a policy list not scoped to a package is exactly the input that
        // lets the wrong pair be composed.
        if (!accessPackageId) throw badRequest('accessPackageId is required');
        const outcome = await listAssignmentPolicies(ctx, accessPackageId);
        if (!outcome.ok) {
            return NextResponse.json({ error: outcome.refused }, { status: 409 });
        }
        return NextResponse.json({
            policies: outcome.page.items,
            truncated: outcome.page.truncated,
        });
    }),
);
