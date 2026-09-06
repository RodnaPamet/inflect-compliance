/**
 * Review-quality metrics — the arithmetic, against a fixture whose answer was
 * worked out by hand.
 *
 * EVERY expected value below is computed in the comment beside it from the
 * fixture's own numbers. None of it was read off what the code returned. That
 * distinction is the whole point of this file: a test that asserts the
 * implementation's output agrees with itself would go green over a median that
 * silently became a mean, an approval rate that silently became a share of ALL
 * proposals rather than decided ones, and a burst detector that had stopped
 * detecting.
 *
 * The three shapes under test are the three the surface leads with:
 *   • time-to-decision percentiles, nearest-rank
 *   • per-reviewer and per-agent approval rate, always with its denominator
 *   • the bulk-approval burst, AT the threshold and at one below it
 *
 * The boundary is a first-class subject here, not an afterthought. A burst
 * detector that fires at four is a detector that cries wolf on a normal
 * afternoon; one that only fires at six is a detector that misses the thing it
 * was built for. So both sides of N are asserted, and both sides of the window,
 * at the helper AND through the whole report — the surface reads the report, so
 * a boundary that is only right in the helper is a boundary the product does
 * not have.
 */
import {
    BULK_APPROVAL_THRESHOLD,
    BULK_APPROVAL_WINDOW_MS,
    FAST_MEDIAN_SECONDS,
    IMPLAUSIBLE_DECISION_SECONDS,
    MIN_REPORTABLE_SAMPLE,
    computeReviewQuality,
    estimatesFor,
    findApprovalBursts,
    nearestRankPercentile,
    signalIdentity,
    type ReviewObservation,
} from '@/lib/agentic/automation-bias';

/** An arbitrary but fixed epoch, so nothing here depends on when it runs. */
const T0 = 1_756_000_000_000;

/**
 * Build one decided proposal.
 *
 * `latencySeconds` is the gap between propose and decide, which is what every
 * percentile below is over. `decidedAtMs` is set independently so a fixture can
 * hold latency constant while moving the decisions closer together or further
 * apart — the two axes the burst detector and the percentile read separately.
 */
function obs(
    over: Partial<ReviewObservation> & {
        proposalId: string;
        reviewerUserId: string;
        decidedAtMs: number;
        latencySeconds: number;
    },
): ReviewObservation {
    const { latencySeconds, ...rest } = over;
    return {
        agentId: 'agent-alpha',
        approved: true,
        approvalRung: null,
        proposedAtMs: rest.decidedAtMs - latencySeconds * 1000,
        ...rest,
    };
}

// ─────────────────────────────────────────────────────────────────────
// The seeded fixture, and the answer worked out by hand.
// ─────────────────────────────────────────────────────────────────────

/**
 * `u-careful` — 12 decisions, 9 approved, 3 rejected, decisions ten minutes
 * apart so no window can hold two of them.
 *
 * Latencies, in the order they are built and therefore ASCENDING:
 *   40 45 50 55 60 65 70 75 80 85 90 95
 *
 * Hand-computed, n = 12:
 *   p50 rank = ceil(0.50 × 12) = 6  → the 6th smallest → 65
 *   p10 rank = ceil(0.10 × 12) = 2  → the 2nd smallest → 45
 *   approval rate = 9 / 12 = 0.75
 *   fastest = 40
 * None below IMPLAUSIBLE_DECISION_SECONDS (5); the median (65) is above
 * FAST_MEDIAN_SECONDS (30); the rate is not 1. So: no signals from this
 * reviewer at all.
 */
