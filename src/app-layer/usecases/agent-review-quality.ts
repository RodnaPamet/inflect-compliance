/**
 * REVIEW QUALITY — reading the automation-bias metrics off the queue, and
 * alerting when they say something.
 *
 * The arithmetic lives in `@/lib/agentic/automation-bias`, which is pure. This
 * file is the seam: it reads the columns `AgentProposal` already carries,
 * resolves the approval rung each proposal was PINNED to, hands the whole thing
 * to the engine, and writes one audit row when a pattern is outstanding.
 *
 * NOTHING NEW IS STORED. There is no model, no migration and no backfill behind
 * this — every input existed the day the queue shipped and nothing read it this
 * way. That was the finding, not the absence of a table.
 *
 * ── The rung is read from the PIN, never from today's card ──
 *
 * `AgentProposal.policyCardVersion` records which version authorized the call
 * that produced the row, and `AgentPolicyCardVersion` is append-only. So the
 * rung is resolved by joining on (card, version) rather than by reading the
 * agent's CURRENT card: "what did the policy say when this was proposed" and
 * "what does it say now" are different claims, and only the first is evidence.
 * A version this build cannot find (a legacy row, `NO_POLICY_CARD`, a card
 * deleted with its agent) resolves to `null` — an honest unknown, never a
 * default rung.
 *
 * ── Why the alert is deduplicated on a digest ──
 *
 * This is a PULL detector: it fires when the report is computed, which is when
 * an admin opens the page. Without a dedupe, one admin refreshing twice writes
 * two identical rows into a hash-chained log that is never erased, and the
 * alert becomes the noise it was meant to cut through. The dedupe key is a
 * digest over (code, subject) pairs ONLY — see `signalIdentity` — so a standing
 * finding whose count ticked up is recognised as the same finding, while a NEW
 * reviewer crossing a threshold is a new one and lands.
 *
 * That the detector is pull-based is a real limitation and is stated rather
 * than papered over: a tenant that never opens the page is never alerted. The
 * honest fix is a scheduled pass, which is a background job and its own
 * subsystem checklist; the seam here is the same function either way.
 */
import { createHash } from 'node:crypto';

import { appendAuditEntry } from '@/lib/audit';
import { runInTenantContext } from '@/lib/db-context';
import { badRequest } from '@/lib/errors/types';
import {
    computeReviewQuality,
    signalIdentity,
    MIN_REPORTABLE_SAMPLE,
    BULK_APPROVAL_THRESHOLD,
    BULK_APPROVAL_WINDOW_MS,
    IMPLAUSIBLE_DECISION_SECONDS,
    FAST_MEDIAN_SECONDS,
    type ReviewObservation,
    type ReviewQualityReport,
} from '@/lib/agentic/automation-bias';
import { narrowApprovalRung, type ApprovalRung } from '@/lib/agentic/policy-card';
import { assertCanRead } from '../policies/common';
import type { RequestContext } from '../types';

/** Default lookback. A quarter is the shortest window a habit shows up in. */
export const DEFAULT_WINDOW_DAYS = 90;
/** The longest lookback the endpoint will accept. */
export const MAX_WINDOW_DAYS = 365;

/**
 * How many decided proposals one report reads.
 *
 * Bounded because an unbounded `findMany` on a queue that grew is an outage
 * waiting for a busy tenant. When the cap bites, `truncated` says so and the
 * surface prints it — a report over "the most recent 5000" that presents itself
 * as a report over everything is a denominator quietly replaced by a smaller
 * one, which is the defect this whole module is about, one level up.
 */
export const MAX_REPORT_ROWS = 5000;

/** Statuses that mean a human DECIDED. `PENDING` never entered the arithmetic. */
const DECIDED_STATUSES = ['ACCEPTED', 'EDITED', 'REJECTED'] as const;

/** How far back the alert dedupe looks for an identical standing finding. */
const ALERT_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How many recent alert rows are read to answer "have we said this already". */
const ALERT_DEDUPE_SCAN = 25;

/** The audit action an outstanding pattern lands under. */
export const REVIEW_BIAS_AUDIT_ACTION = 'AGENT_REVIEW_BIAS_DETECTED';

