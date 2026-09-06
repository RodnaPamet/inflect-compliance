/**
 * REVIEW-QUALITY METRICS — does an approval on the agent-proposal queue mean
 * anything? (OWASP ASI09, human-agent trust exploitation / automation bias.)
 *
 * The product's whole safety story for the agentic path is propose-not-commit:
 * an agent never mutates a record, every write routes through `AgentProposal`
 * and a human approves it. That control is correct in DESIGN and, until this
 * module, entirely UNMEASURED in practice. A queue that is rubber-stamped under
 * volume is worse than no queue at all — it manufactures a hash-chained,
 * non-repudiable record of consent nobody actually gave, and the trail is the
 * one store the retention policy promises never to erase.
 *
 * Nothing new is stored to compute any of this. Every input is a column
 * `AgentProposal` has carried since the queue shipped — `createdAt`,
 * `reviewedAt`, `reviewedByUserId`, `status`, `agentId` — plus the
 * `approvalRung` the agent's policy card already pinned. This module is pure:
 * observations in, a report out. It holds no Prisma, no clock, no crypto, and
 * no server imports, so the same arithmetic can be run in a test, in a usecase,
 * or (if it ever needs to be) in a browser.
 *
 * ══ THE ONE THING TO UNDERSTAND BEFORE READING A NUMBER HERE ══
 *
 * `reviewedAt - createdAt` is NOT review time. It is queue latency PLUS review
 * time, because `createdAt` is when the AGENT proposed, not when the human
 * opened the row. That asymmetry is the whole reason the distribution is read
 * from ONE END:
 *
 *   • The LOWER tail is a hard upper bound on diligence. A proposal decided
 *     four seconds after it was created was reviewed in at most four seconds.
 *     There is no way for that number to flatter the reviewer.
 *   • The UPPER tail measures BACKLOG, not care. A proposal decided nine days
 *     after it was created tells you the queue was ignored for nine days; it
 *     says nothing whatsoever about how long anybody looked at it.
 *
 * So this module reports p50, p10 and the fastest decision, and deliberately
 * does NOT report a p90 or a mean. Both would be real numbers, both would move
 * on a dashboard, and neither would answer a question anybody has. See
 * `docs/implementation-notes/2026-09-06-review-quality-metrics.md`.
 *
 * ══ WHAT IS AN ESTIMATE, AND WHAT IS AN OBSERVATION ══
 *
 * The distinction runs through every shape below, because it decides what may
 * be reported over a small sample.
 *
 *   An OBSERVATION is a fact about something that happened. "This reviewer's
 *   fastest decision was 3 seconds." "These five approvals landed inside 41
 *   seconds." One occurrence is enough; a sample size does not enter into it.
 *
 *   An ESTIMATE is a summary standing in for a population. "This reviewer
 *   approves 94% of what they see." "Their median decision takes 22 seconds."
 *   Over four decisions, that first number can only be 0, 25, 50, 75 or 100 —
 *   it is not a rate, it is the last click wearing a percent sign.
 *
 * Estimates are REFUSED below `MIN_REPORTABLE_SAMPLE`, and the refusal is a
 * value in the returned shape (`{ reported: false, reason, observed, required }`)
 * rather than an omitted field. A metric that silently disappears at n = 4
 * looks exactly like a reviewer with nothing to report, which is the opposite
 * of what it means. Observations are reported at any n, including n = 1.
 */
import type { ApprovalRung } from './policy-card';

// ─── Thresholds, and where each number comes from ───────────────────

/**
 * How many decisions before an ESTIMATE (a rate, a percentile) is reported.
 *
 * DERIVED, not picked. The rule is: refuse to report a rate when one more
 * decision would move it by more than ten percentage points. One decision moves
 * a rate by `1/n`, so `1/n > 0.10` ⟺ `n < 10`. At n = 9 a single approval
 * swings the headline by 11 points and the number is reporting the last click;
 * at n = 10 it moves by exactly 10 and the number has begun to be about the
 * reviewer.
 *
 * It is deliberately not larger. A stricter floor is easy to defend
 * statistically and is the wrong trade here: a reviewer with 12 decisions and a
 * 100% approval rate is exactly the case an admin needs to see EARLY, and a
 * threshold that hides them until they have 50 is a threshold that reports the
 * problem after it has become the habit.
 */