const CAREFUL_LATENCIES = [40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
/** The three that were rejected, by their latency — chosen to sit mid-run. */
const CAREFUL_REJECTED = new Set([55, 75, 95]);

const carefulObservations: ReviewObservation[] = CAREFUL_LATENCIES.map((latency, i) =>
    obs({
        proposalId: `p-careful-${i}`,
        reviewerUserId: 'u-careful',
        decidedAtMs: T0 + i * 600_000, // ten minutes apart
        latencySeconds: latency,
        approved: !CAREFUL_REJECTED.has(latency),
        approvalRung: 'SECOND_APPROVER',
    }),
);

/**
 * `u-stamp` — the rubber stamp. 10 approvals, none rejected, every one decided
 * three seconds after it was proposed, five seconds apart.
 *
 * Hand-computed, n = 10:
 *   span = 9 × 5 000 ms = 45 000 ms ≤ 60 000 → ONE burst, count 10
 *   p50 rank = ceil(0.50 × 10) = 5 → the 5th smallest of ten 3s → 3
 *   approval rate = 10 / 10 = 1
 *   every latency 3 < 5 → 10 implausibly fast decisions
 * n = 10 is exactly MIN_REPORTABLE_SAMPLE, so the estimate-class signals are
 * reportable and fire: FAST_MEDIAN_REVIEW (3 < 30) and NEVER_REJECTED (1 = 1).
 */
const stampObservations: ReviewObservation[] = Array.from({ length: 10 }, (_, i) =>
    obs({
        proposalId: `p-stamp-${i}`,
        reviewerUserId: 'u-stamp',
        decidedAtMs: T0 + i * 5_000,
        latencySeconds: 3,
        agentId: 'agent-beta',
        approvalRung: 'SINGLE_APPROVER',
    }),
);

/**
 * `u-new` — 4 decisions, 3 approved. Below MIN_REPORTABLE_SAMPLE, so every
 * ESTIMATE is refused; `fastestSeconds` is an OBSERVATION and is still 12.
 */
const NEW_LATENCIES = [12, 20, 30, 40];
const newObservations: ReviewObservation[] = NEW_LATENCIES.map((latency, i) =>
    obs({
        proposalId: `p-new-${i}`,
        reviewerUserId: 'u-new',
        decidedAtMs: T0 + 10_000_000 + i * 600_000,
        latencySeconds: latency,
        approved: latency !== 40,
    }),
);

const FIXTURE = [...carefulObservations, ...stampObservations, ...newObservations];

describe('the fixture report, against numbers computed by hand', () => {
    const report = computeReviewQuality(FIXTURE);

    it('counts the whole population with its denominator', () => {
        // 12 + 10 + 4 = 26 decided; approved 9 + 10 + 3 = 22; rejected 3 + 0 + 1 = 4.
        expect(report.decided).toBe(26);
        expect(report.approved).toBe(22);
        expect(report.rejected).toBe(4);
    });

    it('reports the careful reviewer at the hand-computed percentiles and rate', () => {
        const careful = report.reviewers.find((r) => r.reviewerUserId === 'u-careful');
        expect(careful).toBeDefined();
        expect(careful?.decided).toBe(12);
        expect(careful?.approved).toBe(9);
        expect(careful?.rejected).toBe(3);
        expect(careful?.fastestSeconds).toBe(40);
        expect(careful?.bursts).toEqual([]);
        expect(careful?.estimates).toEqual({
            reported: true,
            approvalRate: 0.75, // 9 / 12
            medianSeconds: 65, // 6th smallest of the twelve
            p10Seconds: 45, // 2nd smallest of the twelve
        });
    });

    it('reports the rubber stamp as one burst of ten, not two overlapping fives', () => {
        const stamp = report.reviewers.find((r) => r.reviewerUserId === 'u-stamp');
        expect(stamp?.bursts).toHaveLength(1);
        expect(stamp?.bursts[0].count).toBe(10);
        expect(stamp?.bursts[0].startedAtMs).toBe(T0);
        expect(stamp?.bursts[0].endedAtMs).toBe(T0 + 9 * 5_000);
        expect(stamp?.estimates).toEqual({
            reported: true,
            approvalRate: 1, // 10 / 10
            medianSeconds: 3,
            p10Seconds: 3,
        });
    });

    it('groups by agent and carries the rung each proposal was PINNED to', () => {
        const alpha = report.agents.find((a) => a.agentId === 'agent-alpha');
        // 12 from u-careful (pinned SECOND_APPROVER) + 4 from u-new (unpinned).
        expect(alpha?.decided).toBe(16);
        expect(alpha?.rungCounts).toEqual({ SECOND_APPROVER: 12, UNPINNED: 4 });
        expect(alpha?.secondApproverDeclared).toBe(12);
        expect(alpha?.distinctReviewers).toBe(2);

        const beta = report.agents.find((a) => a.agentId === 'agent-beta');
        expect(beta?.rungCounts).toEqual({ SINGLE_APPROVER: 10 });
        expect(beta?.secondApproverDeclared).toBe(0);
    });

    it('names exactly the five patterns the fixture was built to trip', () => {
        // Sorted by (code, subject, observed) — see `computeReviewQuality`.
        expect(report.signals).toEqual([
            {
                code: 'BULK_APPROVAL_BURST',
                scope: 'REVIEWER',
                subjectId: 'u-stamp',
                observed: 10,
                threshold: BULK_APPROVAL_THRESHOLD,
                sampleSize: 10,
            },
            {
                code: 'FAST_MEDIAN_REVIEW',
                scope: 'REVIEWER',
                subjectId: 'u-stamp',
                observed: 3,
                threshold: FAST_MEDIAN_SECONDS,
                sampleSize: 10,
            },
            {
                code: 'IMPLAUSIBLY_FAST_DECISION',
                scope: 'REVIEWER',
                subjectId: 'u-stamp',
                observed: 10,
                threshold: IMPLAUSIBLE_DECISION_SECONDS,
                sampleSize: 10,
            },
            {
                code: 'NEVER_REJECTED',
                scope: 'REVIEWER',
                subjectId: 'u-stamp',
                observed: 1,
                threshold: 1,
                sampleSize: 10,
            },
            {
                code: 'SECOND_APPROVER_UNRECORDED',
                scope: 'AGENT',
                subjectId: 'agent-alpha',
                observed: 12,
                threshold: 0,
                sampleSize: 16,
            },
        ]);
    });
});

// ─────────────────────────────────────────────────────────────────────
// The boundary. This is the test.
// ─────────────────────────────────────────────────────────────────────

/** N approvals, `gapMs` apart, by one reviewer. */
function approvalsAt(times: readonly number[], reviewerUserId = 'u-b'): ReviewObservation[] {
    return times.map((t, i) =>
        obs({
            proposalId: `p-${i}`,
            reviewerUserId,
            decidedAtMs: T0 + t,
            latencySeconds: 120, // well clear of every latency threshold
        }),
    );
}

describe('the bulk-approval threshold fires at N and not at N-1', () => {
    it('is 5 approvals in 60 seconds — stated, so a silent re-tune is visible here', () => {
        expect(BULK_APPROVAL_THRESHOLD).toBe(5);
        expect(BULK_APPROVAL_WINDOW_MS).toBe(60_000);
    });

    it('N approvals inside the window fire exactly one burst', () => {
        // Five, one second apart: span 4 000 ms, well inside 60 000.
        const bursts = findApprovalBursts('u-b', approvalsAt([0, 1_000, 2_000, 3_000, 4_000]));
        expect(bursts).toHaveLength(1);
        expect(bursts[0].count).toBe(5);
        expect(bursts[0].proposalIds).toEqual(['p-0', 'p-1', 'p-2', 'p-3', 'p-4']);
    });

    it('N-1 approvals inside the same window fire nothing', () => {
        // Four, packed as tightly as the five above. The ONLY difference from
        // the case above is the count — not the spacing, not the latency, not
        // the reviewer. So a detector that fires here is off by one and
        // nothing else can explain it.
        const bursts = findApprovalBursts('u-b', approvalsAt([0, 1_000, 2_000, 3_000]));
        expect(bursts).toEqual([]);
    });

    it('N spanning EXACTLY the window fire — the window is inclusive', () => {
        const bursts = findApprovalBursts(
            'u-b',
            approvalsAt([0, 15_000, 30_000, 45_000, BULK_APPROVAL_WINDOW_MS]),
        );
        expect(bursts).toHaveLength(1);
        expect(bursts[0].count).toBe(5);
    });

    it('N spanning one millisecond more than the window fire nothing', () => {
        const bursts = findApprovalBursts(
            'u-b',
            approvalsAt([0, 15_000, 30_000, 45_000, BULK_APPROVAL_WINDOW_MS + 1]),
        );
        expect(bursts).toEqual([]);
    });

    it('the same boundary holds through the whole report, not just the helper', () => {
        // The surface reads the report. A boundary that is only right in the
        // helper is a boundary the product does not have.
        const atN = computeReviewQuality(approvalsAt([0, 1_000, 2_000, 3_000, 4_000]));
        expect(atN.signals.map((s) => s.code)).toEqual(['BULK_APPROVAL_BURST']);
        expect(atN.reviewers[0].bursts[0].count).toBe(5);

        const belowN = computeReviewQuality(approvalsAt([0, 1_000, 2_000, 3_000]));
        expect(belowN.signals).toEqual([]);
        expect(belowN.reviewers[0].bursts).toEqual([]);
    });

    it('a rejection inside the window does not count toward the burst', () => {
        // Three approvals and two rejections, all five inside the window. A
        // detector counting DECISIONS rather than APPROVALS would fire; the
        // pattern is "approved without looking", and a rejection is not that.
        const mixed = approvalsAt([0, 1_000, 2_000, 3_000, 4_000]).map((o, i) => ({
            ...o,
            approved: i < 3,
        }));
        expect(findApprovalBursts('u-b', mixed.filter((o) => o.approved))).toEqual([]);
        expect(computeReviewQuality(mixed).reviewers[0].bursts).toEqual([]);
    });

    it('two clusters an hour apart are two bursts, and neither is double-counted', () => {
        const bursts = findApprovalBursts(
            'u-b',
            approvalsAt([
                0, 1_000, 2_000, 3_000, 4_000,
                3_600_000, 3_601_000, 3_602_000, 3_603_000, 3_604_000,
            ]),
        );
        expect(bursts.map((b) => b.count)).toEqual([5, 5]);
        // Ten approvals, ten proposal ids across the two bursts, no overlap.
        const ids = bursts.flatMap((b) => b.proposalIds);
        expect(new Set(ids).size).toBe(10);
    });
});

// ─────────────────────────────────────────────────────────────────────
// The refusal, and that it is visible.
// ─────────────────────────────────────────────────────────────────────

describe('below the minimum sample the estimate is refused, out loud', () => {
    const nine = Array.from({ length: 9 }, (_, i) =>
        obs({
            proposalId: `p-9-${i}`,
            reviewerUserId: 'u-thin',
            decidedAtMs: T0 + i * 3_600_000, // an hour apart: no burst
            latencySeconds: 2, // implausibly fast, every one of them
        }),
    );

    it('the floor is 10, and it is derived: one decision must not move a rate by >10pp', () => {
        expect(MIN_REPORTABLE_SAMPLE).toBe(10);
        expect(1 / MIN_REPORTABLE_SAMPLE).toBeLessThanOrEqual(0.1);
        expect(1 / (MIN_REPORTABLE_SAMPLE - 1)).toBeGreaterThan(0.1);
    });

    it('refuses with the numbers, rather than omitting the field', () => {
        // A blank cell and "9 of 10 decisions needed" are different claims, and
        // only one of them is true. The refusal is a VALUE.
        expect(estimatesFor(nine)).toEqual({
            reported: false,
            reason: 'INSUFFICIENT_SAMPLE',
            observed: 9,
            required: 10,
        });
    });

    it('reports at exactly the floor', () => {
        const ten = [
            ...nine,
            obs({
                proposalId: 'p-9-9',
                reviewerUserId: 'u-thin',
                decidedAtMs: T0 + 9 * 3_600_000,
                latencySeconds: 2,
            }),
        ];
        const estimates = estimatesFor(ten);
        expect(estimates.reported).toBe(true);
        // Ten identical 2s latencies — every percentile is 2, and the rate is 1.
        expect(estimates).toEqual({
            reported: true,
            approvalRate: 1,
            medianSeconds: 2,
            p10Seconds: 2,
        });
    });

    it('still reports the OBSERVATIONS at n = 1', () => {
        const one = computeReviewQuality([
            obs({
                proposalId: 'p-one',
                reviewerUserId: 'u-one',
                decidedAtMs: T0,
                latencySeconds: 1,
            }),
        ]);
        const only = one.reviewers[0];
        // The fastest decision is a fact about something that happened. It does
        // not become unknowable because there is only one of it.
        expect(only.fastestSeconds).toBe(1);
        expect(only.decided).toBe(1);
        expect(only.estimates.reported).toBe(false);
        // And the observation-class signal fires at n = 1.
        expect(one.signals.map((s) => s.code)).toEqual(['IMPLAUSIBLY_FAST_DECISION']);
    });

    it('gates the ESTIMATE-class signals below the floor and NOT the observation ones', () => {
        // Six decisions, all approved, all two seconds. Every threshold in the
        // module is tripped by these numbers. Only the observation-class signal
        // may fire: a 100% approval rate over six decisions is not a rate, and
        // a median over six 2s decisions is not a median.
        const six = nine.slice(0, 6);
        const codes = computeReviewQuality(six).signals.map((s) => s.code);
        expect(codes).toEqual(['IMPLAUSIBLY_FAST_DECISION']);
        expect(codes).not.toContain('NEVER_REJECTED');
        expect(codes).not.toContain('FAST_MEDIAN_REVIEW');
    });

    it('no reported rate ever arrives without its denominator', () => {
        // The invariant behind every shape above: an admin cannot be shown a
        // percentage whose sample size is not on the same object.
        for (const r of computeReviewQuality(FIXTURE).reviewers) {
            expect(typeof r.decided).toBe('number');
            if (r.estimates.reported) expect(r.decided).toBeGreaterThanOrEqual(MIN_REPORTABLE_SAMPLE);
        }
        for (const s of computeReviewQuality(FIXTURE).signals) {
            expect(s.sampleSize).toBeGreaterThan(0);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────
// The percentile itself.
// ─────────────────────────────────────────────────────────────────────

describe('nearest-rank percentile', () => {
    it('returns a value that actually occurred, at the hand-computed rank', () => {
        // n = 5. p50 rank = ceil(2.5) = 3 → the 3rd smallest → 30.
        // Linear interpolation would give 30 here too, so the discriminating
        // case is n = 4: rank = ceil(2) = 2 → 20, where interpolation gives 25
        // — a latency nobody produced.
        expect(nearestRankPercentile([10, 20, 30, 40, 50], 50)).toBe(30);
        expect(nearestRankPercentile([10, 20, 30, 40], 50)).toBe(20);
        // p10 over four: rank = ceil(0.4) = 1 → the smallest.
        expect(nearestRankPercentile([10, 20, 30, 40], 10)).toBe(10);
        // p100 is the largest — the clamp must not shave the top off.
        expect(nearestRankPercentile([10, 20, 30, 40], 100)).toBe(40);
    });

    it('refuses an empty sample rather than inventing one', () => {
        expect(() => nearestRankPercentile([], 50)).toThrow(/empty sample/);
    });
});

// ─────────────────────────────────────────────────────────────────────
// Stability — the alert seam depends on it.
// ─────────────────────────────────────────────────────────────────────

describe('the signal identity is stable across input order', () => {
    it('two shuffles of the same observations produce one identity', () => {
        const shuffled = [...FIXTURE].reverse();
        expect(signalIdentity(computeReviewQuality(shuffled).signals)).toBe(
            signalIdentity(computeReviewQuality(FIXTURE).signals),
        );
    });

    it('and the signal LIST itself is sorted, not merely in the order groups were seen', () => {
        // The identity is sorted on its way out, so it stays stable over an
        // UNSORTED list — which makes it the wrong assertion for this claim.
        // The list is what the surface renders and what a future export
        // serialises, so its order is pinned directly, over an input whose
        // natural grouping order is the REVERSE of the sorted one: two rubber
        // stamps, the alphabetically-later one first.
        const stampAs = (userId: string) =>
            stampObservations.map((o) => ({
                ...o,
                proposalId: `${o.proposalId}-${userId}`,
                reviewerUserId: userId,
            }));
        const groupedZFirst = [...stampAs('z-stamp'), ...stampAs('a-stamp')];
        const subjects = computeReviewQuality(groupedZFirst).signals.map(
            (s) => `${s.code}/${s.subjectId}`,
        );
        expect(subjects).toEqual([...subjects].sort());
        // …and the first entry is the alphabetically FIRST reviewer, not the
        // one whose observations happened to arrive first.
        expect(subjects[0]).toBe('BULK_APPROVAL_BURST/a-stamp');
    });

    it('and a new subject crossing a threshold changes it', () => {
        // The dedupe must not swallow a NEW finding. Adding a second rubber
        // stamp is a different (code, subject) pair, so the identity moves.
        const second = stampObservations.map((o) => ({
            ...o,
            proposalId: `${o.proposalId}-b`,
            reviewerUserId: 'u-stamp-2',
        }));
        expect(signalIdentity(computeReviewQuality([...FIXTURE, ...second]).signals)).not.toBe(
            signalIdentity(computeReviewQuality(FIXTURE).signals),
        );
    });

    it('but a standing finding whose COUNT ticked up keeps its identity', () => {
        // Otherwise the dedupe suppresses nothing and the alert becomes noise.
        const oneMore = [
            ...FIXTURE,
            obs({
                proposalId: 'p-stamp-extra',
                reviewerUserId: 'u-stamp',
                decidedAtMs: T0 + 10 * 5_000,
                latencySeconds: 3,
                agentId: 'agent-beta',
                approvalRung: 'SINGLE_APPROVER',
            }),
        ];
        expect(signalIdentity(computeReviewQuality(oneMore).signals)).toBe(
            signalIdentity(computeReviewQuality(FIXTURE).signals),
        );
    });
});