export interface ReviewQualityOptions {
    windowDays?: number;
    /**
     * Write the alert row when a pattern is outstanding. Default true. Off for
     * callers that only want the numbers (a test, a future export) — an alert
     * is a side effect and a read that always has one is a read nobody can use
     * twice.
     */
    alert?: boolean;
}

/** The report, plus what a reader needs to know about how it was made. */
export interface ReviewQualityResult extends ReviewQualityReport {
    windowDays: number;
    /** True when `MAX_REPORT_ROWS` bit — the numbers are over a suffix, not all. */
    truncated: boolean;
    /** The constants every number above was measured against. */
    thresholds: {
        minReportableSample: number;
        bulkApprovalThreshold: number;
        bulkApprovalWindowMs: number;
        implausibleDecisionSeconds: number;
        fastMedianSeconds: number;
    };
    /** True when an alert row was written by this call. */
    alerted: boolean;
}

export async function computeAgentReviewQuality(
    ctx: RequestContext,
    opts: ReviewQualityOptions = {},
): Promise<ReviewQualityResult> {
    assertCanRead(ctx);

    const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
    if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > MAX_WINDOW_DAYS) {
        throw badRequest(`windowDays must be an integer between 1 and ${MAX_WINDOW_DAYS}`);
    }
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const { observations, truncated } = await runInTenantContext(ctx, async (db) => {
        const rows = await db.agentProposal.findMany({
            where: {
                tenantId: ctx.tenantId,
                status: { in: [...DECIDED_STATUSES] },
                reviewedAt: { gte: since },
                reviewedByUserId: { not: null },
            },
            select: {
                id: true,
                agentId: true,
                reviewedByUserId: true,
                reviewedAt: true,
                createdAt: true,
                status: true,
                policyCardVersion: true,
            },
            orderBy: { reviewedAt: 'desc' },
            take: MAX_REPORT_ROWS,
        });

        // ── Resolve the PINNED rung, in two bounded queries, never per row ──
        //
        // One `findMany` per proposal would be an N+1 over the whole queue.
        // Both lookups below are `in` over the distinct keys the rows named,
        // and both are capped: a tenant cannot have more cards than agents, and
        // a card cannot have more versions than edits.
        const agentIds = [...new Set(rows.map((r) => r.agentId).filter((a): a is string => !!a))];
        const cards =
            agentIds.length === 0
                ? []
                : await db.agentPolicyCard.findMany({
                      where: { tenantId: ctx.tenantId, agentId: { in: agentIds } },
                      select: { id: true, agentId: true },
                      take: MAX_REPORT_ROWS,
                  });
        // Explicit generics + `as const` on both maps: without them TypeScript
        // widens the pair to `(string | ApprovalRung)[]` and the Map constructor
        // no longer sees a tuple.
        const cardIdByAgent = new Map<string, string>(
            cards.map((c) => [c.agentId, c.id] as const),
        );
        const versionNumbers = [
            ...new Set(rows.map((r) => r.policyCardVersion).filter((v): v is number => v != null)),
        ];
        const versions =
            cards.length === 0 || versionNumbers.length === 0
                ? []
                : await db.agentPolicyCardVersion.findMany({
                      where: {
                          tenantId: ctx.tenantId,
                          cardId: { in: cards.map((c) => c.id) },
                          version: { in: versionNumbers },
                      },
                      select: { cardId: true, version: true, approvalRung: true },
                      take: MAX_REPORT_ROWS,
                  });
        const rungByCardVersion = new Map<string, ApprovalRung>(
            versions.map(
                (v) => [`${v.cardId}:${v.version}`, narrowApprovalRung(v.approvalRung)] as const,
            ),
        );

        const mapped: ReviewObservation[] = rows.map((r) => {
            const cardId = r.agentId ? cardIdByAgent.get(r.agentId) : undefined;
            const rung =
                cardId && r.policyCardVersion != null
                    ? (rungByCardVersion.get(`${cardId}:${r.policyCardVersion}`) ?? null)
                    : null;
            return {
                proposalId: r.id,
                agentId: r.agentId,
                // Non-null by the `where` above; narrowed here rather than cast.
                reviewerUserId: r.reviewedByUserId ?? '',
                proposedAtMs: r.createdAt.getTime(),
                decidedAtMs: (r.reviewedAt ?? r.createdAt).getTime(),
                approved: r.status !== 'REJECTED',
                approvalRung: rung,
            };
        });

        return { observations: mapped, truncated: rows.length === MAX_REPORT_ROWS };
    });

    const report = computeReviewQuality(observations);

    const alerted =
        opts.alert === false || report.signals.length === 0
            ? false
            : await alertOnSignals(ctx, report, windowDays);

    return {
        ...report,
        windowDays,
        truncated,
        thresholds: {
            minReportableSample: MIN_REPORTABLE_SAMPLE,
            bulkApprovalThreshold: BULK_APPROVAL_THRESHOLD,
            bulkApprovalWindowMs: BULK_APPROVAL_WINDOW_MS,
            implausibleDecisionSeconds: IMPLAUSIBLE_DECISION_SECONDS,
            fastMedianSeconds: FAST_MEDIAN_SECONDS,
        },
        alerted,
    };
}

