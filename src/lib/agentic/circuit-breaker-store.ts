/**
 * The circuit breaker's reads and writes — the only place it touches Prisma.
 *
 * `circuit-breaker.ts` is a pure function of its argument and knows nothing
 * about a database; this file assembles that argument and applies the verdict.
 * The split is what makes a trip reproducible: everything the judgement saw is
 * either a row you can still read or a constant you can still look up.
 *
 * ## Why this file talks to Prisma directly
 *
 * The same seam as `policy-card-store.ts` and `agent-tool-exposure.ts`. This
 * runs inside the MCP tool boundary, not inside a usecase, and it has no
 * `RequestContext` to open a tenant transaction with — the boundary is
 * authorizing the request that would have built one. The base client runs as a
 * non-`app_user` session, so `superuser_bypass` applies and the `tenantId`
 * predicate in every statement below is the isolation. It is not defence in
 * depth here; it is the only layer, which is why every function takes
 * `tenantId` as its first argument rather than reaching for it.
 *
 * ## When judgement happens: LAZILY, on the agent's own next call
 *
 * There is no scheduled scan. `AgentCircuitBreaker.lastEvaluatedWindow` records
 * the window the last evaluation judged; the boundary evaluates when the agent's
 * current window is not that one. So judgement costs one evaluation per ACTIVE
 * window per agent, is driven by the agent's own traffic, and needs no job, no
 * cron entry and no worker to be alive.
 *
 * The consequence, stated plainly because it is the thing to know: an agent that
 * STOPS calling is never re-judged. That is correct — a silent agent needs no
 * breaker — but it means the ledger is not a heartbeat and an empty page here
 * says nothing about whether the subsystem is working.
 *
 * ## Only AUTHORIZED calls are recorded, and that is a security property
 *
 * `observeToolCall` is called at the END of `authorizeToolCall`, after every
 * gate has passed. Recording refused calls would blend two populations — and
 * worse, it would let a caller STEER ITS OWN BASELINE with calls that never
 * execute: spray reads that get refused, raise the read baseline, and dilute the
 * distribution distance of a later propose burst. Refusals are not lost; they
 * have their own signal in `AUTHZ_DENIED` rows and the policy-card refusal
 * counter.
 */
import prisma from '@/lib/prisma';
import type { PrismaTx } from '@/lib/db-context';
import { logger } from '@/lib/observability/logger';
import {
    createAgenticNotification,
    resolveAgenticRecipients,
} from '@/app-layer/notifications/agentic';

import type { McpCapabilityClass } from './autonomy-ceiling';
import {
    BASELINE_WINDOW_LIMIT,
    evaluateCircuitBreaker,
    GUARD_BLOCK_TRIP,
    shouldLatchOnGuardBlocks,
    windowKeyFor,
    windowStartFor,
    type BreakerObservation,
    type BreakerSignal,
    type BreakerVerdict,
    type RejectionCounts,
} from './circuit-breaker';

/** The rejection signal's recent period: one day of human review. */
const REJECTION_RECENT_MS = 24 * 60 * 60 * 1000;
/** The period before it that the recent one is compared against: seven days. */
const REJECTION_BASELINE_MS = 7 * REJECTION_RECENT_MS;

/** The latch, as the boundary needs to read it. */
export interface BreakerLatch {
    readonly state: string;
    readonly lastEvaluatedWindow: string | null;
    readonly anomalousStreak: number;
    readonly streakSignals: readonly string[];
    readonly baselineEpoch: Date;
    readonly trippedAt: Date | null;
    readonly trippedSignals: readonly string[];
}

/**
 * Read the latch for one agent, or `null` when the agent has never been
 * observed.
 *
 * `null` is NOT a refusal, for the same reason an absent policy card is not: the
 * breaker is a control that LEARNS, and an agent it has never seen must be able
 * to act. Deny-by-default lives in the tool grants, which are already
 * deny-by-default.
 */
export async function readBreakerLatch(
    tenantId: string,
    agentId: string,
): Promise<BreakerLatch | null> {
    const row = await prisma.agentCircuitBreaker.findUnique({
        where: { tenantId_agentId: { tenantId, agentId } },
        select: {
            state: true,
            lastEvaluatedWindow: true,
            anomalousStreak: true,
            streakSignals: true,
            baselineEpoch: true,
            trippedAt: true,
            trippedSignals: true,
        },
    });
    return row;
}

