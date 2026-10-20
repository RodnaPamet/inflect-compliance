/**
 * `/api/t/:slug/admin/a2a/host-consumers/:id/kill` — stop one host consumer
 * (#3861).
 *
 * `admin.agent_kill_switch`, NOT `admin.agent_registry`, for the reason the
 * agent kill route gives: the register key bundles admit with suspend, so
 * sharing it would mean a tenant cannot delegate the authority to STOP an
 * integration without also delegating the authority to ADMIT one. Opposite risk
 * profiles, separate keys.
 *
 * Lifting is PATCH and never DELETE. Lifting UPDATES the row, stamping who and
 * why; the row is the evidence that traffic was stopped between two timestamps,
 * and a control that erases its own history by being used is not auditable.
 * DELETE would also have to carry the lift reason in a query string, which is
 * where free text should never go because query strings reach access logs.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';

import {
    engageHostConsumerKill,
    liftHostConsumerKill,
    listHostConsumerKills,
} from '@/app-layer/usecases/a2a-host-consumer-kill';
import { withApiErrorHandling } from '@/lib/errors/api';
import { requirePermission } from '@/lib/security/permission-middleware';
import { jsonResponse } from '@/lib/api-response';

type Params = { tenantSlug: string; hostConsumerId: string };

const EngageBody = z.object({ reason: z.string().min(1).max(2000) });
const LiftBody = z.object({ liftReason: z.string().min(1).max(2000) });

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.agent_kill_switch', async (_req: NextRequest, p, ctx) => {
        const { hostConsumerId } = await p.params;
        return jsonResponse(await listHostConsumerKills(ctx, hostConsumerId));
    }),
);

export const POST = withApiErrorHandling(
    requirePermission<Params>('admin.agent_kill_switch', async (req: NextRequest, p, ctx) => {
        const { hostConsumerId } = await p.params;
        const body = EngageBody.parse(await req.json());
        const record = await engageHostConsumerKill(ctx, hostConsumerId, { reason: body.reason });
        // 200 when it was already stopped: an operator pressing stop twice
        // during an incident is told it is stopped, not given a conflict.
        return jsonResponse(record, { status: record.alreadyInForce ? 200 : 201 });
    }),
);

export const PATCH = withApiErrorHandling(
    requirePermission<Params>('admin.agent_kill_switch', async (req: NextRequest, p, ctx) => {
        const { hostConsumerId } = await p.params;
        const body = LiftBody.parse(await req.json());
        return jsonResponse(await liftHostConsumerKill(ctx, hostConsumerId, { liftReason: body.liftReason }));
    }),
);
