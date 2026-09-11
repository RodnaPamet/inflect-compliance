import { NextRequest } from 'next/server';

import { requirePermission } from '@/lib/security/permission-middleware';
import { previewAgentEnforcement } from '@/app-layer/usecases/tenant-security-settings';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';

/**
 * The PRE-FLIGHT for turning agent-registration enforcement on (#2443).
 *
 * `requireRegisteredAgent` is written through `PUT /admin/security-settings`
 * like every other field on the row. This route does not write anything — it
 * answers the question the operator must be able to ask BEFORE writing: *what
 * stops working if I do this?*
 *
 * It is a separate route rather than another field on the settings GET because
 * the answer is a LIST that costs a second query, and the settings page is read
 * on every visit while this is read only when somebody is about to make a
 * tenant-wide change.
 *
 * ── The gate is deliberately narrower than its neighbour ────────────
 *
 * `admin.manage` everywhere else on this row; `admin.manage` AND
 * `admin.agent_registry` here, enforced in the usecase. The setting decides
 * whether the agent register is load-bearing, so being able to flip it without
 * being able to read the register is not a coherent authority. The usecase
 * holds that check rather than this file, so the `PUT` path that writes the same
 * field cannot bypass it.
 */
export const GET = withApiErrorHandling(
    requirePermission('admin.manage', async (_req: NextRequest, _routeArgs, ctx) =>
        jsonResponse(await previewAgentEnforcement(ctx)),
    ),
);