export const MIN_REPORTABLE_SAMPLE = 10;

/**
 * How many approvals by ONE reviewer inside `BULK_APPROVAL_WINDOW_MS` is a
 * burst.
 *
 * Five, because that is where the arithmetic stops being survivable: five
 * approvals in a minute is twelve seconds each INCLUDING the page interactions,
 * and the queue renders the full proposed payload as JSON — there is no reading
 * of five compliance records in that time. Four in a minute is fifteen seconds
 * each, which is fast and is not proof.
 *
 * A burst is an OBSERVATION, so it is reported however few decisions the
 * reviewer has in total. `MIN_REPORTABLE_SAMPLE` does not gate it and must not:
 * a reviewer whose entire history is one burst of six is the clearest case this
 * module exists to surface, and a sample floor would be precisely the thing
 * that hid them.
 */
export const BULK_APPROVAL_THRESHOLD = 5;

/** The burst window. Inclusive at both ends — see `findApprovalBursts`. */
export const BULK_APPROVAL_WINDOW_MS = 60_000;

/**
 * Below this, the decision was not read. Per-decision, an OBSERVATION.
 *
 * The smallest thing the queue can show is a proposed risk: a title, a
 * description, a likelihood and an impact, rendered as pretty-printed JSON.
 * That is on the order of forty words. Five seconds is under the time to READ
 * forty words at any human rate, before any judgement about whether the risk is
 * real — so a decision inside it was taken on the row's existence, not its
 * content.
 */
export const IMPLAUSIBLE_DECISION_SECONDS = 5;

/**
 * Below this MEDIAN, the typical decision was not read. An ESTIMATE, so it is
 * gated by `MIN_REPORTABLE_SAMPLE`.
 *
 * Thirty seconds: roughly twelve to read the smallest payload at 200 words per
 * minute, plus a moment to decide, plus the click. A p50 of four seconds is a
 * finding and not a statistic, and this is the constant that makes the surface
 * say so.
 */
export const FAST_MEDIAN_SECONDS = 30;

// ─── The signal vocabulary ──────────────────────────────────────────

/**
 * Every pattern this module can name. STABLE CODES: they go into an audit row
 * and into an operator's alert, so one has to mean the same thing in six
 * months. Same discipline as `POLICY_CARD_RULES` in `policy-card.ts`.
 *
 * "Review quality is poor" is not a finding — it is the absence of one. A
 * signal that does not say WHICH pattern fired, over how many decisions, and
 * against what threshold leaves an admin to guess between a busy week, a
 * scripted approver and a queue nobody reads.
 */
export const REVIEW_BIAS_SIGNALS = [
    /** N approvals by one reviewer inside the window. Observation. */
    'BULK_APPROVAL_BURST',
    /** A single decision faster than a human can have read the row. Observation. */
    'IMPLAUSIBLY_FAST_DECISION',
    /** A reviewer whose MEDIAN decision is below the reading floor. Estimate. */
    'FAST_MEDIAN_REVIEW',
    /** A reviewer at or above the sample floor who has never rejected. Estimate. */
    'NEVER_REJECTED',
    /**
     * The agent's card in force pinned `SECOND_APPROVER`, and the queue
     * recorded one. `AgentProposal` carries a single `reviewedByUserId`, so
     * this fires for EVERY such proposal — the declaration is not enforceable
     * by the schema that is supposed to evidence it. Observation.
     */
    'SECOND_APPROVER_UNRECORDED',
] as const;

export type ReviewBiasSignalCode = (typeof REVIEW_BIAS_SIGNALS)[number];

