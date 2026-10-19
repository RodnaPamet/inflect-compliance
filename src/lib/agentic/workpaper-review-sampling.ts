/**
 * INTERNAL AUDIT SAMPLES THE AUDITOR'S WORKPAPERS (#3677, step 3d; decision 3
 * of `docs/agentic-iam-roadmap.md`).
 *
 * The auditor agent re-performs audit procedures and writes workpapers (3b,
 * 3c). Nothing in that chain checks the auditor. This module is the check's
 * arithmetic: which workpapers internal audit re-performs, who in internal
 * audit is asked, the codes a dissent is recorded in, and the agreement rate.
 * The sweep (`jobs/audit-workpaper-sample-review.ts`) and the review usecase
 * (`usecases/audit-workpaper-sample-review.ts`) are its only callers.
 *
 * PURE, and no server imports: the seed arrives as an argument, as it does for
 * `proposal-sampling.ts`, so every rule here is exercised without a key, a
 * database or a tenant.
 *
 * ── Which workpapers: the keyed score, against a configured rate ─────
 *
 * The draw REUSES the ASI09 sampler's keyed score (`sampleScore`, an
 * HMAC-SHA256 under a per-tenant seed derived from the master KEK) and decides
 * each workpaper on its own: it is drawn when its score, read as a fraction of
 * the score space, falls below the tenant's rate. The epoch is fixed by the
 * WORKPAPER'S period (`audit-workpaper-review@<periodLabel>`), never by the run
 * date, so the decision for one workpaper is a pure function of (seed, epoch,
 * id, rate) and every later sweep re-derives the same answer.
 *
 * Not `selectSample`'s rank over a population, and the reason is the rate: a
 * rank is taken over the population a run sees, and a workpaper population
 * grows after every run (a re-run of a procedure writes a new workpaper for an
 * old period). Re-ranking a grown population draws different members, so a
 * workpaper passed over once would be a fresh candidate in every later sweep
 * and the union would creep towards everything — a sample in name only, the
 * convergence `schedules.ts` warns about for the ASI09 sweep. A decision per
 * workpaper has no population to re-rank: at a given rate, passed over is
 * passed over for good. The rate is also MONOTONE — the workpapers drawn at a
 * rate are a subset of those drawn at any higher one — so raising it draws
 * more of the same workpapers (those still inside the sweep's lookback) and
 * lowering it un-draws nothing already drawn.
 * What rank buys the ASI09 sampler — that even a holder of the seed cannot
 * predict a draw, because it depends on approvals not yet made — is not needed
 * here: the party a prediction would help is the auditor agent and its second-
 * line owner, neither holds the master KEK, and at the pilot's rate (100%)
 * there is nothing to predict.
 *
 * ── Who is asked: a keyed draw among internal audit ─────────────────
 *
 * `selectSample` over the tenant's ACTIVE members whose line of defence is
 * THIRD, minus the auditor agent's current owner, with the same epoch and the
 * workpaper id. Reproducible from the stored epoch and the pool, whose size and
 * digest the row records. An empty pool is not dropped and not filled with
 * somebody ineligible: the item is UNASSIGNED with a named reason.
 *
 * ── The number ──────────────────────────────────────────────────────
 *
 * Agreement is CONCURRED over (CONCURRED + DISSENTED). A drawn but unreviewed
 * workpaper is in neither; INDETERMINATE and UNASSIGNED are excluded and
 * counted beside the rate; and a rate over no concluded review is NO rate,
 * never "100% agreement" (invariant 5 of the recertification section of
 * CLAUDE.md: zero is never complete).
 */
import { createHash, createHmac } from 'node:crypto';

import { sampleScore, selectSample } from './proposal-sampling';
import {
    WORKPAPER_REVIEW_DEFAULT_SAMPLE_PERCENT,
    WORKPAPER_REVIEW_MAX_SAMPLE_PERCENT,
    WORKPAPER_REVIEW_MIN_SAMPLE_PERCENT,
} from './workpaper-review-codes';

// ─── The epoch, the seed, the rate ──────────────────────────────────────────

/** The prefix of every review epoch. Stored, and pinned by a CHECK. */
export const WORKPAPER_REVIEW_EPOCH_PREFIX = 'audit-workpaper-review@';

/** `audit-workpaper-review@<periodLabel>` — fixed by the workpaper's period, never the run date. */
export function workpaperReviewEpoch(periodLabel: string): string {
    return `${WORKPAPER_REVIEW_EPOCH_PREFIX}${periodLabel}`;
}

