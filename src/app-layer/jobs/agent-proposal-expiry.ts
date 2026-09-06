/**
 * EXPIRE STALE AGENT PROPOSALS — the sweep that bounds the review queue.
 *
 * OWASP ASI09. Queue depth is itself a driver of rubber-stamping, so an
 * unbounded review queue is part of the threat model rather than a housekeeping
 * matter. `src/lib/agentic/proposal-expiry.ts` owns the window arithmetic and
 * the reasoning; this is the nightly pass that acts on it.
 *
 * ── This job is BOOKKEEPING, not enforcement ─────────────────────────
 *
 * The refusal lives in `approveAgentProposal`, which reads the CLOCK rather
 * than the status. That ordering matters: this pass runs once a day, so there
 * is always a window of up to a day between a deadline passing and this job
 * noticing, and if the usecase trusted the status a proposal could be approved
 * throughout it. The deadline would then be enforced by a cron's punctuality
 * instead of by the deadline. So a dead worker here degrades the queue's
 * TIDINESS, never its safety.
 *
 * ── Nothing is deleted ───────────────────────────────────────────────
 *
 * An expired proposal is the record of something an agent asked for and no
 * human ever agreed to. That is evidence: it is the raw material for "what is
 * this agent trying to do that nobody wants?", and it is the only trace that
 * the queue was too long to serve. So the pass is a status transition to a
 * terminal `EXPIRED` plus one hash-chained audit row. The payload, the
 * rationale, the guard verdict, the agent attribution and the pinned policy-card
 * version are all left exactly as they were, and `reviewedByUserId` stays NULL
 * because nobody reviewed it — writing a reviewer here would be inventing the
 * decision the whole subsystem exists to record honestly.
 *
 * ── The backfill, and why it grants time rather than taking it ───────
 *
 * `expiresAt` was added to a populated table without a backfill (SQL cannot
 * resolve a proposal's approval rung), so every pre-existing PENDING row has
 * NULL. NULL means NO DEADLINE RECORDED, not "expired" — `isProposalExpired`
 * returns false for it, deliberately.
 *
 * This pass stamps those rows with a deadline a FULL WINDOW FROM NOW rather
 * than from their `createdAt`. Computing it from `createdAt` would retire every
 * proposal older than a week on the first run after deploy — a mass expiry
 * nobody scheduled, which is an outage wearing the costume of a control. The
 * grace is one-time by construction: once stamped, the row is on the ordinary
 * clock like every other.
 */
import type { PrismaClient } from '@prisma/client';

import { appendAuditEntry } from '@/lib/audit';
import { logger } from '@/lib/observability/logger';
import { UNCARDED_PROPOSAL_WINDOW_DAYS } from '@/lib/agentic/proposal-expiry';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How many proposals one pass will expire.
 *
 * A bound rather than "all of them" because each expiry writes a hash-chained
 * audit row, and the chain serialises on an advisory lock — an unbounded first
 * run over a large backlog would hold that lock for as long as it took. What is
 * left over is expired by tomorrow's pass; the usecase already refuses to
 * approve any of them in the meantime, so the lag costs tidiness and nothing
 * else.
 */
export const EXPIRY_BATCH_LIMIT = 500;

export interface AgentProposalExpiryOptions {
    /** Scope to one tenant. Omitted = system-wide, which is how it is scheduled. */
    tenantId?: string;
    /** Override the "now" anchor — test-only seam, mirroring the other sweeps. */
    now?: Date;
}

export interface AgentProposalExpiryResult {
    /** PENDING rows whose window had closed when this pass looked. */
    scanned: number;
    /** Rows this pass moved PENDING -> EXPIRED. */
    expired: number;
    /** Pre-existing rows this pass gave a deadline to for the first time. */
    backfilled: number;
    /**
     * Rows that were due but lost the conditional claim — somebody approved or
     * rejected them between the read and the write. Reported rather than
     * swallowed: a non-zero value here is the measurable footprint of the race
     * the claim predicate exists to lose safely.
     */
    raced: number;
}

export async function runAgentProposalExpiry(
    db: PrismaClient,
    options: AgentProposalExpiryOptions = {},
): Promise<AgentProposalExpiryResult> {
    const now = options.now ?? new Date();
    const { tenantId } = options;
    const tenantScope = tenantId ? { tenantId } : {};

    logger.info('agent-proposal expiry sweep starting', {
        component: 'agent-proposal-expiry',
        scope: tenantId ? 'tenant-scoped' : 'system-wide',
        // NAMED at the sink, never spread. `local/no-raw-prompt-logging`
        // cannot read the keys of a spread object, so a conditional spread
        // here is a field bag this repo's own census counts as a hole — and
        // the hole is the shape a prompt would hide in.
        tenantId: tenantId ?? null,
    });

    // ── 1. Backfill. One statement, no loop, no per-row decision. ──
    const backfill = await db.agentProposal.updateMany({
        where: { ...tenantScope, status: 'PENDING', expiresAt: null },
        data: { expiresAt: new Date(now.getTime() + UNCARDED_PROPOSAL_WINDOW_DAYS * MS_PER_DAY) },
    });

    // ── 2. The due rows. ONE read; the loop below writes only. ──
    const due = await db.agentProposal.findMany({
        where: { ...tenantScope, status: 'PENDING', expiresAt: { lte: now } },
        select: { id: true, tenantId: true, kind: true, agentId: true, expiresAt: true },
        orderBy: { expiresAt: 'asc' },
        take: EXPIRY_BATCH_LIMIT,
    });

    let expired = 0;
    let raced = 0;

    for (const proposal of due) {
        // Conditional claim, exactly as `approveAgentProposal` does it: the
        // database decides. A reviewer who approved this row a millisecond ago
        // holds it, and this pass must not overwrite their decision with
        // EXPIRED — which is the direction that would destroy evidence.
        const claim = await db.agentProposal.updateMany({
            where: { id: proposal.id, tenantId: proposal.tenantId, status: 'PENDING' },
            data: { status: 'EXPIRED' },
        });
        if (claim.count === 0) {
            raced += 1;
            continue;
        }
        expired += 1;

        await appendAuditEntry({
            tenantId: proposal.tenantId,
            // `userId: null`: nobody did this, which is the whole fact the row
            // records. An actor invented here would read, forever, as a person
            // who made a decision.
            userId: null,
            actorType: 'SYSTEM',
            entity: 'AgentProposal',
            entityId: proposal.id,
            action: 'AGENT_PROPOSAL_EXPIRED',
            detailsJson: {
                category: 'access',
                kind: proposal.kind,
                agentId: proposal.agentId,
                expiredAt: proposal.expiresAt ? proposal.expiresAt.toISOString() : null,
            },
            metadataJson: { agentId: proposal.agentId, reason: 'review_window_closed' },
        }).catch(() => undefined);
    }

    logger.info('agent-proposal expiry sweep complete', {
        component: 'agent-proposal-expiry',
        scanned: due.length,
        expired,
        backfilled: backfill.count,
        raced,
    });

    return { scanned: due.length, expired, backfilled: backfill.count, raced };
}