/**
 * THE QUESTION THIS REPORT CANNOT ANSWER, named rather than approximated.
 *
 * `DIFF_EXPANSION` — "was the proposed content ever looked at before it was
 * approved?" It is NOT observable today, and the reason is worth stating
 * precisely rather than filing as a gap:
 *
 *   • `src/app/t/<slug>/(app)/agent-proposals/AgentProposalsClient.tsx` renders
 *     the whole payload unconditionally, in a `<pre>`. There is no expand, no
 *     collapse and no drawer, so there is no expansion EVENT to record even if
 *     something were listening.
 *   • Nothing is listening. The queue's read path writes no audit row and no
 *     automation event; the only rows a proposal ever produces are
 *     `AGENT_PROPOSAL_CREATED`, `…_APPROVED`, `…_REJECTED` and the two guard
 *     refusals. Every one of them is a DECISION. None is an ATTENTION.
 *   • `AgentProposal` carries no viewed-at, opened-by or scroll column, so
 *     there is nowhere to put the answer either.
 *
 * So the honest report is that the question is unanswerable, and it is carried
 * OUT of this module as a code the surface renders — not left silent, and not
 * replaced by a proxy. The tempting proxies are all worse than nothing:
 * time-to-decision is already reported on its own terms and does not become an
 * expansion signal by being renamed; payload SIZE against latency would let a
 * long proposal launder a fast approval; and a client-side "seen" ping would be
 * a self-report from the browser of the person being measured.
 *
 * `tests/guards/agent-proposal-review-observability.test.ts` reddens the day any
 * of the three facts above stops being true, so this declaration cannot outlive
 * its own reason.
 */
export const UNOBSERVABLE_REVIEW_QUESTIONS = ['DIFF_EXPANSION'] as const;

export type UnobservableReviewQuestion = (typeof UNOBSERVABLE_REVIEW_QUESTIONS)[number];

/** What the signal is about. */
export type SignalScope = 'REVIEWER' | 'AGENT';

/**
 * One fired pattern.
 *
 * Every field is a code, an id, or a number. Nothing here carries proposal
 * content, a rationale or a payload — the same contract the guard rule ids keep,
 * and the reason this shape can go straight into a plaintext audit row.
 */
export interface ReviewBiasSignal {
    code: ReviewBiasSignalCode;
    scope: SignalScope;
    /** The reviewer's userId or the agent's id. `null` only for unattributed agents. */
    subjectId: string | null;
    /** What was measured. Seconds, a count, or a rate depending on the code. */
    observed: number;
    /** What it was measured against. */
    threshold: number;
    /** How many decisions stood behind it — the denominator, always. */
    sampleSize: number;
}

// ─── Inputs ─────────────────────────────────────────────────────────

/** A decided proposal, reduced to the columns this arithmetic needs. */
export interface ReviewObservation {
    proposalId: string;
    /** `null` for a proposal written before the agent register existed. */
    agentId: string | null;
    reviewerUserId: string;
    /** Epoch ms — when the agent proposed. */
    proposedAtMs: number;
    /** Epoch ms — when the human decided. */
    decidedAtMs: number;
    approved: boolean;
    /**
     * The approval rung the agent's policy card pinned at propose time, or
     * `null` when no card governed it (or the row predates pinning). NOT
     * re-read from today's card — that would reconstruct today's rules wearing
     * an old version number.
     */
    approvalRung: ApprovalRung | null;
}

// ─── Outputs ────────────────────────────────────────────────────────

/** Estimates were refused, and this is why — a value, never an omission. */
export interface RefusedEstimates {
    reported: false;
    reason: 'INSUFFICIENT_SAMPLE';
    /** Decisions this subject actually has. */
    observed: number;
    /** Decisions it would take. */
    required: number;
}

/** Estimates were reported. Every rate arrives with its denominator alongside. */
export interface ReportedEstimates {
    reported: true;
    /** approved / decided, 0..1. */
    approvalRate: number;
    /** Nearest-rank p50 of decision latency, seconds. */
    medianSeconds: number;
    /** Nearest-rank p10. The lower tail is the informative one — see the header. */
    p10Seconds: number;
}

