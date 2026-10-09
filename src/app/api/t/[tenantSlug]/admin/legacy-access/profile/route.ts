/**
 * Profile a legacy connection's columns, for the mapping screen.
 *
 * A POST rather than a GET, and it is not a REST quibble: this dials a
 * customer-hosted server, so it has a side effect at the far end — their logs,
 * their rate limits, their audit trail. A GET invites a prefetch, a retry on
 * navigation and a browser cache, none of which should reach somebody else's
 * system. `admin.manage` for the same reason the mapping route is: the response
 * enumerates a customer's legacy schema.
 *
 * Runs INLINE rather than through a job, unlike the pull. One handshake, one
 * manifest and one page is a few seconds, somebody is watching a spinner, and
 * nothing is stored — so there is no partial-write state for a timeout to leave
 * behind. The pull is a job precisely because the opposite is true of it.
 *
 * @module app/api/t/[tenantSlug]/admin/legacy-access/profile
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { API_KEY_CREATE_LIMIT } from '@/lib/security/rate-limit-middleware';
import { badRequest } from '@/lib/errors/types';
import { profileLegacyConnection } from '@/app-layer/usecases/legacy-access-profile';

const Body = z.object({ connectionId: z.string().min(1).max(64) });

export const POST = withApiErrorHandling(
    requirePermission('admin.manage', async (req: NextRequest, _routeArgs, ctx) => {
        const parsed = Body.safeParse(await req.json().catch(() => null));
        if (!parsed.success) throw badRequest('connectionId is required');

        const result = await profileLegacyConnection(ctx, parsed.data.connectionId);
        return NextResponse.json(result);
    }),
    {
        // Tight, because each call is a round trip into somebody else's estate.
        // An administrator mapping a table presses this a handful of times.
        rateLimit: { config: API_KEY_CREATE_LIMIT, scope: 'legacy-access-profile' },
    }
);