/**
 * The HKDF purpose of the per-tenant seed. Versioned; changing it re-randomises
 * every draw. Distinct from the ASI09 sampler's purpose and from the audit
 * procedures' sample purpose, so the three draws never share a key.
 */
export const WORKPAPER_REVIEW_SEED_PURPOSE_PREFIX = 'inflect-audit-workpaper-review-sample-v1';

export function workpaperReviewSeedPurpose(tenantId: string): string {
    return `${WORKPAPER_REVIEW_SEED_PURPOSE_PREFIX}:${tenantId}`;
}

/** The fixed label the seed fingerprint is taken over. */
export const WORKPAPER_REVIEW_SEED_FINGERPRINT_LABEL = 'inflect-audit-workpaper-review-seed-fingerprint-v1';

/**
 * HMAC-SHA256 under the seed over a fixed label. Not secret: it reveals neither
 * the seed nor a score, and tells a verifier whether the seed they hold drew a
 * row (a master-KEK rotation derives a different one).
 */
export function workpaperReviewSeedFingerprint(seed: string): string {
    return createHmac('sha256', seed).update(WORKPAPER_REVIEW_SEED_FINGERPRINT_LABEL).digest('hex');
}

// The rate's default and bounds live in `workpaper-review-codes.ts`, so the
// review page's rate control holds the same numbers the server and the CHECK
// enforce. Re-exported here for the server side.
export {
    WORKPAPER_REVIEW_DEFAULT_SAMPLE_PERCENT,
    WORKPAPER_REVIEW_MAX_SAMPLE_PERCENT,
    WORKPAPER_REVIEW_MIN_SAMPLE_PERCENT,
} from './workpaper-review-codes';

/**
 * The rate to draw at. A stored value outside 1..100 (which the CHECK refuses,
 * so only a row older than it could hold one) or a missing one reads as the
 * default, 100: an unreadable rate fails towards reviewing more, never less.
 */
export function effectiveSamplePercent(stored: number | null | undefined): number {
    if (
        typeof stored !== 'number' ||
        !Number.isInteger(stored) ||
        stored < WORKPAPER_REVIEW_MIN_SAMPLE_PERCENT ||
        stored > WORKPAPER_REVIEW_MAX_SAMPLE_PERCENT
    ) {
        return WORKPAPER_REVIEW_DEFAULT_SAMPLE_PERCENT;
    }
    return stored;
}

/** The keyed score of one workpaper, read as a fraction in [0, 1) from its first 52 bits. */
export function scoreFraction(seed: string, epoch: string, workpaperId: string): number {
    const score = sampleScore(seed, epoch, workpaperId);
    // 13 hex digits = 52 bits, exactly representable in a double.
    return parseInt(score.slice(0, 13), 16) / 2 ** 52;
}

/**
 * Is this workpaper drawn for review? Its keyed score below the rate. At 100%
 * every workpaper is drawn, because every fraction is below 1.
 */
export function isDrawnForReview(input: {
    seed: string;
    epoch: string;
    workpaperId: string;
    samplePercent: number;
}): boolean {
    const percent = effectiveSamplePercent(input.samplePercent);
    if (percent >= WORKPAPER_REVIEW_MAX_SAMPLE_PERCENT) return true;
    return scoreFraction(input.seed, input.epoch, input.workpaperId) < percent / 100;
}

/** The workpapers of a candidate list that are drawn. Order preserved. */
export function drawWorkpapersForReview<T extends { id: string; periodLabel: string }>(
    workpapers: readonly T[],
    options: { seed: string; samplePercent: number },
): T[] {
    return workpapers.filter((w) =>
        isDrawnForReview({
            seed: options.seed,
            epoch: workpaperReviewEpoch(w.periodLabel),
            workpaperId: w.id,
            samplePercent: options.samplePercent,
        }),
    );
}

// ─── Who is asked ───────────────────────────────────────────────────────────

/** The line of defence that reviews a sampled workpaper (decision 3: internal audit). */
export const WORKPAPER_REVIEWER_LINE = 'THIRD' as const;

/**
 * Why a sampled workpaper has nobody assigned. Stored, CHECK-pinned, and
 * shown: an UNASSIGNED item is recorded, never dropped.
 */
export const UNASSIGNED_REASONS = [
    /** The tenant has no ACTIVE member whose line of defence is THIRD. */
    'NO_THIRD_LINE_MEMBER',
    /** Every ACTIVE THIRD-line member is the auditor agent's owner. */
    'ONLY_THIRD_LINE_MEMBER_OWNS_AUDITOR',
    /** The auditor agent is not in the register, so its owner cannot be excluded. */
    'AUDITOR_OWNER_UNKNOWN',
] as const;
export type UnassignedReason = (typeof UNASSIGNED_REASONS)[number];