export type Estimates = RefusedEstimates | ReportedEstimates;

/** A run of approvals by one reviewer, close enough together to be one act. */
export interface ApprovalBurst {
    reviewerUserId: string;
    startedAtMs: number;
    endedAtMs: number;
    /** How many approvals. Always >= BULK_APPROVAL_THRESHOLD. */
    count: number;
    /** The proposals in it, in decision order. */
    proposalIds: string[];
}

export interface ReviewerReport {
    reviewerUserId: string;
    /** Counts. Observations — always reported. */
    decided: number;
    approved: number;
    rejected: number;
    /**
     * The fastest decision this reviewer made, in seconds. An OBSERVATION, so
     * it is reported at n = 1 while `estimates` is still refusing. `null` only
     * when there are no decisions at all.
     */
    fastestSeconds: number | null;
    /** Refused below `MIN_REPORTABLE_SAMPLE`, visibly. */
    estimates: Estimates;
    /** Observations. Not gated by sample size — see `BULK_APPROVAL_THRESHOLD`. */
    bursts: ApprovalBurst[];
}

export interface AgentReport {
    /** `null` groups every proposal written before the agent register existed. */
    agentId: string | null;
    decided: number;
    approved: number;
    rejected: number;
    /** How many of this agent's decided proposals pinned each rung. */
    rungCounts: Record<string, number>;
    /** How many were pinned SECOND_APPROVER — every one of them unrecorded. */
    secondApproverDeclared: number;
    /** How many distinct humans decided this agent's proposals. */
    distinctReviewers: number;
    estimates: Estimates;
}

export interface ReviewQualityReport {
    /** Decisions the report stands on. Zero is a legible answer, not an error. */
    decided: number;
    approved: number;
    rejected: number;
    reviewers: ReviewerReport[];
    agents: AgentReport[];
    /** Every fired pattern, in a stable order so a digest over it is stable. */
    signals: ReviewBiasSignal[];
    /**
     * What this report CANNOT answer. Carried in the payload rather than left
     * to a footnote, because a metric surface that is silent about its blind
     * spot reads as a surface that has none.
     */
    unobservable: readonly UnobservableReviewQuestion[];
}

// ─── Arithmetic ─────────────────────────────────────────────────────

/**
 * NEAREST-RANK percentile over an ascending array. `p` in 0..100.
 *
 * Nearest-rank and not linear interpolation, for one reason that matters more
 * than the statistics: every value this returns is a decision that actually
 * happened. An interpolated p50 of 7.5 seconds over the pair (5, 10) is a
 * latency no reviewer ever produced, and the first question an admin asks a
 * finding is "show me the one". Interpolation makes that question unanswerable.
 */
export function nearestRankPercentile(ascending: readonly number[], p: number): number {
    if (ascending.length === 0) throw new Error('nearestRankPercentile: empty sample');
    const rank = Math.ceil((p / 100) * ascending.length);
    const index = Math.min(Math.max(rank, 1), ascending.length) - 1;
    return ascending[index];
}

/** Decision latency in whole-ish seconds (fractional, not rounded). */
export function latencySeconds(o: ReviewObservation): number {
    return (o.decidedAtMs - o.proposedAtMs) / 1000;
}

/**
 * The MAXIMAL, NON-OVERLAPPING runs of approvals inside the window.
 *
 * The window is INCLUSIVE at both ends: `last - first <= BULK_APPROVAL_WINDOW_MS`.
 * A run of exactly `BULK_APPROVAL_THRESHOLD` spanning exactly the window fires.
 * A run of one fewer does not, however tightly packed — the boundary is the
 * behaviour, not an implementation detail, which is why it is the test.
 *
 * Maximal: the run is extended as far as the window allows before it is
 * emitted, so six approvals in forty seconds is ONE burst of six rather than
 * two overlapping bursts of five. Non-overlapping: scanning resumes after the
 * emitted run, so the same approval is never counted into two bursts. An admin
 * reading "3 bursts" needs that to mean three distinct occasions.
 *
 * Ties are stable: equal timestamps keep input order, so a burst's
 * `proposalIds` are reproducible across runs.
 */
