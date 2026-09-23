/**
 * The CUSTOMER's half of the two-key agentic-driver gate, and the only way to
 * write it.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `TenantSecuritySettings.agentDriver` has been readable since the driver seam
 * landed — `resolveDriverForTenant` selects it on every agentic run — and had
 * no writer anywhere in `src/`. A column with a reader and no writer is not a
 * switch; it is a constant that looks like a switch. Every tenant sat at the
 * `@default(STATIC)` the migration gave them, and the only way to move one was
 * an UPDATE against production by hand: no authorization, no audit row, and no
 * record afterwards of who decided it.
 *
 * That is the specific failure this subsystem keeps naming in its own comments
 * — settable-and-inert, or in this case gated-and-unsettable — so the write
 * path is a usecase with the same shape as `setIdentityWriteMode`, which is
 * the nearest thing in the repo: a customer-side half of a two-key gate over
 * authority that reaches the customer's own data.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 *
 * It does not enable anything. `resolveAgentDriver` ANDs three independent
 * terms and this is one of them; the operator's `AGENT_DRIVER_FLUE` and
 * `DRIVER_IMPLEMENTED.flue` are the other two, and either still refuses. Which
 * is exactly why `getAgentDriverSetting` returns the other two ALONGSIDE the
 * stored value rather than the stored value alone — a tenant reading FLUE
 * while the env switch is off is running on the static engine, and without the
 * other terms in the same response there is nothing to tell them so. The
 * identity write-policy route learned this the expensive way; its `honoured`
 * block exists for the same reason and is the model for `effective` here.
 */
import { logEvent } from '@/app-layer/events/audit';
import type { RequestContext } from '@/app-layer/types';
import {
    AGENT_DRIVER_MODES,
    DRIVER_IMPLEMENTED,
    coerceStoredDriverMode,
    flueEnvEnabled,
    resolveAgentDriver,
    type AgentDriverMode,
} from '@/lib/agentic/agent-driver';
import { runInTenantContext } from '@/lib/db-context';
import { env } from '@/env';
import { badRequest } from '@/lib/errors/types';
import { logger } from '@/lib/observability';

export interface AgentDriverSetting {
    /** What this tenant has ASKED for. Never null: an absent row reads STATIC. */
    mode: AgentDriverMode;
    /**
     * What a run would ACTUALLY execute on, right now, with all three terms
     * ANDed — and why, when that is not what `mode` says. Computed by
     * `resolveAgentDriver`, the same function the run path calls, rather than
     * re-derived: a second copy of the AND is how a settings page ends up
     * reporting a capability the runtime refuses.
     */
    effective: { driver: string; reason: string | null };
    /** The operator's process-wide switch — the other key. */
    envEnabled: boolean;
    /** Whether this build has a Flue implementation at all. */
    implemented: boolean;
}

/** Read the stored mode and, more importantly, what it will actually do. */
export async function getAgentDriverSetting(ctx: RequestContext): Promise<AgentDriverSetting> {
    const row = await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.findUnique({
            where: { tenantId: ctx.tenantId },
            select: { agentDriver: true },
        }),
    );

    // COERCED on read, exactly as `resolveDriverForTenant` does. An absent row,
    // a NULL and a value this build does not recognise all read STATIC, and
    // reading them any other way here would make this surface disagree with
    // the run path about the same stored byte.
    const mode = coerceStoredDriverMode(row?.agentDriver ?? null);
    const envEnabled = flueEnvEnabled(env.AGENT_DRIVER_FLUE);
    const decision = resolveAgentDriver({ envEnabled, tenantSetting: mode });

    return {
        mode,
        effective: { driver: decision.driver, reason: decision.reason ?? null },
        envEnabled,
        implemented: DRIVER_IMPLEMENTED.flue,
    };
}

/**
 * Set the tenant's half of the gate.
 *
 * NO LADDER, and that is a deliberate difference from `setIdentityWriteMode`.
 * The identity ladder exists because its rungs are progressively more
 * dangerous and the dwell is what buys observation time in between. This is
 * not a ladder: it is two values, both of which run the same register controls
 * in front of every tool call, and neither of which can act without the
 * operator's switch. A dwell here would gate nothing that the operator's own
 * key does not already gate.
 *
 * Both directions are always permitted, including a widen straight to FLUE and
 * an immediate narrow back. The narrow is the one that has to be instant: it
 * is the kill switch an operator reaches for while a run is misbehaving, and a
 * cooldown on the way DOWN is how a safety control becomes the incident.
 */
export async function setAgentDriverSetting(
    ctx: RequestContext,
    next: AgentDriverMode,
): Promise<AgentDriverSetting> {
    if (!AGENT_DRIVER_MODES.includes(next)) {
        throw badRequest(`Unknown agent driver mode: ${next}`);
    }

    const before = await getAgentDriverSetting(ctx);

    await runInTenantContext(ctx, (db) =>
        db.tenantSecuritySettings.upsert({
            where: { tenantId: ctx.tenantId },
            // UPSERT, because a tenant may have no settings row at all — which
            // is the common case for exactly the tenants nobody has configured
            // anything for, i.e. the ones a first enablement is aimed at. An
            // `update` alone would throw P2025 on them.
            create: { tenantId: ctx.tenantId, agentDriver: next },
            update: { agentDriver: next },
        }),
    );

    await runInTenantContext(ctx, (db) =>
        logEvent(db, ctx, {
            action: 'AGENT_DRIVER_MODE_CHANGED',
            entityType: 'Tenant',
            entityId: ctx.tenantId,
            details: `Agentic driver: ${before.mode} → ${next}`,
            // `access`, not `configuration`, for the same reason the identity
            // ladder is: this decides whether a third-party runtime drives a
            // model over the tenant's compliance data. An access-review reader
            // is the audience.
            detailsJson: {
                category: 'access',
                operation: next === 'FLUE' ? 'grant' : 'revoke',
                summary: `Agentic driver: ${before.mode} → ${next}`,
            },
            // The OTHER key's state at the moment of the decision. Without it
            // the trail cannot distinguish "switched to FLUE and ran on Flue"
            // from "switched to FLUE and kept running static because the
            // deployment switch was off" — two very different sets of runs.
            metadata: {
                from: before.mode,
                to: next,
                envEnabled: before.envEnabled,
                implemented: before.implemented,
            },
        }),
    );

    logger.info('agent driver mode changed', {
        component: 'agentic',
        tenantId: ctx.tenantId,
        from: before.mode,
        to: next,
        envEnabled: before.envEnabled,
    });

    return getAgentDriverSetting(ctx);
}
