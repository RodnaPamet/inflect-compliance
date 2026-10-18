/**
 * GET /api/t/{slug}/admin/integration-passport/{connectionId} — one external
 * agent connection's integration passport, built live (#3672).
 *
 * The passport `docs/integration-passport.md` specifies, assembled from the
 * same stored rows the weekly `integration-passport-sweep` reads, plus what the
 * last emission said, what the next sweep would raise against it (a preview —
 * nothing is written), and the connection's passport findings that are still
 * open. Read-only: the route has no other verb, and the rule that gates it
 * declares `GET` so a future write under this subtree fails the coverage guard
 * instead of inheriting a read gate.
 *
 * OWNER-only, via `admin.tenant_lifecycle` — a PLACEMENT, not a
 * confidentiality boundary. The view sits with the surfaces that change what
 * it reports: the external write rung (P8) and the prior-state pairings (P9)
 * are changed only under that key (`admin/external-write-policy`,
 * `admin/external-prior-state-read`), and the OWNER role holds every finding
 * on a connection with no owner. The passport itself is the week's Evidence,
 * which every evidence reader can open, so it holds nothing that relies on
 * this gate (P1 is an origin and a keyed digest, never the URL). The usecase
 * is ungated on purpose (the external-write-policy precedent): a second,
 * weaker check inside it is how a route comes to look protected while granting
 * more than it says.
 *
 * ── WHY THIS IS A SIBLING AND NOT UNDER admin/integrations/{id}/ ─────────────
 *
 * Route-permission matching is FIRST-MATCH-WINS, and
 * `^…/admin/integrations(/.*)?$` resolves to `admin.manage`. Nesting this under
 * that prefix would document a WEAKER gate than the handler enforces — the trap
 * `admin/external-write-policy` and `admin/identity-write-journal` each state in
 * their own notes. The owner setter, which IS `admin.manage`, lives under
 * `admin/integrations/{id}/owner` for the same reason in reverse.
 *
 * A connection that is not `mcp-server` has no passport and is a 404.
 */
import type { NextRequest } from 'next/server';

import { getIntegrationPassportView } from '@/app-layer/usecases/integration-passport';
import { jsonResponse } from '@/lib/api-response';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';

type Params = { tenantSlug: string; connectionId: string };

const getHandler = requirePermission<Params>(
    'admin.tenant_lifecycle',
    async (_req: NextRequest, { params }, ctx) => {
        const view = await getIntegrationPassportView(ctx, params.connectionId);
        return jsonResponse(view);
    },
);

// `withApiErrorHandling` OUTSIDE `requirePermission`, so a denial becomes the
// standard error response and its AUTHZ_DENIED audit row is written.
export const GET = withApiErrorHandling(getHandler);