export function findApprovalBursts(
    reviewerUserId: string,
    approvals: readonly ReviewObservation[],
): ApprovalBurst[] {
    const sorted = [...approvals].sort((a, b) => a.decidedAtMs - b.decidedAtMs);
    const bursts: ApprovalBurst[] = [];
    let i = 0;
    while (i < sorted.length) {
        let j = i;
        while (
            j + 1 < sorted.length &&
            sorted[j + 1].decidedAtMs - sorted[i].decidedAtMs <= BULK_APPROVAL_WINDOW_MS
        ) {
            j += 1;
        }
        const count = j - i + 1;
        if (count >= BULK_APPROVAL_THRESHOLD) {
            bursts.push({
                reviewerUserId,
                startedAtMs: sorted[i].decidedAtMs,
                endedAtMs: sorted[j].decidedAtMs,
                count,
                proposalIds: sorted.slice(i, j + 1).map((o) => o.proposalId),
            });
            i = j + 1;
        } else {
            i += 1;
        }
    }
    return bursts;
}

/**
 * Estimates for one subject, or the visible refusal.
 *
 * The refusal is returned rather than thrown and rather than omitted, because
 * the caller has to be able to RENDER it. "4 of 10 decisions needed" and a
 * blank cell are different claims and only the first is true.
 */
export function estimatesFor(observations: readonly ReviewObservation[]): Estimates {
    if (observations.length < MIN_REPORTABLE_SAMPLE) {
        return {
            reported: false,
            reason: 'INSUFFICIENT_SAMPLE',
            observed: observations.length,
            required: MIN_REPORTABLE_SAMPLE,
        };
    }
    const latencies = observations.map(latencySeconds).sort((a, b) => a - b);
    const approved = observations.filter((o) => o.approved).length;
    return {
        reported: true,
        approvalRate: approved / observations.length,
        medianSeconds: nearestRankPercentile(latencies, 50),
        p10Seconds: nearestRankPercentile(latencies, 10),
    };
}

function groupBy<K>(
    observations: readonly ReviewObservation[],
    key: (o: ReviewObservation) => K,
): Map<K, ReviewObservation[]> {
    const out = new Map<K, ReviewObservation[]>();
    for (const o of observations) {
        const k = key(o);
        const bucket = out.get(k);
        if (bucket) bucket.push(o);
        else out.set(k, [o]);
    }
    return out;
}

/**
 * The whole report over one tenant's decided proposals.
 *
 * `signals` is sorted by (code, subjectId, observed) so two runs over the same
 * observations produce byte-identical output. That is load-bearing for the
 * alert seam, which deduplicates on a digest of this list: an unstable order
 * would make every read look like a new finding.
 */