export interface MemberFacts {
    readonly userId: string;
    readonly status: string;
    readonly lineOfDefence: string | null;
}

/**
 * Is this member eligible to review a workpaper of an auditor owned by
 * `auditorOwnerUserId`? ACTIVE, THIRD line, and not that owner. The one rule
 * the sweep's pool, the list, the read and the answer all apply.
 */
export function isEligibleReviewer(member: MemberFacts | null, auditorOwnerUserId: string | null): boolean {
    return (
        member !== null &&
        member.status === 'ACTIVE' &&
        member.lineOfDefence === WORKPAPER_REVIEWER_LINE &&
        auditorOwnerUserId !== null &&
        member.userId !== auditorOwnerUserId
    );
}

/** The SHA-256 over the sorted user ids, one per line — the pool the draw was made over. */
export function assignmentPoolDigest(userIds: readonly string[]): string {
    const lines = [...new Set(userIds)].sort();
    return createHash('sha256').update(lines.map((l) => `${l}\n`).join(''), 'utf8').digest('hex');
}

export type ReviewerAssignment =
    | {
          readonly assignedToUserId: string;
          readonly unassignedReason: null;
          readonly poolSize: number;
          readonly poolDigest: string;
      }
    | {
          readonly assignedToUserId: null;
          readonly unassignedReason: UnassignedReason;
          readonly poolSize: number;
          readonly poolDigest: string;
      };

/**
 * Draw the reviewer for one workpaper. The pool is every eligible member; the
 * draw is `selectSample` with the review epoch and the workpaper id, so the
 * same pool always yields the same reviewer and two workpapers of one period
 * spread across the pool rather than landing on one person.
 */
export function assignReviewer(input: {
    seed: string;
    epoch: string;
    workpaperId: string;
    /** The auditor agent's CURRENT owner; null when the agent is not in the register. */
    auditorOwnerUserId: string | null;
    /** Every member of the tenant the caller read; filtered here. */
    members: readonly MemberFacts[];
}): ReviewerAssignment {
    const thirdLine = input.members.filter(
        (m) => m.status === 'ACTIVE' && m.lineOfDefence === WORKPAPER_REVIEWER_LINE,
    );
    const pool = [
        ...new Set(
            thirdLine
                .filter((m) => isEligibleReviewer(m, input.auditorOwnerUserId))
                .map((m) => m.userId),
        ),
    ].sort();
    const poolDigest = assignmentPoolDigest(pool);

    // With no owner to exclude the pool is empty by `isEligibleReviewer`, so the
    // digest above is already the empty pool's.
    if (input.auditorOwnerUserId === null) {
        return { assignedToUserId: null, unassignedReason: 'AUDITOR_OWNER_UNKNOWN', poolSize: 0, poolDigest };
    }
    if (thirdLine.length === 0) {
        return { assignedToUserId: null, unassignedReason: 'NO_THIRD_LINE_MEMBER', poolSize: 0, poolDigest };
    }
    if (pool.length === 0) {
        return {
            assignedToUserId: null,
            unassignedReason: 'ONLY_THIRD_LINE_MEMBER_OWNS_AUDITOR',
            poolSize: 0,
            poolDigest,
        };
    }
    const [picked] = selectSample(
        pool.map((id) => ({ id })),
        { seed: input.seed, epoch: reviewerDrawEpoch(input.epoch, input.workpaperId), count: 1 },
    );
    return { assignedToUserId: picked.id, unassignedReason: null, poolSize: pool.length, poolDigest };
}

/** The epoch the reviewer draw uses: the review epoch, then the workpaper. */
export function reviewerDrawEpoch(epoch: string, workpaperId: string): string {
    return `${epoch}/reviewer/${workpaperId}`;
}

// ─── What a reviewer may answer ─────────────────────────────────────────────

// The vocabulary a reviewer answers in, and why an answer is refused, live in
// `workpaper-review-codes.ts` so a client component can hold them without
// pulling `node:crypto` into its bundle. Re-exported here for the server side.
export {
    WORKPAPER_REVIEW_ANSWERS,
    WORKPAPER_REVIEW_DISSENT_CODES,
    type WorkpaperReviewAnswer,
    type WorkpaperReviewDissentCode,
    type WorkpaperReviewRefusal,
} from './workpaper-review-codes';

// ─── The number ─────────────────────────────────────────────────────────────

export interface WorkpaperReviewCounts {
    /** Rows drawn in the window, whatever their state. */
    readonly drawn: number;
    /** Drawn, nobody eligible to ask (UNASSIGNED). Never answered. */
    readonly unassigned: number;
    /** Drawn, assigned, not yet answered. */
    readonly awaiting: number;
    readonly concurred: number;
    readonly dissented: number;
    readonly indeterminate: number;
}

