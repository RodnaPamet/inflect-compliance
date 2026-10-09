/**
 * The access packages a grant can be composed against (#3329).
 *
 * HUMAN-FACING, and that is the whole reason this is not a third tool on the
 * grant endpoint. That endpoint advertises exactly two tools and a test asserts
 * the COUNT, because its only intended client is our own dispatch — which has
 * no use for discovery, being handed a resolved package id by an approved
 * template. A human composing a grant is a different caller with a different
 * authority, so it gets a session-gated route.
 *
 * `admin.manage`, matching `admin/integrations/**` and the legacy-access admin
 * reads: this reads the customer's directory metadata through a connection an
 * administrator configured. It is NOT `admin.tenant_lifecycle` — that is the
 * gate on the WRITE path, and reading what packages exist grants nothing.
 */
import { NextResponse } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { listAccessPackages } from '@/app-layer/usecases/entra-entitlement-discovery';

export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req, _routeArgs, ctx) => {
        const outcome = await listAccessPackages(ctx);
        if (!outcome.ok) {
            // 409, not 500: the tenant's configuration is the thing that is
            // wrong, the sentence says which of the four causes it is, and a
            // 500 would read as our fault and send somebody to the logs.
            return NextResponse.json({ error: outcome.refused }, { status: 409 });
        }
        return NextResponse.json({
            packages: outcome.page.items,
            // Surfaced, never dropped. A list silently cut at a page boundary
            // is a form that cannot offer a package the tenant has, and the
            // operator cannot tell that from the package not existing.
            truncated: outcome.page.truncated,
        });
    }),
);