export function computeReviewQuality(
    observations: readonly ReviewObservation[],
): ReviewQualityReport {
    const signals: ReviewBiasSignal[] = [];

    const reviewers: ReviewerReport[] = [];
    for (const [reviewerUserId, own] of groupBy(observations, (o) => o.reviewerUserId)) {
        const approvals = own.filter((o) => o.approved);
        const latencies = own.map(latencySeconds).sort((a, b) => a - b);
        const bursts = findApprovalBursts(reviewerUserId, approvals);
        const estimates = estimatesFor(own);

        reviewers.push({
            reviewerUserId,
            decided: own.length,
            approved: approvals.length,
            rejected: own.length - approvals.length,
            fastestSeconds: latencies.length > 0 ? latencies[0] : null,
            estimates,
            bursts,
        });

        for (const burst of bursts) {
            signals.push({
                code: 'BULK_APPROVAL_BURST',
                scope: 'REVIEWER',
                subjectId: reviewerUserId,
                observed: burst.count,
                threshold: BULK_APPROVAL_THRESHOLD,
                sampleSize: own.length,
            });
        }

        // Per-decision, so it fires at n = 1. The COUNT of implausible decisions
        // is the observed quantity: one is a slip, forty is a policy.
        const implausible = own.filter((o) => latencySeconds(o) < IMPLAUSIBLE_DECISION_SECONDS);
        if (implausible.length > 0) {
            signals.push({
                code: 'IMPLAUSIBLY_FAST_DECISION',
                scope: 'REVIEWER',
                subjectId: reviewerUserId,
                observed: implausible.length,
                threshold: IMPLAUSIBLE_DECISION_SECONDS,
                sampleSize: own.length,
            });
        }

        // The two ESTIMATE-shaped signals fire only where the estimate was
        // reportable. Reading a median off four decisions and alerting on it is
        // the noise this module refuses to make.
        if (estimates.reported) {
            if (estimates.medianSeconds < FAST_MEDIAN_SECONDS) {
                signals.push({
                    code: 'FAST_MEDIAN_REVIEW',
                    scope: 'REVIEWER',
                    subjectId: reviewerUserId,
                    observed: estimates.medianSeconds,
                    threshold: FAST_MEDIAN_SECONDS,
                    sampleSize: own.length,
                });
            }
            if (estimates.approvalRate === 1) {
                signals.push({
                    code: 'NEVER_REJECTED',
                    scope: 'REVIEWER',
                    subjectId: reviewerUserId,
                    observed: estimates.approvalRate,
                    threshold: 1,
                    sampleSize: own.length,
                });
            }
        }
    }

    const agents: AgentReport[] = [];
    for (const [agentId, own] of groupBy(observations, (o) => o.agentId)) {
        const rungCounts: Record<string, number> = {};
        for (const o of own) {
            const rung = o.approvalRung ?? 'UNPINNED';
            rungCounts[rung] = (rungCounts[rung] ?? 0) + 1;
        }
        const secondApproverDeclared = rungCounts.SECOND_APPROVER ?? 0;
        const approved = own.filter((o) => o.approved).length;

        agents.push({
            agentId,
            decided: own.length,
            approved,
            rejected: own.length - approved,
            rungCounts,
            secondApproverDeclared,
            distinctReviewers: new Set(own.map((o) => o.reviewerUserId)).size,
            estimates: estimatesFor(own),
        });

        if (secondApproverDeclared > 0) {
            signals.push({
                code: 'SECOND_APPROVER_UNRECORDED',
                scope: 'AGENT',
                subjectId: agentId,
                observed: secondApproverDeclared,
                threshold: 0,
                sampleSize: own.length,
            });
        }
    }

    reviewers.sort((a, b) => a.reviewerUserId.localeCompare(b.reviewerUserId));
    agents.sort((a, b) => (a.agentId ?? '').localeCompare(b.agentId ?? ''));
    signals.sort(
        (a, b) =>
            a.code.localeCompare(b.code) ||
            (a.subjectId ?? '').localeCompare(b.subjectId ?? '') ||
            a.observed - b.observed,
    );

    const approvedTotal = observations.filter((o) => o.approved).length;
    return {
        decided: observations.length,
        approved: approvedTotal,
        rejected: observations.length - approvedTotal,
        reviewers,
        agents,
        signals,
        unobservable: UNOBSERVABLE_REVIEW_QUESTIONS,
    };
}

/**
 * A stable, content-free string identifying WHICH patterns are outstanding.
 *
 * Hashed by the caller into the alert's dedupe key. Deliberately excludes
 * `observed` and `sampleSize`: those tick up on every new decision, so
 * including them would make the digest change constantly and the dedupe would
 * suppress nothing. What an alert is about is (code, subject) — that a
 * reviewer's burst count went from 3 to 4 is the same standing finding.
 */
export function signalIdentity(signals: readonly ReviewBiasSignal[]): string {
    return [...new Set(signals.map((s) => `${s.code}:${s.subjectId ?? '-'}`))].sort().join('|');
}
