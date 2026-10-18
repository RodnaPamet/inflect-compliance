/**
 * `/api/t/:slug/admin/agents/intake` — the registration intake (#3669, step 2a).
 *
 * POST `{ findingId, ownerUserId, confirmOwner: true, name, autonomyLevel,
 * dataAccessScope, reversibility, provenance, … , attribution? }` — take a
 * SHADOW_AGENT harness finding into the register: one transaction creates a
 * PROVISIONAL AI-system entry at UNCLASSIFIED and a DRAFT register row linked to
 * it, owned by the person the caller CONFIRMS. An owner suggested by the
 * attribution skill (`attribution`) is recorded as provenance and never becomes
 * the owner by itself. Each refusal carries its reason in `error.details.reason`
 * (`lib/agentic/registration-intake.ts`). The agent cannot be activated until
 * its AI-system entry is classified.
 *
 * Gated by a literal `requirePermission('admin.agent_registry')` — the
 * register's own key, because this creates a register row (step 0e's
 * permission table) — so a denial writes the hash-chained `AUTHZ_DENIED` row a
 * usecase throw would not. The usecase re-asserts the key. Its
 * `ROUTE_PERMISSIONS` rule sits above the `admin/agents(/.*)?` catch-all, which
 * resolves to the same key.
 */
import { NextRequest } from 'next/server';

import { registerShadowAgent } from '@/app-layer/usecases/agent-registration-intake';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

export const POST = withApiErrorHandling(
    requirePermission<{ tenantSlug: string }>(
        'admin.agent_registry',
        async (req: NextRequest, _routeArgs, ctx) => {
            const registered = await registerShadowAgent(ctx, await req.json());
            return jsonResponse(registered, { status: 201 });
        },
    ),
);
