/**
 * `/api/t/:slug/admin/agents/kill-switch` — stop this tenant's agents.
 *
 * Two scopes live here: ONE AGENT (`agentId` in the body) and THE WHOLE TENANT
 * (`agentId` omitted). The third scope — platform-wide — is not reachable from a
 * tenant URL at all, and that is the answer to "who may kill at each scope": a
 * `PermissionSet` key resolves a TENANT role, so no key a tenant administrator
 * can hold is able to express "stop every deployment". That one is at
 * `/api/admin/agent-kill-switch`, behind `PLATFORM_ADMIN_API_KEY`.
 *
 * The gate is at the ROUTE, not one layer deeper: a `requirePermission` denial
 * writes a hash-chained `AUTHZ_DENIED` row and a usecase throw records nothing —
 * the whole of Epic D.3. Its rule must sit ABOVE the generic
 * `admin/agents(/.*)?` entry in `ROUTE_PERMISSIONS`, which matches first-wins.
 *
 * `admin.agent_kill_switch` and not `admin.agent_registry`, even though the
 * register already carries "suspend". `agent_registry` BUNDLES suspend with
 * activate, so a tenant cannot delegate the authority to STOP without also
 * delegating the authority to ADMIT an agent nobody has scored — and those have
 * opposite risk profiles. See the key's own docstring in `permissions.ts`.
 *
 * ## Why lifting is PATCH and not DELETE
 *
 * Lifting UPDATES the row; it never deletes it. The row is the evidence that
 * agents were stopped between two timestamps, and a control that erases its own
 * history by being used is not auditable. DELETE would also have to carry the
 * lift REASON, and the only place a DELETE can put one is the query string —
 * which is exactly where free text should not go, because query strings reach
 * access logs. PATCH carries a body everywhere.
 *
 * The EMERGENCY direction is POST, and it needs nothing but a reason.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';

import {
    engageKillSwitch,
    liftKillSwitch,
    listKillSwitches,
} from '@/app-layer/usecases/agent-kill-switch';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string };

const EngageBody = z.object({
    /**
     * Omit for a TENANT-wide kill. The scope is DERIVED from presence — the
     * request body has no `scope` field for the same reason the table has no
     * `scope` column: two encodings of one fact can disagree.
     */
    agentId: z.string().min(1).max(64).nullish(),
    reason: z.string().min(1).max(2000),
});

const LiftBody = z.object({
    switchId: z.string().min(1).max(64),
    liftReason: z.string().min(1).max(2000),
});

export const GET = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_kill_switch',
        async (req: NextRequest, _ctxParams, ctx) => {
            const inForceOnly = req.nextUrl.searchParams.get('inForceOnly') === 'true';
            return jsonResponse(await listKillSwitches(ctx, { inForceOnly }));
        },
    ),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_kill_switch',
        async (req: NextRequest, _ctxParams, ctx) => {
            const body = EngageBody.parse(await req.json());
            const record = await engageKillSwitch(ctx, {
                agentId: body.agentId ?? null,
                reason: body.reason,
            });
            return jsonResponse(record, { status: 201 });
        },
    ),
);

export const PATCH = withApiErrorHandling(
    requirePermission<Params>(
        'admin.agent_kill_switch',
        async (req: NextRequest, _ctxParams, ctx) => {
            const body = LiftBody.parse(await req.json());
            return jsonResponse(
                await liftKillSwitch(ctx, body.switchId, { liftReason: body.liftReason }),
            );
        },
    ),
);
