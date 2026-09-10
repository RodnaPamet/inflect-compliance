/**
 * Reading an agent's behavioural circuit breaker, and closing it.
 *
 * The breaker itself is written at the MCP tool boundary — see
 * `src/lib/agentic/circuit-breaker-store.ts`. This file is the HUMAN side: the
 * operator surface's read, and the one action that can un-trip an agent.
 *
 * ## Nothing here trips a breaker, and nothing anywhere closes one on its own
 *
 * There is no half-open probe and no timeout. Both are auto-recovery, and an
 * agent that has gone rogue can wait one out — an automatic close would turn the
 * control into a delay. The close is a named human, through
 * `requirePermission('admin.agent_registry')`, and it is audited: the whole value
 * of a manual un-trip is that somebody's name is against it, which is why the
 * database CHECK refuses a closed row that does not carry an actor and a reason.
 *
 * ## The reason is load-bearing, not a comment field
 *
 * `ACCEPTED_NEW_BASELINE` and `RESOLVED` do different things, and collapsing
 * them is how a breaker becomes a rubber stamp:
 *
 *   ACCEPTED_NEW_BASELINE — "yes, I changed this agent." The old history is
 *       DISCARDED (the epoch advances) and the agent re-learns from zero,
 *       reporting `NO_BASELINE` until it has twelve active windows again. This
 *       is the false-positive escape hatch, and it is the reason an operator who
 *       deliberately widened an agent has something to do other than switch the
 *       control off.
 *   RESOLVED — "I fixed the agent." The old baseline is KEPT, because it is what
 *       the agent should return to. Re-baselining here would silently adopt the
 *       rogue behaviour as normal, which is the failure the whole design is
 *       arranged against.
 *
 * Which is why `recordAgentBreakerClose` labels the counter by reason: a
 * deployment where every trip is answered with "that's fine now" has a detector
 * calibrated to fire on ordinary work, and that is the shape this control dies
 * of. It is measured rather than assumed.
 */
import { runInTenantContext } from '@/lib/db-context';
import { badRequest, notFound } from '@/lib/errors/types';
import {
    BASELINE_WINDOW_LIMIT,
    BREAKER_CLOSE_REASONS,
    MIN_BASELINE_OBSERVATIONS,
    MIN_BASELINE_WINDOWS,
    WINDOWS_TO_TRIP,
    windowKeyFor,
    windowStartFor,
    type BreakerCloseReason,
} from '@/lib/agentic/circuit-breaker';
import { recordAgentBreakerClose } from '@/lib/observability/integration-metrics';

import { assertCanAdmin, assertCanRead } from '../policies/common';
import { logEvent } from '../events/audit';
import type { RequestContext } from '../types';

/** How many recent windows the operator surface shows. */
const WINDOW_PAGE = 48;

/**
 * The breaker's state, its recent history, and the constants it judges by.
 *
 * The thresholds are returned rather than duplicated in the client, for the
 * reason `write-ladder.ts` exists: a number copied into whatever renders it
 * agrees with the detector only by coincidence, and the identity subsystem has
 * already paid for that once with a rung a route went on offering after the
 * ladder dropped it.
 */