export interface WorkpaperReviewRate extends WorkpaperReviewCounts {
    /** CONCURRED + DISSENTED — the rate's denominator. */
    readonly concluded: number;
    /** concurred / concluded, or null when nothing is concluded. */
    readonly agreementRate: number | null;
    /** dissented / concluded, or null when nothing is concluded. */
    readonly disagreementRate: number | null;
}

/**
 * The agreement rate. A drawn but unreviewed workpaper is in neither the
 * numerator nor the denominator; INDETERMINATE and UNASSIGNED are excluded and
 * returned beside it; and over no concluded review the rate is null — zero
 * concluded reviews is not "100% agreement" and not "0% disagreement".
 */
export function workpaperReviewRate(counts: WorkpaperReviewCounts): WorkpaperReviewRate {
    const concluded = counts.concurred + counts.dissented;
    return {
        ...counts,
        concluded,
        agreementRate: concluded > 0 ? counts.concurred / concluded : null,
        disagreementRate: concluded > 0 ? counts.dissented / concluded : null,
    };
}

// ─── The finding proposal a dissent raises ──────────────────────────────────

/** `Finding.sourceKind` of a finding raised from a dissenting review. */
export const WORKPAPER_REVIEW_FINDING_SOURCE_KIND = 'AUDIT_WORKPAPER_REVIEW';

/**
 * `AgentProposal.proposedBySessionRef` of the proposal one review raised. A
 * plain, queryable column (the payload is encrypted), so a re-run finds the
 * proposal an interrupted run already raised instead of raising a second one.
 * The owner-orphan pass uses the column the same way.
 */
export function dissentProposalOriginRef(reviewId: string): string {
    return `${DISSENT_PROPOSAL_ORIGIN_PREFIX}${reviewId}`;
}

const DISSENT_PROPOSAL_ORIGIN_PREFIX = 'audit-workpaper-review:';

/**
 * The review a proposal's origin ref names, or null when the proposal is not a
 * workpaper dissent's. The inverse of `dissentProposalOriginRef`, read by every
 * path that DECIDES a proposal: the person whose dissent raised a finding
 * proposal never decides it (owner decision, 2026-10-19), and this ref — a
 * plain column the raise writes and nothing rewrites — is how the queue knows
 * whose dissent it was without decrypting the payload.
 */
export function reviewIdFromDissentOriginRef(ref: string | null | undefined): string | null {
    if (typeof ref !== 'string' || !ref.startsWith(DISSENT_PROPOSAL_ORIGIN_PREFIX)) return null;
    const id = ref.slice(DISSENT_PROPOSAL_ORIGIN_PREFIX.length);
    return id.length > 0 ? id : null;
}

/**
 * The FINDING proposal a DISSENTED review queues. Identifiers and codes only —
 * the workpaper, its procedure and period, the auditor agent, the dissent codes
 * and the reviewer's user id — never a unit, a name or an excerpt.
 */
export function dissentFindingProposal(input: {
    reviewId: string;
    workpaperId: string;
    procedureId: string;
    catalogueVersion: number;
    periodLabel: string;
    conclusion: string;
    conclusionBasis: string;
    auditorAgentId: string;
    reviewerUserId: string;
    dissentCodes: readonly string[];
    samplingEpoch: string;
}): { payload: Record<string, unknown>; rationale: string } {
    const codes = [...input.dissentCodes].join(', ');
    return {
        payload: {
            severity: 'MEDIUM',
            type: 'NONCONFORMITY',
            title: `Internal audit did not concur with workpaper ${input.procedureId} ${input.periodLabel}`.slice(0, 200),
            description:
                `Internal audit re-performed audit workpaper ${input.workpaperId} (procedure ${input.procedureId}, ` +
                `catalogue version ${input.catalogueVersion}, period ${input.periodLabel}, conclusion ` +
                `${input.conclusion} on ${input.conclusionBasis}), written by auditor agent ${input.auditorAgentId} ` +
                `and drawn for review with epoch ${input.samplingEpoch}, and did not concur. Review ` +
                `${input.reviewId}, by reviewer ${input.reviewerUserId}. Dissent codes: ${codes}. ` +
                'A person decides this proposal; the review wrote no finding.',
            sourceKind: WORKPAPER_REVIEW_FINDING_SOURCE_KIND,
            sourceRef: input.reviewId,
        },
        rationale: `Internal audit dissented from sampled workpaper ${input.workpaperId}: ${codes}.`,
    };
}
