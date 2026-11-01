/**
 * `/api/t/:slug/admin/agents/owner-orphan-pass` — the owner-orphan pass's mode
 * and its recorded passes (#3670, step 2b).
 *
 * GET  the mode, the dwell state, the next rung and why it may be refused, the
 *      pass's ceiling, and the most recent passes (each row's per-orphan
 *      decision list verbatim — the record an operator compares, during the
 *      seven-day dry run, against who actually left).
 * PUT  `{ mode }` — move one rung. Narrowing is always allowed; widening is one
 *      rung at a time, and leaving DRY_RUN needs seven days and one recorded
 *      pass in the window.
 *
 * `admin.tenant_lifecycle`, the key `/admin/identity-write-policy` carries for
 * the identity ladder: the mode decides whether a scheduled job stops agents
 * unattended (the permission table of `docs/agentic-iam-roadmap.md`). ADMIN does
 * not hold it; no API key carries it. The rule sits ABOVE the register's
 * `admin/agents(/.*)?` catch-all in `ROUTE_PERMISSIONS`, which matches
 * first-wins and would otherwise record `admin.agent_registry`.
 *
 * API-only: no page calls it yet, as the ownership-transfer routes beside it.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';

import { requirePermission } from '@/lib/security/permission-middleware';
import { withApiErrorHandling } from '@/lib/errors/api';
import { jsonResponse } from '@/lib/api-response';
import { LADDER } from '@/lib/identity/write-ladder';
import { ORPHAN_PASS_MAX_MODE } from '@/lib/agentic/owner-orphan';
import {
    describeOrphanPassModeRefusal,
    getAgentOrphanPassPolicy,
    orphanPassModeRefusal,
    setAgentOrphanPassMode,
} from '@/app-layer/usecases/agent-owner-orphan-policy';
import { listOrphanPasses, orphanPassAgentNames } from '@/app-layer/usecases/agent-owner-orphan-pass';
import { DRY_RUN_MIN_DAYS } from '@/app-layer/usecases/identity-write-policy';

type Params = { tenantSlug: string };

/** `LADDER`, so a retired rung (PROPOSE) is a 400 naming the three that exist. */
const Body = z.object({ mode: z.enum(LADDER) });

export const GET = withApiErrorHandling(
    requirePermission<Params>('admin.tenant_lifecycle', async (_req: NextRequest, _params, ctx) => {
        const policy = await getAgentOrphanPassPolicy(ctx);
        const next = LADDER[Math.min(LADDER.indexOf(policy.mode) + 1, LADDER.length - 1)];
        const passes = await listOrphanPasses(ctx);
        const agentNames = await orphanPassAgentNames(ctx, passes);
        const now = new Date();
        return jsonResponse({
            mode: policy.mode,
            dryRunSince: policy.dryRunSince,
            nextMode: next === policy.mode ? null : next,
            blockedReason:
                next === policy.mode
                    ? null
                    : describeOrphanPassModeRefusal(policy, next, now),
            // The same answer as a code and its arguments, which the page words
            // (#4903). `blockedReason` stays for API callers.
            blockedRefusal: next === policy.mode ? null : orphanPassModeRefusal(policy, next, now),
            dryRunMinDays: DRY_RUN_MIN_DAYS,
            maxMode: ORPHAN_PASS_MAX_MODE,
            passes,
            agentNames,
        });
    }),
);

export const PUT = withApiErrorHandling(
    requirePermission<Params>('admin.tenant_lifecycle', async (req: NextRequest, _params, ctx) => {
        const { mode } = Body.parse(await req.json());
        return jsonResponse(await setAgentOrphanPassMode(ctx, { mode }));
    }),
);