export async function getAgentCircuitBreaker(ctx: RequestContext, agentId: string) {
    assertCanRead(ctx);
    return runInTenantContext(ctx, async (db) => {
        const agent = await db.registeredAgent.findFirst({
            where: { id: agentId, tenantId: ctx.tenantId, deletedAt: null },
            select: { id: true, name: true, riskTier: true },
        });
        if (!agent) throw notFound('Agent not found');

        const breaker = await db.agentCircuitBreaker.findUnique({
            where: { tenantId_agentId: { tenantId: ctx.tenantId, agentId } },
            select: {
                state: true,
                lastVerdict: true,
                lastVerdictAt: true,
                lastEvaluatedWindow: true,
                anomalousStreak: true,
                streakSignals: true,
                trippedAt: true,
                trippedWindow: true,
                trippedSignals: true,
                baselineEpoch: true,
                closedAt: true,
                closedByUserId: true,
                closeReason: true,
            },
        });

        // One clock read, shared by the look-back bound and the
        // already-judged test below. Reading `new Date()` twice could straddle
        // an hour boundary and produce a payload whose figures and whose row
        // labels disagree about which hour is which.
        const now = new Date();
        // The window still filling is EXCLUDED from the baseline figures below,
        // for the reason `evaluateWindow` excludes it: a partial hour is not a
        // sample, and counting one would let this panel report "12 of 12
        // windows" — an operator's cue that the agent is being judged — an hour
        // before the detector agrees. It stays IN the ledger page, which is the
        // agent's activity as it happened; `currentWindowStart` travels with it
        // so the client can say which row that is rather than re-deriving the
        // hour boundary from a clock this server has already read.
        const currentWindowStart = windowStartFor(now);

        const [windows, lookback] = await Promise.all([
            db.agentBehaviourWindow.findMany({
                where: { tenantId: ctx.tenantId, agentId },
                orderBy: { windowStart: 'desc' },
                take: WINDOW_PAGE,
                select: {
                    windowStart: true,
                    readCalls: true,
                    proposeCalls: true,
                    orchestrateCalls: true,
                    toolNames: true,
                    anomalous: true,
                    verdict: true,
                },
            }),
            // The baseline figures are read over the DETECTOR'S OWN LOOK-BACK,
            // not over the page above. Filtering the page was the defect this
            // query replaces: `WINDOW_PAGE` is how many rows the ledger table
            // shows, so the reported baseline saturated at 48 and never moved
            // again while the payload advertised a 168-window look-back beside
            // it — a surface stating a lookback it had not performed.
            //
            // Same predicate and the same bound as `evaluateWindow`'s baseline
            // read (circuit-breaker-store.ts): windows since the epoch, newest
            // first, `BASELINE_WINDOW_LIMIT + 1` rows. The `+ 1` is not slack —
            // it is the row the detector JUDGES, which is never part of the
            // baseline it is judged against (`rows.slice(1)` there). Taking 168
            // and counting all of them would count a 168-row window shifted one
            // row off the detector's, and at exactly `MIN_BASELINE_WINDOWS`
            // that one row is the difference between this panel saying the
            // detector has a baseline and the detector answering NO_BASELINE.
            //
            // Rows rather than `count` + `aggregate`, and deliberately: the cap
            // is a ROW cap on the newest windows, not a predicate. A
            // `count({ where: { anomalous: false }, take: BASELINE_WINDOW_LIMIT })`
            // counts up to 168 ACCEPTED rows, so on any agent with an anomalous
            // window in range it reaches further back than the detector ever
            // reads and reports history the verdict was not judged against —
            // the same class of error as the page filter, pointing the other
            // way. The detector takes the newest rows and drops the anomalous
            // ones AFTERWARDS, so this does too. Bounded at 168 four-column
            // rows, which is why reading them is affordable.
            db.agentBehaviourWindow.findMany({
                where: {
                    tenantId: ctx.tenantId,
                    agentId,
                    // A `gte: undefined` would read as "no lower bound" through
                    // Prisma's undefined-stripping, which is right here but only
                    // by accident; spelled out, because an epoch that silently
                    // stopped applying would re-admit history a re-baseline
                    // discarded.
                    windowStart:
                        breaker === null
                            ? { lt: currentWindowStart }
                            : { gte: breaker.baselineEpoch, lt: currentWindowStart },
                },
                orderBy: { windowStart: 'desc' },
                take: BASELINE_WINDOW_LIMIT + 1,
                select: {
                    windowStart: true,
                    readCalls: true,
                    proposeCalls: true,
                    orchestrateCalls: true,
                    anomalous: true,
                },
            }),
        ]);

        // One bounded query per READ, not per agent: this usecase serves a
        // single agent's detail panel and has no `map` over agents. If these
        // figures are ever wanted for a LIST, this must become one aggregate
        // for every agent in the shared `Promise.all` — the shape
        // `loadToolGrantCounts` in `agent-coverage.ts` exists to hold — because
        // a per-agent read inside that loop is the N+1 that surface is built to
        // avoid.

        // Has this hour's judgement already happened? `evaluateWindow` runs at
        // most once per window and refuses on exactly this test
        // (`latch.lastEvaluatedWindow === currentKey`), so it is the test that
        // says which row is the SUBJECT of the next verdict:
        //
        //   • not yet judged this hour — the next evaluation lands in this hour,
        //     judges `lookback[0]` and reads `lookback[1..]` as its baseline;
        //   • already judged this hour — nothing more happens until the hour
        //     turns, and by then `lookback[0]` has joined the baseline (the row
        //     `observeToolCall` wrote for the hour still filling becomes the
        //     newest complete one, and is what gets judged instead).
        //
        // Both readings are the detector's baseline AS IT STANDS, which is the
        // question this panel answers. Excluding `lookback[0]` unconditionally
        // would understate an actively-judged agent by one window and, worse,
        // print "awaiting its verdict" on a ledger row already showing the
        // verdict it got.
        const judgementPending =
            breaker === null || breaker.lastEvaluatedWindow !== windowKeyFor(now);
        // Which ledger row that is, for the client's label. `null` once the
        // hour's verdict has landed — there is then no row awaiting one.
        const pendingVerdictWindowStart = judgementPending
            ? (lookback[0]?.windowStart ?? null)
            : null;
        // Counted over the ACCEPTED history only — the same population the
        // detector judges against — so the surface's "12 of 12 windows" agrees
        // with the verdict rather than with a bigger, friendlier number. The
        // anomalous drop happens AFTER the row slice, in that order, because
        // that is the order `evaluateWindow` + `evaluateCircuitBreaker` apply
        // them: the cap is a row cap, and filtering first would reach further
        // back than the detector ever reads.
        const accepted = (
            judgementPending ? lookback.slice(1) : lookback.slice(0, BASELINE_WINDOW_LIMIT)
        ).filter((w) => !w.anomalous);

        return {
            agentId: agent.id,
            agentName: agent.name,
            riskTier: agent.riskTier,
            // `null` is NOT "closed". It is "this agent has never been observed",
            // which is a third state an operator has to be able to see: a page
            // showing CLOSED for an agent nothing has ever watched is the
            // reassurance-shaped failure this whole subsystem is arranged
            // against.
            breaker,
            windows,
            /** Which ledger row is the hour still filling. See above. */
            currentWindowStart,
            /**
             * Which ledger row is awaiting a verdict, and so is NOT in the
             * figures below. `null` when this hour's verdict has already landed.
             */
            pendingVerdictWindowStart,
            baseline: {
                windows: accepted.length,
                observations: accepted.reduce(
                    (t, w) => t + w.readCalls + w.proposeCalls + w.orchestrateCalls,
                    0,
                ),
                requiredWindows: MIN_BASELINE_WINDOWS,
                requiredObservations: MIN_BASELINE_OBSERVATIONS,
                lookbackWindows: BASELINE_WINDOW_LIMIT,
            },
            windowsToTrip: WINDOWS_TO_TRIP,
            closeReasons: [...BREAKER_CLOSE_REASONS],
        };
    });
}