/**
 * Record ONE authorized tool call against the agent's current hour.
 *
 * One statement. The counter increment and the tool-name append happen inside
 * the same `INSERT … ON CONFLICT DO UPDATE`, so two concurrent calls cannot both
 * read the same array and both write it back — the read-modify-write that a
 * per-call path turns into a lost update per concurrent call.
 *
 * The three class columns are three separate statements rather than one with an
 * interpolated column name: a table or column identifier cannot be a bound
 * parameter, and building it by string concatenation on a path an external
 * principal drives is the shape that becomes an injection the week somebody
 * widens the capability vocabulary.
 */
export async function observeToolCall(
    tenantId: string,
    agentId: string,
    capabilityClass: McpCapabilityClass,
    toolName: string,
    now: Date,
): Promise<void> {
    const start = windowStartFor(now);
    try {
        if (capabilityClass === 'read') {
            await prisma.$executeRaw`
                INSERT INTO "AgentBehaviourWindow"
                    ("id", "tenantId", "agentId", "windowStart", "readCalls", "toolNames", "updatedAt")
                VALUES (gen_random_uuid()::text, ${tenantId}, ${agentId}, ${start}, 1, ARRAY[${toolName}]::text[], NOW())
                ON CONFLICT ("tenantId", "agentId", "windowStart") DO UPDATE
                   SET "readCalls" = "AgentBehaviourWindow"."readCalls" + 1,
                       "toolNames" = CASE
                           WHEN ${toolName} = ANY("AgentBehaviourWindow"."toolNames")
                               THEN "AgentBehaviourWindow"."toolNames"
                           ELSE array_append("AgentBehaviourWindow"."toolNames", ${toolName})
                       END,
                       "updatedAt" = NOW()`;
        } else if (capabilityClass === 'propose') {
            await prisma.$executeRaw`
                INSERT INTO "AgentBehaviourWindow"
                    ("id", "tenantId", "agentId", "windowStart", "proposeCalls", "toolNames", "updatedAt")
                VALUES (gen_random_uuid()::text, ${tenantId}, ${agentId}, ${start}, 1, ARRAY[${toolName}]::text[], NOW())
                ON CONFLICT ("tenantId", "agentId", "windowStart") DO UPDATE
                   SET "proposeCalls" = "AgentBehaviourWindow"."proposeCalls" + 1,
                       "toolNames" = CASE
                           WHEN ${toolName} = ANY("AgentBehaviourWindow"."toolNames")
                               THEN "AgentBehaviourWindow"."toolNames"
                           ELSE array_append("AgentBehaviourWindow"."toolNames", ${toolName})
                       END,
                       "updatedAt" = NOW()`;
        } else {
            await prisma.$executeRaw`
                INSERT INTO "AgentBehaviourWindow"
                    ("id", "tenantId", "agentId", "windowStart", "orchestrateCalls", "toolNames", "updatedAt")
                VALUES (gen_random_uuid()::text, ${tenantId}, ${agentId}, ${start}, 1, ARRAY[${toolName}]::text[], NOW())
                ON CONFLICT ("tenantId", "agentId", "windowStart") DO UPDATE
                   SET "orchestrateCalls" = "AgentBehaviourWindow"."orchestrateCalls" + 1,
                       "toolNames" = CASE
                           WHEN ${toolName} = ANY("AgentBehaviourWindow"."toolNames")
                               THEN "AgentBehaviourWindow"."toolNames"
                           ELSE array_append("AgentBehaviourWindow"."toolNames", ${toolName})
                       END,
                       "updatedAt" = NOW()`;
        }
    } catch (err) {
        // FAIL-SAFE, and deliberately so. This runs after the call has been
        // authorized; a ledger write that throws here would turn an
        // observability failure into an outage for a call every gate has already
        // allowed. The cost of the miss is one hour of one agent's history being
        // slightly light, which the median it feeds barely notices.
        // The capability class is deliberately NOT a field here: it is derivable
        // from the tool name and every field at a sink that the
        // `no-raw-prompt-logging` rule cannot resolve is a position counted
        // against the agentic path's opacity budget. A field that adds nothing
        // is not free.
        logger.warn('agent circuit breaker: failed to record an observation', {
            tenantId,
            agentId,
            tool: toolName,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/** Create the latch row if this agent has never been observed. */
async function ensureLatchRow(tenantId: string, agentId: string): Promise<void> {
    await prisma.$executeRaw`
        INSERT INTO "AgentCircuitBreaker" ("id", "tenantId", "agentId", "updatedAt")
        VALUES (gen_random_uuid()::text, ${tenantId}, ${agentId}, NOW())
        ON CONFLICT ("tenantId", "agentId") DO NOTHING`;
}

/**
 * How many of this agent's proposals humans reviewed, and how many they
 * rejected, in each of the two periods.
 *
 * Attributed by REVIEW time, never by proposal time. "The queue is suddenly
 * rejecting this agent's work" is an event that happens when a human clicks
 * reject; attributing it to the hour the proposal was written would make the
 * signal lag by however long the queue is, which on a quiet tenant is unbounded.
 *
 * `QUARANTINED` is neither reviewed nor rejected here. It is the OUTPUT GUARD's
 * verdict, not a human's, and counting it would let one signal appear twice —
 * the guard already refuses those proposals and records its own evidence.
 */
async function loadRejectionCounts(
    tenantId: string,
    agentId: string,
    now: Date,
    epoch: Date,
): Promise<RejectionCounts> {
    const recentFrom = new Date(Math.max(now.getTime() - REJECTION_RECENT_MS, epoch.getTime()));
    const baselineFrom = new Date(
        Math.max(recentFrom.getTime() - REJECTION_BASELINE_MS, epoch.getTime()),
    );

    // The status list is spelled INLINE at each site rather than hoisted into a
    // const: hoisted, its type widens to `string[]` and stops being assignable to
    // the enum filter, and the fix for that is an `as const` whose `readonly`
    // Prisma then refuses. Contextual typing at the call site costs nothing.
    const [recentReviewed, recentRejected, baselineReviewed, baselineRejected] = await Promise.all([
        prisma.agentProposal.count({
            where: {
                tenantId,
                agentId,
                status: { in: ['ACCEPTED', 'REJECTED', 'EDITED'] },
                reviewedAt: { gte: recentFrom },
            },
        }),
        prisma.agentProposal.count({
            where: {
                tenantId,
                agentId,
                status: 'REJECTED',
                reviewedAt: { gte: recentFrom },
            },
        }),
        prisma.agentProposal.count({
            where: {
                tenantId,
                agentId,
                status: { in: ['ACCEPTED', 'REJECTED', 'EDITED'] },
                reviewedAt: { gte: baselineFrom, lt: recentFrom },
            },
        }),
        prisma.agentProposal.count({
            where: {
                tenantId,
                agentId,
                status: 'REJECTED',
                reviewedAt: { gte: baselineFrom, lt: recentFrom },
            },
        }),
    ]);

    return { recentReviewed, recentRejected, baselineReviewed, baselineRejected };
}

function toObservation(row: {
    windowStart: Date;
    readCalls: number;
    proposeCalls: number;
    orchestrateCalls: number;
    toolNames: string[];
    anomalous: boolean;
}): BreakerObservation {
    return {
        windowKey: windowKeyFor(row.windowStart),
        readCalls: row.readCalls,
        proposeCalls: row.proposeCalls,
        orchestrateCalls: row.orchestrateCalls,
        toolNames: row.toolNames,
        anomalous: row.anomalous,
    };
}

/** What `evaluateWindow` decided, for the caller that has to act on it. */
export interface EvaluationOutcome {
    readonly evaluated: boolean;
    readonly verdict: BreakerVerdict | null;
}

/**
 * Judge the window that just closed, and apply the verdict to the latch.
 *
 * Returns `evaluated: false` when the current window is the one already judged —
 * the ordinary case, and the reason this costs one evaluation per active window
 * rather than one per call.
 */
export async function evaluateWindow(
    tenantId: string,
    agentId: string,
    now: Date,
    latch: BreakerLatch,
): Promise<EvaluationOutcome> {
    const currentKey = windowKeyFor(now);
    if (latch.lastEvaluatedWindow === currentKey) return { evaluated: false, verdict: null };

    // The window still filling is EXCLUDED. Judging a partial hour against whole
    // ones reads as a slowdown at :05 and a spike at :55 for every agent alive.
    //
    // What is judged is the newest COMPLETE window the agent was ACTIVE in — not
    // the hour immediately before this one. The two differ for every agent that
    // does not act hourly, and picking the fixed hour would have meant a nightly
    // agent's previous hour is always empty, so it would never be judged at all:
    // the design would have been inert for exactly the agents whose single daily
    // burst is hardest to read.
    const currentStart = windowStartFor(now);

    const rows = await prisma.agentBehaviourWindow.findMany({
        where: {
            tenantId,
            agentId,
            windowStart: { gte: latch.baselineEpoch, lt: currentStart },
        },
        orderBy: { windowStart: 'desc' },
        // Bounded: the newest complete window plus the baseline behind it.
        take: BASELINE_WINDOW_LIMIT + 1,
        select: {
            windowStart: true,
            readCalls: true,
            proposeCalls: true,
            orchestrateCalls: true,
            toolNames: true,
            anomalous: true,
        },
    });

    const judged = rows[0];
    if (judged === undefined) {
        // This is the agent's first ever window. There is nothing complete to
        // judge, and the pointer is deliberately NOT moved — moving it would
        // consume this agent's first judgement on a window that did not exist.
        return { evaluated: false, verdict: null };
    }
    const judgedStart = judged.windowStart;

    const verdict = evaluateCircuitBreaker({
        now,
        current: toObservation(judged),
        baseline: rows.slice(1).map(toObservation),
        rejection: await loadRejectionCounts(tenantId, agentId, now, latch.baselineEpoch),
        priorStreak: latch.anomalousStreak,
        priorStreakSignals: latch.streakSignals as readonly BreakerSignal[],
    });

    await applyVerdict(tenantId, agentId, currentKey, judgedStart, now, verdict);
    return { evaluated: true, verdict };
}

/**
 * Write the verdict onto the judged window and onto the latch.
 *
 * The latch UPDATE is CONDITIONAL on the breaker still being CLOSED. A close
 * that lands between the read and this write must not be undone by a verdict
 * computed against the pre-close baseline — the operator's decision is the
 * newer fact, and re-opening a breaker somebody just closed is how a control
 * gets described as broken.
 */
async function applyVerdict(
    tenantId: string,
    agentId: string,
    currentKey: string,
    judgedStart: Date,
    now: Date,
    verdict: BreakerVerdict,
): Promise<void> {
    const anomalous = verdict.firing.length > 0;
    await prisma.agentBehaviourWindow.updateMany({
        where: { tenantId, agentId, windowStart: judgedStart },
        data: { anomalous, verdict: verdict.code },
    });

    if (verdict.code === 'TRIP') {
        const latched = await prisma.agentCircuitBreaker.updateMany({
            where: { tenantId, agentId, state: 'CLOSED' },
            data: {
                state: 'OPEN',
                trippedAt: now,
                trippedWindow: verdict.windowKey,
                trippedSignals: [...verdict.streakSignals],
                lastEvaluatedWindow: currentKey,
                anomalousStreak: verdict.streak,
                streakSignals: [...verdict.streakSignals],
                lastVerdict: verdict.code,
                lastVerdictAt: now,
            },
        });
        // Gated on the UPDATE's own count, not on the verdict. The `where`
        // above requires `state: 'CLOSED'`, so a human close that landed
        // between the read and this write leaves `count: 0` and the latch
        // shut — and a bell announcing a stop that did not happen is exactly
        // the wrong thing to send about a stop control.
        if (latched.count > 0) {
            await notifyBreakerTrip({ tenantId, agentId, signals: verdict.streakSignals, now });
        }
        return;
    }

    await prisma.agentCircuitBreaker.updateMany({
        where: { tenantId, agentId },
        data: {
            lastEvaluatedWindow: currentKey,
            anomalousStreak: verdict.streak,
            streakSignals: [...verdict.streakSignals],
            lastVerdict: verdict.code,
            lastVerdictAt: now,
        },
    });
}

/**
 * Tell somebody the breaker latched OPEN (#2562).
 *
 * The detector is the only control in the subsystem that stops an agent with
 * no human in the loop, and until this existed it was also the only one that
 * announced nothing: the human UN-trip is audited and metered, the automatic
 * trip wrote one row and returned. Breaker state is rendered on exactly one
 * surface — a tab on that agent's detail page, selected by local component
 * state — so without a bell a latched agent is seen only by somebody who was
 * already looking at it. The manual un-trip is manual BY DESIGN, and that
 * design assumes a human finds out.
 *
 * NEVER THROWS. It is called from `applyVerdict`, which runs inside
 * `recordAuthorizedCall`'s swallowing try/catch — that catch exists so
 * detection can never 500 an already-authorized call. This one is its own
 * belt: the latch is already written when we get here, and a failed
 * notification must not make a successful trip look like a failed evaluation
 * in the logs.
 *
 * Recipients come from the shared resolver, so this bell addresses the same
 * person the kill-switch and quarantine bells do: the agent's accountable
 * owner, falling back to the workspace's ACTIVE OWNERs. `actorUserId` is
 * `null` because there is no actor — nobody clicked anything.
 *
 * `now` is threaded through rather than letting the emitter default it, so
 * the day in the dedupe key is the day of `trippedAt` and not of an
 * independent clock. `entityId` is the AGENT: day-granular dedupe plus the
 * latch itself means at most one bell per trip cycle, because
 * `recordAuthorizedCall` returns early while the latch is OPEN and only a
 * human close can re-arm it.
 */
async function notifyBreakerTrip(trip: {
    tenantId: string;
    agentId: string;
    /**
     * What latched it. Taken directly rather than as a `BreakerVerdict`,
     * because this function only ever read `streakSignals` from one — and a
     * guard-block trip has no verdict to hand over. Constructing a synthetic
     * one would put a statistical judgement in the record that was never
     * computed.
     */
    signals: readonly string[];
    now: Date;
}): Promise<void> {
    try {
        const [recipients, tenant] = await Promise.all([
            resolveAgenticRecipients(prisma, trip.tenantId, trip.agentId),
            // The store has no `RequestContext` — it runs at the MCP tool
            // boundary — so the slug for the deep link is looked up. A miss
            // yields a bell with no link rather than one pointing at
            // `/t/undefined/agents/…`.
            prisma.tenant.findUnique({
                where: { id: trip.tenantId },
                select: { slug: true },
            }),
        ]);
        const signals = [...trip.signals];
        await createAgenticNotification(
            prisma,
            'AGENT_CIRCUIT_BREAKER_TRIPPED',
            {
                tenantId: trip.tenantId,
                tenantSlug: tenant?.slug ?? null,
                entityId: trip.agentId,
                subject: recipients.agentName ?? `Agent ${trip.agentId}`,
                detail: signals.length === 0 ? null : signals.join(', '),
                recipientUserIds: recipients.recipientUserIds,
                actorUserId: null,
            },
            trip.now,
        );
    } catch (err) {
        logger.warn('notification: failed to record agent circuit-breaker bell', {
            // MEMBER READS, not the bare `tenantId` / `agentId` the
            // surrounding code has in scope, and that is the whole reason
            // this function takes an object. `local/no-raw-prompt-logging`
            // counts a bare identifier at a value position as a HOLE in its
            // own denominator — a position on the agentic path where it
            // cannot say whether content reached a log — and
            // `tests/guards/no-raw-prompt-logging.test.ts` ratchets that
            // count downward with no allowance. A member read is analysable,
            // so these two fields cost the rule nothing.
            tenantId: trip.tenantId,
            agentId: trip.agentId,
            // `err.message`, and a LITERAL on the other arm — see the note at
            // the quarantine bell in `agent-proposals.ts` for why this is not
            // `String(err)`.
            error: err instanceof Error ? err.message : 'non-Error thrown',
        });
    }
}

/**
 * The latch, creating it on this agent's first ever call.
 *
 * The INSERT is attempted only when the read misses, so the steady-state cost of
 * the gate is one point lookup. `ON CONFLICT DO NOTHING` rather than a
 * find-then-create: two concurrent first calls would both find nothing.
 */
export async function openBreakerGate(
    tenantId: string,
    agentId: string,
): Promise<BreakerLatch | null> {
    const existing = await readBreakerLatch(tenantId, agentId);
    if (existing !== null) return existing;
    await ensureLatchRow(tenantId, agentId);
    return readBreakerLatch(tenantId, agentId);
}

/**
 * Record one AUTHORIZED call and, at most once per active window, judge.
 *
 * Takes the latch the gate already read rather than re-reading it: two point
 * lookups per tool call to learn the same fact is the kind of cost that gets a
 * control removed for being expensive.
 */
export async function recordAuthorizedCall(
    tenantId: string,
    agentId: string,
    latch: BreakerLatch | null,
    capabilityClass: McpCapabilityClass,
    toolName: string,
    now: Date,
): Promise<void> {
    await observeToolCall(tenantId, agentId, capabilityClass, toolName, now);
    // An OPEN breaker is not re-judged. It is latched, and nothing but a human
    // close moves it — re-evaluating would only invite a future edit in which a
    // quiet window closes a breaker nobody looked at.
    if (latch === null || latch.state === 'OPEN') return;

    // THIS MUST NOT THROW. It runs after every gate has passed, so an exception
    // here would turn a successful authorization into a 500 — the call is
    // already allowed, and failing it now refuses nothing while looking like an
    // outage. `observeToolCall` swallows its own failure for the same reason;
    // this catch covers the evaluation, which reads four more tables and is the
    // larger surface of the two.
    //
    // The direction is opposite to the GATE's, deliberately: the gate must fail
    // CLOSED, because a control you can switch off by making one query fail is
    // not a control. Detection is the half that can safely be skipped — the
    // window is still in the ledger, and the agent's next active window judges
    // it.
    try {
        await evaluateWindow(tenantId, agentId, now, latch);
    } catch (err) {
        logger.warn('agent circuit breaker: window evaluation failed', {
            tenantId,
            agentId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}


/**
 * How many guard blocks this agent has taken since `since` — the number the
 * breaker latches on, and the number the operator surface reports.
 *
 * TWO POPULATIONS, because there are two engines and only one of them produces
 * proposals.
 *
 * The static driver's guard fires on a PROPOSAL, so a block leaves an
 * `AgentProposal` row with `guardVerdict: 'QUARANTINED'` and counting those was
 * the whole story. The Flue engine's guard fires in the tool sandwich, BEFORE
 * the funnel — which is the point of putting it there — so a blocked call
 * queues nothing, writes no proposal, and never reaches `authorize.ts` either.
 * A Flue agent could therefore be blocked all day and be invisible on BOTH of
 * this breaker's inputs: the proposal count, and the per-call ledger
 * `recordAuthorizedCall` writes downstream of a gate the blocked call never got
 * to.
 *
 * So the step ledger is the second population. A Flue block records a
 * `WorkflowStep` with the same `QUARANTINED` verdict, and the run it belongs to
 * carries the `agentId` this breaker is about.
 *
 * ## Exported because the TAB reports this number, and must report THIS one
 *
 * `getAgentCircuitBreaker` calls this with its tenant-scoped client instead of
 * counting the rows again. A second count would be a second definition of the
 * population — free to disagree with the one that actually trips the breaker —
 * and the number that disagrees is the one an operator is reading. The client
 * is a parameter for the same reason the rest of this file takes `tenantId`:
 * the detector runs outside a tenant transaction on the base client, the panel
 * runs inside one, and neither may borrow the other's isolation.
 *
 * Both counts are `count`, not `findMany`: the caller wants the number, and
 * either population is unbounded in principle.
 */
export async function countGuardBlocksInWindow(
    db: Pick<PrismaTx, 'agentProposal' | 'workflowStep'>,
    tenantId: string,
    agentId: string,
    since: Date,
): Promise<number> {
    const [proposalBlocks, stepBlocks] = await Promise.all([
        db.agentProposal.count({
            where: {
                tenantId,
                agentId,
                guardVerdict: 'QUARANTINED',
                createdAt: { gte: since },
            },
        }),
        db.workflowStep.count({
            where: {
                tenantId,
                guardVerdict: 'QUARANTINED',
                // `at`, the step's own stamp — not the run's `startedAt`. A run
                // that began before this window and was blocked inside it was
                // blocked inside it.
                at: { gte: since },
                run: { agentId },
            },
        }),
    ]);
    // Named rather than returned inline, deliberately:
    // `tests/guards/flue-guard-outcome-has-arms.test.ts` reads this exact line
    // as its proof that both populations are counted, precisely because it
    // names both operands. Inlining it would be tidier and would delete the
    // needle.
    const blocksInWindow = proposalBlocks + stepBlocks;
    return blocksInWindow;
}

/**
 * Latch the breaker when an agent's guard blocks pile up inside one window.
 *
 * ## Not a new counter
 *
 * The count comes from rows that already exist: `AgentProposal` carries
 * `guardVerdict` and an `agentId`, so "how many of this agent's proposals did
 * the guard quarantine this hour" is a question the schema can already answer.
 * A dedicated column would be a second record of the same fact, free to
 * disagree with the first — and the one that disagrees is always the one
 * nothing reads.
 *
 * ## Why this writes the latch directly rather than feeding the evaluator
 *
 * See `GUARD_BLOCK_TRIP` in `circuit-breaker.ts`: blocks have no baseline to
 * depart from, and routing them through the statistical path would let the
 * first block define the normal that later ones are judged against.
 *
 * ## The write is the SAME write `evaluateWindow` makes
 *
 * Conditional on `state: 'CLOSED'`, so a human close that landed between the
 * count and this update leaves `count: 0` and the latch shut; and the bell is
 * gated on that count rather than on the decision, because a notification
 * announcing a stop that did not happen is exactly the wrong thing to send
 * about a stop control.
 *
 * Never throws. It runs after a proposal has already been written and
 * quarantined; an exception here would turn a successful quarantine — the guard
 * working — into a 500.
 */
export async function latchOnGuardBlock(
    tenantId: string,
    agentId: string,
    now: Date,
): Promise<{ blocksInWindow: number; latched: boolean }> {
    try {
        const since = windowStartFor(now);
        const blocksInWindow = await countGuardBlocksInWindow(prisma, tenantId, agentId, since);

        if (!shouldLatchOnGuardBlocks(blocksInWindow)) {
            return { blocksInWindow, latched: false };
        }

        // The row is otherwise created only by `openBreakerGate`, which runs
        // inside `authorizeToolCall`/`authorizeResourceRead` — the tool funnel.
        // A guard block happens AROUND the model call and never reaches that
        // funnel, so an agent whose calls are all blocked, or which has only
        // ever proposed, has no row at all. `updateMany` then matches nothing
        // and the trip is silently lost: the agent keeps running having earned
        // the threshold. Insert-if-absent first, so the conditional update
        // below has something to latch. `ON CONFLICT DO NOTHING` keeps this
        // idempotent and cannot reopen a breaker that is already OPEN.
        await ensureLatchRow(tenantId, agentId);

        const latched = await prisma.agentCircuitBreaker.updateMany({
            where: { tenantId, agentId, state: 'CLOSED' },
            data: {
                state: 'OPEN',
                trippedAt: now,
                trippedWindow: windowKeyFor(now),
                trippedSignals: [GUARD_BLOCK_TRIP],
                lastVerdict: 'TRIP',
                lastVerdictAt: now,
            },
        });

        if (latched.count > 0) {
            await notifyBreakerTrip({
                tenantId,
                agentId,
                signals: [GUARD_BLOCK_TRIP],
                now,
            });
        }
        return { blocksInWindow, latched: latched.count > 0 };
    } catch (err) {
        logger.warn('circuit-breaker: guard-block latch failed', {
            tenantId,
            agentId,
            error: err instanceof Error ? err.message : 'non-Error thrown',
        });
        return { blocksInWindow: 0, latched: false };
    }
}