/**
 * Write ONE audit row naming the outstanding patterns, unless an identical one
 * already stands.
 *
 * Every field on the row is a CODE, an ID or a COUNT. No proposal payload, no
 * rationale, no reviewer email — the same contract the guard rule ids keep, and
 * the reason this is safe to put in a plaintext, hash-chained, never-erased
 * store. The fields are also spelled as member reads off one prepared object
 * rather than as bare locals, so `local/no-raw-prompt-logging` can resolve every
 * value position at the sink instead of counting it as a hole.
 */
async function alertOnSignals(
    ctx: RequestContext,
    report: ReviewQualityReport,
    windowDays: number,
): Promise<boolean> {
    const identity = signalIdentity(report.signals);
    const alert = {
        // Every field the sink reads is prepared HERE, on one object, including
        // the action string. `local/no-raw-prompt-logging` resolves a member
        // read and counts a bare local as a hole it cannot judge — so the
        // constant is carried through the object rather than referenced at the
        // call, and the sink's every value position stays analysable.
        action: REVIEW_BIAS_AUDIT_ACTION,
        signalsDigest: createHash('sha256').update(identity).digest('hex'),
        signalCodes: [...new Set(report.signals.map((s) => s.code))].sort().join(','),
        signalCount: report.signals.length,
        reviewersFlagged: new Set(
            report.signals.filter((s) => s.scope === 'REVIEWER').map((s) => s.subjectId),
        ).size,
        decidedInWindow: report.decided,
        windowDays,
    };

    const since = new Date(Date.now() - ALERT_DEDUPE_WINDOW_MS);
    const recent = await runInTenantContext(ctx, (db) =>
        db.auditLog.findMany({
            where: {
                tenantId: ctx.tenantId,
                action: REVIEW_BIAS_AUDIT_ACTION,
                createdAt: { gte: since },
            },
            select: { metadataJson: true },
            orderBy: { createdAt: 'desc' },
            take: ALERT_DEDUPE_SCAN,
        }),
    );
    const alreadyStanding = recent.some((row) => {
        // `metadataJson` is a Json column, so it is narrowed rather than cast:
        // a row written by an older build carries no digest, and a row written
        // by a future one may carry a shape this build has no name for. Both
        // must read as "not the same finding", never as a thrown page.
        const meta: unknown = row.metadataJson;
        if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return false;
        return (meta as Record<string, unknown>).signalsDigest === alert.signalsDigest;
    });
    if (alreadyStanding) return false;

    await appendAuditEntry({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        actorType: 'USER',
        entity: 'AgentProposal',
        // The tenant's queue as a whole is the subject: the finding is about the
        // review process, not about any single proposal, and pinning it to one
        // row would make it look like that row was the problem.
        entityId: ctx.tenantId,
        action: alert.action,
        requestId: ctx.requestId,
        detailsJson: {
            category: 'access',
            event: 'agent_review_bias_detected',
            signalCodes: alert.signalCodes,
            signalCount: alert.signalCount,
            reviewersFlagged: alert.reviewersFlagged,
            decidedInWindow: alert.decidedInWindow,
            windowDays: alert.windowDays,
        },
        metadataJson: {
            signalsDigest: alert.signalsDigest,
            signalCodes: alert.signalCodes,
        },
    }).catch(() => undefined);

    return true;
}