/**
 * Close a tripped breaker. The only thing that un-trips an agent.
 *
 * `assertCanAdmin` in addition to the route's `requirePermission`, and the
 * duplication is deliberate: the route gate is what writes the hash-chained
 * `AUTHZ_DENIED` row on refusal, and the usecase gate is what stops a future
 * caller reaching this function from somewhere that has no route in front of it.
 */
export async function closeAgentCircuitBreaker(
    ctx: RequestContext,
    agentId: string,
    reason: BreakerCloseReason,
) {
    assertCanAdmin(ctx);
    return runInTenantContext(ctx, async (db) => {
        const breaker = await db.agentCircuitBreaker.findUnique({
            where: { tenantId_agentId: { tenantId: ctx.tenantId, agentId } },
            select: { state: true, trippedSignals: true, trippedWindow: true },
        });
        if (!breaker) throw notFound('This agent has no circuit breaker');
        if (breaker.state !== 'OPEN') {
            // Not a no-op returning success. "It was already closed" and "you
            // closed it" are different facts, and an idempotent-looking success
            // here would put a name and a reason into the audit trail against a
            // decision nobody made.
            throw badRequest('This agent’s circuit breaker is not open');
        }

        const now = new Date();
        const reBaseline = reason === 'ACCEPTED_NEW_BASELINE';

        await db.agentCircuitBreaker.update({
            where: { tenantId_agentId: { tenantId: ctx.tenantId, agentId } },
            data: {
                state: 'CLOSED',
                closedAt: now,
                closedByUserId: ctx.userId,
                closeReason: reason,
                // The streak is cleared either way: whatever the operator
                // decided, the agent does not resume two-thirds of the way to
                // its next trip.
                anomalousStreak: 0,
                streakSignals: [],
                // Advanced ONLY on an accepted change. On RESOLVED the old
                // baseline is the thing the agent should be measured against.
                ...(reBaseline ? { baselineEpoch: now, lastEvaluatedWindow: null } : {}),
            },
        });

        // Named field by field rather than spread. A spread puts whatever the
        // row happens to carry into permanent, hash-chained evidence — and the
        // signal codes are the only part of a trip that is safe to write there.
        await logEvent(db, ctx, {
            action: 'AGENT_CIRCUIT_BREAKER_CLOSED',
            entityType: 'RegisteredAgent',
            entityId: agentId,
            detailsJson: {
                category: 'access',
                entityName: 'AgentCircuitBreaker',
                operation: 'close',
                // The agent id is `entityId` on this row already; repeating it
                // into prose buys nothing and costs one more value the
                // `no-raw-prompt-logging` rule cannot resolve.
                summary:
                    `Closed the behavioural circuit breaker as ${reason}` +
                    (reBaseline
                        ? '; the prior baseline was discarded and the agent re-learns'
                        : '; the prior baseline was kept'),
                closeReason: reason,
                rebaselined: reBaseline,
                trippedWindow: breaker.trippedWindow,
                trippedSignals: breaker.trippedSignals,
            },
        });

        recordAgentBreakerClose({
            agentId,
            reason: reBaseline ? 'accepted_new_baseline' : 'resolved',
        });

        return { agentId, state: 'CLOSED' as const, closeReason: reason, rebaselined: reBaseline };
    });
}
