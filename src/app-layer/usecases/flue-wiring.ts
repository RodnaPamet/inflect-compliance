/**
 * WHAT IS STILL MISSING BEFORE A FLUE RUN CAN HAPPEN.
 *
 * ── THE PROBLEM THIS SURFACE EXISTS FOR ─────────────────────────────────────
 *
 * Six independent terms have to agree, none of them grants, and a deployment
 * with five of six satisfied behaves EXACTLY like one with none: every run
 * executes on the static engine, successfully, and nothing anywhere says the
 * configured engine is not the engine that ran. That is the failure this
 * subsystem keeps rediscovering — `agent-driver-setting.ts` calls it
 * settable-and-inert — and it arrived once more as the fourth term, which
 * had no name until a workflow definition asking for the engine turned out to
 * be a term at all.
 *
 * So the answer to "why is this not running on Flue" has to be a VALUE the
 * product computes, not a thing an operator reconstructs from four screens.
 *
 * ── THE TERMS ARE COMPUTED HERE, NOT IN THE CARD ────────────────────────────
 *
 * The card renders labels and links. Which term blocks is a decision about
 * authority, so it lives server-side where it can be tested without a DOM —
 * and, more to the point, where there is exactly ONE of it. A UI that derived
 * satisfaction from a flat payload would be a second implementation of the
 * conjunction, which is how a settings page comes to report a capability the
 * runtime refuses.
 *
 * ── AND EACH TERM IS READ FROM THE THING THAT ENFORCES IT ───────────────────
 *
 * `getAgentDriverSetting` for the first four (it already ANDs them through
 * `resolveAgentDriver` + `narrowToWhatAWorkflowAsksFor`, the same calls the
 * run path makes), `someWorkflowRequestsFlue` for the fourth's own value, and
 * two counts for the fifth and sixth. Nothing here re-derives a rule: a
 * detector that mirrors the runtime BY NAME is correct the day it is written
 * and stale the day the rule moves.
 */
import type { RequestContext } from '@/app-layer/types';
import { someWorkflowRequestsFlue } from '@/lib/agentic/agent-driver-policy';
import { runInTenantContext } from '@/lib/db-context';

import { getAgentDriverSetting } from './agent-driver-setting';

/**
 * The six terms, in the order an operator satisfies them.
 *
 * `BOUND_KEY` is last because it is the one that surprises people:
 * `startWorkflowRun` refuses a Flue run whose caller is not `vouched`, and
 * `evaluateAgentRegistration` resolves the agent from `ctx.agentId` — which a
 * browser session does not have. A Flue run therefore cannot be started from
 * the runs page by a human admin however the other five are set, and no
 * settings surface said so before this one.
 */
export const FLUE_WIRING_TERMS = [
    'ENV',
    'TENANT',
    'BUILD',
    'WORKFLOW',
    'REGISTERED_AGENT',
    'BOUND_KEY',
] as const;

export type FlueWiringTermKey = (typeof FLUE_WIRING_TERMS)[number];

export interface FlueWiringTerm {
    key: FlueWiringTermKey;
    satisfied: boolean;
    /**
     * Whose term it is. `operator` ones cannot be fixed from inside the
     * product at all, and saying so is the difference between a checklist and
     * a dead end — an admin clicking through a term only the deployment can
     * satisfy is the shape of a support ticket.
     */
    actor: 'operator' | 'tenant';
    /** How many of the thing there are, where the term is a count. */
    count?: number;
}

export interface FlueWiringState {
    /** What the tenant has asked for, and what a run would ACTUALLY get. */
    mode: string;
    effective: { driver: string; reason: string | null };
    terms: FlueWiringTerm[];
    /** Every term satisfied — the only state in which a Flue run can start. */
    ready: boolean;
    /** The first unsatisfied term, which is what the card leads with. */
    blockedOn: FlueWiringTermKey | null;
}

export async function getFlueWiringState(ctx: RequestContext): Promise<FlueWiringState> {
    const driver = await getAgentDriverSetting(ctx);

    // BOTH counts require the agent to be VOUCHED — ACTIVE and risk-assessed.
    // A key bound to a DRAFT agent satisfies nothing: `evaluateAgentRegistration`
    // maps every non-ACTIVE status to a standing that refuses, and an UNSCORED
    // tier is `DENY_CEILING` at every tool call. Counting bound keys without
    // the agent term would report the last box ticked while every run refused.
    const vouched = { status: 'ACTIVE' as const, riskTier: { not: null }, deletedAt: null };
    const now = new Date();

    const [agents, keys] = await runInTenantContext(ctx, (db) =>
        Promise.all([
            db.registeredAgent.count({ where: vouched }),
            db.tenantApiKey.count({
                where: {
                    revokedAt: null,
                    OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                    agent: { is: vouched },
                },
            }),
        ]),
    );

    const terms: FlueWiringTerm[] = [
        { key: 'ENV', satisfied: driver.envEnabled, actor: 'operator' },
        { key: 'TENANT', satisfied: driver.mode === 'FLUE', actor: 'tenant' },
        { key: 'BUILD', satisfied: driver.implemented, actor: 'operator' },
        { key: 'WORKFLOW', satisfied: someWorkflowRequestsFlue(), actor: 'operator' },
        { key: 'REGISTERED_AGENT', satisfied: agents > 0, actor: 'tenant', count: agents },
        { key: 'BOUND_KEY', satisfied: keys > 0, actor: 'tenant', count: keys },
    ];

    return {
        mode: driver.mode,
        effective: driver.effective,
        terms,
        ready: terms.every((t) => t.satisfied),
        blockedOn: terms.find((t) => !t.satisfied)?.key ?? null,
    };
}
