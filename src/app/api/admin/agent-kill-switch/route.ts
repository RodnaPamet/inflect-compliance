/**
 * `/api/admin/agent-kill-switch` — the PLATFORM-wide stop.
 *
 * ## Why this is not a `requirePermission` route
 *
 * Platform-wide has no tenant to scope a permission to. `requirePermission`
 * resolves a TENANT role from the caller's membership, so there is no key it
 * could check and no tenant that could hold it — and there should not be: the
 * authority to stop every agent in the deployment is not something a customer
 * holds over other customers.
 *
 * It is gated by `PLATFORM_ADMIN_API_KEY` through `verifyPlatformApiKey`, the
 * same credential that creates tenants and transfers their ownership, and it is
 * excluded individually from `api-permission-coverage.test.ts` with that reason
 * — the `src/app/api/admin` root is in scope precisely so this triage is forced.
 *
 * ## Where the audit trail is
 *
 * NOT in `AuditLog`: that table is tenant-scoped by construction, and fanning one
 * platform action into every tenant's hash chain would be a write amplification
 * with no reader. The durable record is the `PlatformAgentKillSwitch` row itself
 * — who, when, why, and when it was lifted, with a CHECK constraint making a
 * half-written lift unrepresentable — plus a structured log line at engage and
 * lift.
 *
 * Each tenant DOES see the consequence in its own trail: every refused tool call
 * writes an `AUTHZ_DENIED` row carrying `killScope: 'PLATFORM'`, so a tenant
 * asking "why did our agents stop" gets the answer from their own audit log
 * without being shown another tenant's operations.
 *
 * ## Idempotent both ways
 *
 * Engaging while one is in force returns the existing row; lifting when nothing
 * is in force returns 200 with `inForce: false`. An operator hammering a stop
 * button during an incident must get "yes, it is stopped" rather than a 500, and
 * one racing a colleague's lift must not be told the platform is still down.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { withApiErrorHandling } from '@/lib/errors/api';
import { verifyPlatformApiKey, PlatformAdminError } from '@/lib/auth/platform-admin';
import {
    engagePlatformKill,
    liftPlatformKill,
    readPlatformKill,
} from '@/lib/agentic/kill-switch';
import { logger } from '@/lib/observability/logger';

const EngageBody = z.object({
    reason: z.string().min(1).max(2000),
    /**
     * A reference the operator supplies — an incident id, a change ticket, a
     * pager handle. REQUIRED: the platform-admin key is not a person, so a row
     * without this is unattributable, and inventing a `User` id would be worse
     * than recording nothing.
     */
    engagedByRef: z.string().min(1).max(200),
});

const LiftBody = z.object({
    liftReason: z.string().min(1).max(2000),
    liftedByRef: z.string().min(1).max(200),
});

/** Verify the platform key, or return the error's OWN status (503 vs 401). */
function guard(req: NextRequest): NextResponse | null {
    try {
        verifyPlatformApiKey(req);
        return null;
    } catch (err) {
        if (err instanceof PlatformAdminError) {
            return NextResponse.json({ error: err.message }, { status: err.status });
        }
        throw err;
    }
}

export const GET = withApiErrorHandling(async (req: NextRequest) => {
    const denied = guard(req);
    if (denied) return denied;
    const kill = await readPlatformKill();
    return NextResponse.json({ inForce: kill !== null, kill });
});

export const POST = withApiErrorHandling(async (req: NextRequest) => {
    const denied = guard(req);
    if (denied) return denied;
    const body = EngageBody.parse(await req.json());
    const result = await engagePlatformKill(body);
    // Fields NAMED at the sink, never a spread. The operator's reason text is
    // deliberately absent from the log line — it is on the row, which is where
    // an incident review reads it from.
    logger.error('agentic: PLATFORM kill switch engaged — every agent is stopped', {
        killSwitchId: result.id,
        engagedByRef: body.engagedByRef,
        alreadyInForce: result.alreadyInForce,
    });
    return NextResponse.json(result, { status: result.alreadyInForce ? 200 : 201 });
});

export const PATCH = withApiErrorHandling(async (req: NextRequest) => {
    const denied = guard(req);
    if (denied) return denied;
    const body = LiftBody.parse(await req.json());
    const lifted = await liftPlatformKill(body);
    logger.warn('agentic: PLATFORM kill switch lifted — agents may run again', {
        killSwitchId: lifted?.id ?? null,
        liftedByRef: body.liftedByRef,
        wasInForce: lifted !== null,
    });
    return NextResponse.json({ inForce: false, lifted: lifted !== null, id: lifted?.id ?? null });
});
