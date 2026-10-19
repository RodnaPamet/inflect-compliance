/**
 * The arithmetic of internal audit's sampling of the auditor's workpapers
 * (#3677, step 3d) — pure, no database: which workpapers are drawn, who is
 * asked, what an answer may say, and what the agreement rate counts.
 */
import {
    assignReviewer,
    assignmentPoolDigest,
    drawWorkpapersForReview,
    dissentFindingProposal,
    effectiveSamplePercent,
    isDrawnForReview,
    isEligibleReviewer,
    reviewerDrawEpoch,
    WORKPAPER_REVIEW_DEFAULT_SAMPLE_PERCENT,
    WORKPAPER_REVIEW_DISSENT_CODES,
    WORKPAPER_REVIEW_FINDING_SOURCE_KIND,
    workpaperReviewEpoch,
    workpaperReviewRate,
    workpaperReviewSeedFingerprint,
    type MemberFacts,
} from '@/lib/agentic/workpaper-review-sampling';
import { RecordWorkpaperReviewSchema } from '@/app-layer/schemas/audit-workpaper-sample-review.schemas';
import { selectSample } from '@/lib/agentic/proposal-sampling';

const SEED = 'unit-seed';
const ids = (n: number, prefix = 'wp') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}_${i}`, periodLabel: i % 2 ? '2026-07' : '2026-Q3' }));

describe('the epoch is fixed by the workpaper’s period, never the run date', () => {
    it('is a fixed prefix and the period label', () => {
        expect(workpaperReviewEpoch('2026-07')).toBe('audit-workpaper-review@2026-07');
        expect(workpaperReviewEpoch('2026-Q3')).toBe('audit-workpaper-review@2026-Q3');
    });

    it('the seed fingerprint names the seed without being it', () => {
        const fp = workpaperReviewSeedFingerprint(SEED);
        expect(fp).toMatch(/^[0-9a-f]{64}$/);
        expect(fp).not.toContain(SEED);
        expect(workpaperReviewSeedFingerprint('another')).not.toBe(fp);
    });
});

describe('the draw: a keyed decision per workpaper, against the tenant’s rate', () => {
    it('draws every workpaper at 100%, the pilot’s rate and the default', () => {
        expect(WORKPAPER_REVIEW_DEFAULT_SAMPLE_PERCENT).toBe(100);
        const all = ids(50);
        expect(drawWorkpapersForReview(all, { seed: SEED, samplePercent: 100 })).toEqual(all);
    });

    it('reads a missing or out-of-range rate as 100 — never as less', () => {
        for (const bad of [null, undefined, 0, -5, 101, 1.5, Number.NaN]) {
            expect(effectiveSamplePercent(bad as number | null | undefined)).toBe(100);
        }
        expect(effectiveSamplePercent(1)).toBe(1);
        expect(effectiveSamplePercent(37)).toBe(37);
    });

    it('is reproducible from (seed, epoch, workpaper, rate), and a different seed draws differently', () => {
        const all = ids(200);
        const a = drawWorkpapersForReview(all, { seed: SEED, samplePercent: 30 });
        const b = drawWorkpapersForReview([...all].reverse(), { seed: SEED, samplePercent: 30 });
        expect(new Set(a.map((w) => w.id))).toEqual(new Set(b.map((w) => w.id)));
        const c = drawWorkpapersForReview(all, { seed: 'other-seed', samplePercent: 30 });
        expect(c.map((w) => w.id)).not.toEqual(a.map((w) => w.id));
    });

    it('decides each workpaper on its own: adding workpapers re-decides none already decided', () => {
        const first = ids(100);
        const grown = [...first, ...ids(100, 'later')];
        const before = new Set(drawWorkpapersForReview(first, { seed: SEED, samplePercent: 25 }).map((w) => w.id));
        const after = drawWorkpapersForReview(grown, { seed: SEED, samplePercent: 25 }).filter((w) => w.id.startsWith('wp_'));
        expect(new Set(after.map((w) => w.id))).toEqual(before);
    });

    it('is monotone in the rate: what a lower rate draws, every higher rate draws too', () => {
        const all = ids(300);
        const at = (p: number) => new Set(drawWorkpapersForReview(all, { seed: SEED, samplePercent: p }).map((w) => w.id));
        const low = at(20);
        const high = at(60);
        for (const id of low) expect(high.has(id)).toBe(true);
        expect(high.size).toBeGreaterThan(low.size);
    });

    it('draws close to the rate over a large population', () => {
        const all = ids(4000);
        const drawn = drawWorkpapersForReview(all, { seed: SEED, samplePercent: 10 }).length;
        expect(drawn).toBeGreaterThan(300);
        expect(drawn).toBeLessThan(500);
    });

    it('binds the epoch: the same workpaper id in another period is a fresh decision', () => {
        const decide = (period: string) =>
            Array.from({ length: 200 }, (_, i) =>
                isDrawnForReview({ seed: SEED, epoch: workpaperReviewEpoch(period), workpaperId: `wp_${i}`, samplePercent: 50 }),
            );
        expect(decide('2026-07')).not.toEqual(decide('2026-08'));
    });
});

describe('who is asked: a keyed draw among ACTIVE third-line members, never the auditor’s owner', () => {
    const OWNER = 'u-owner';
    const member = (userId: string, lineOfDefence: string | null, status = 'ACTIVE'): MemberFacts => ({ userId, lineOfDefence, status });
    const members = [
        member('u-third-a', 'THIRD'),
        member('u-third-b', 'THIRD'),
        member('u-third-c', 'THIRD'),
        member('u-second', 'SECOND'),
        member('u-first', 'FIRST'),
        member('u-undeclared', null),
        member('u-third-inactive', 'THIRD', 'DEACTIVATED'),
        member(OWNER, 'THIRD'),
    ];

    it('assigns only an ACTIVE THIRD-line member, never the owner even when the owner is THIRD-line', () => {
        const picked = new Set<string>();
        for (let i = 0; i < 200; i++) {
            const a = assignReviewer({ seed: SEED, epoch: workpaperReviewEpoch('2026-07'), workpaperId: `wp_${i}`, auditorOwnerUserId: OWNER, members });
            expect(a.unassignedReason).toBeNull();
            expect(a.poolSize).toBe(3);
            picked.add(a.assignedToUserId as string);
        }
        // Spread across the pool rather than landing on one person.
        expect(picked).toEqual(new Set(['u-third-a', 'u-third-b', 'u-third-c']));
    });

    it('is reproducible from the same epoch: the same pool always yields the same reviewer, in any order', () => {
        const input = { seed: SEED, epoch: workpaperReviewEpoch('2026-07'), workpaperId: 'wp_7', auditorOwnerUserId: OWNER };
        const a = assignReviewer({ ...input, members });
        const b = assignReviewer({ ...input, members: [...members].reverse() });
        expect(b).toEqual(a);
        // It IS the keyed sampler, over the pool, under the review epoch and the workpaper.
        const [expected] = selectSample(
            ['u-third-a', 'u-third-b', 'u-third-c'].map((id) => ({ id })),
            { seed: SEED, epoch: reviewerDrawEpoch(input.epoch, 'wp_7'), count: 1 },
        );
        expect(a.assignedToUserId).toBe(expected.id);
        expect(a.poolDigest).toBe(assignmentPoolDigest(['u-third-c', 'u-third-a', 'u-third-b']));
    });

    it('records UNASSIGNED with a named reason rather than dropping the item or asking somebody ineligible', () => {
        const base = { seed: SEED, epoch: workpaperReviewEpoch('2026-07'), workpaperId: 'wp_1' };
        expect(assignReviewer({ ...base, auditorOwnerUserId: OWNER, members: [member('u-second', 'SECOND')] })).toMatchObject({
            assignedToUserId: null,
            unassignedReason: 'NO_THIRD_LINE_MEMBER',
            poolSize: 0,
        });
        expect(assignReviewer({ ...base, auditorOwnerUserId: OWNER, members: [member(OWNER, 'THIRD')] })).toMatchObject({
            assignedToUserId: null,
            unassignedReason: 'ONLY_THIRD_LINE_MEMBER_OWNS_AUDITOR',
            poolSize: 0,
        });
        expect(assignReviewer({ ...base, auditorOwnerUserId: null, members })).toMatchObject({
            assignedToUserId: null,
            unassignedReason: 'AUDITOR_OWNER_UNKNOWN',
            poolSize: 0,
        });
    });

    it('one eligibility rule: ACTIVE, THIRD, and not the owner', () => {
        expect(isEligibleReviewer(member('u', 'THIRD'), OWNER)).toBe(true);
        expect(isEligibleReviewer(member(OWNER, 'THIRD'), OWNER)).toBe(false);
        expect(isEligibleReviewer(member('u', 'SECOND'), OWNER)).toBe(false);
        expect(isEligibleReviewer(member('u', null), OWNER)).toBe(false);
        expect(isEligibleReviewer(member('u', 'THIRD', 'DEACTIVATED'), OWNER)).toBe(false);
        expect(isEligibleReviewer(member('u', 'THIRD'), null)).toBe(false);
        expect(isEligibleReviewer(null, OWNER)).toBe(false);
    });
});

describe('an answer is stable codes, never prose', () => {
    it('accepts the three answers, a dissent naming codes from the vocabulary only', () => {
        expect(RecordWorkpaperReviewSchema.safeParse({ outcome: 'CONCURRED' }).success).toBe(true);
        expect(RecordWorkpaperReviewSchema.safeParse({ outcome: 'INDETERMINATE' }).success).toBe(true);
        expect(
            RecordWorkpaperReviewSchema.safeParse({ outcome: 'DISSENTED', dissentCodes: [...WORKPAPER_REVIEW_DISSENT_CODES] }).success,
        ).toBe(true);
    });

    it.each([
        ['prose as a code', { outcome: 'DISSENTED', dissentCodes: ['the leaver in March was missed'] }],
        ['a note beside the answer', { outcome: 'CONCURRED', note: 'looks fine' }],
        ['a dissent with no code', { outcome: 'DISSENTED' }],
        ['a dissent with an empty list', { outcome: 'DISSENTED', dissentCodes: [] }],
        ['a code with no dissent', { outcome: 'INDETERMINATE', dissentCodes: ['EXCEPTION_MISSED'] }],
        ['a code named twice', { outcome: 'DISSENTED', dissentCodes: ['EXCEPTION_MISSED', 'EXCEPTION_MISSED'] }],
        ['PENDING as an answer', { outcome: 'PENDING' }],
    ])('refuses %s', (_label, body) => {
        expect(RecordWorkpaperReviewSchema.safeParse(body).success).toBe(false);
    });

    it('every code is an upper-case identifier, and none repeats', () => {
        expect(WORKPAPER_REVIEW_DISSENT_CODES.filter((c) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(c))).toEqual([]);
        expect(new Set(WORKPAPER_REVIEW_DISSENT_CODES).size).toBe(WORKPAPER_REVIEW_DISSENT_CODES.length);
    });
});

describe('the agreement rate counts concluded reviews only', () => {
    const counts = { drawn: 0, unassigned: 0, awaiting: 0, concurred: 0, dissented: 0, indeterminate: 0 };

    it('reports NO rate over nothing concluded — never 100% agreement, however much was drawn', () => {
        const r = workpaperReviewRate({ ...counts, drawn: 12, unassigned: 3, awaiting: 7, indeterminate: 2 });
        expect(r.concluded).toBe(0);
        expect(r.agreementRate).toBeNull();
        expect(r.disagreementRate).toBeNull();
    });

    it('leaves drawn-but-unreviewed, INDETERMINATE and UNASSIGNED out of both sides', () => {
        const r = workpaperReviewRate({ drawn: 20, unassigned: 4, awaiting: 6, concurred: 6, dissented: 2, indeterminate: 2 });
        expect(r.concluded).toBe(8);
        expect(r.agreementRate).toBe(0.75);
        expect(r.disagreementRate).toBe(0.25);
        const more = workpaperReviewRate({ drawn: 30, unassigned: 9, awaiting: 9, concurred: 6, dissented: 2, indeterminate: 4 });
        expect(more.agreementRate).toBe(r.agreementRate);
    });
});

describe('the finding proposal a dissent raises', () => {
    it('names the workpaper, the codes and the reviewer — identifiers and codes only', () => {
        const proposal = dissentFindingProposal({
            reviewId: 'rev_1',
            workpaperId: 'wp_1',
            procedureId: 'iam.leaver_timeliness',
            catalogueVersion: 1,
            periodLabel: '2026-07',
            conclusion: 'PASS',
            conclusionBasis: 'ALL_SAMPLED_UNITS_PASSED',
            auditorAgentId: 'agent_1',
            reviewerUserId: 'user_9',
            dissentCodes: ['EXCEPTION_MISSED', 'CONCLUSION_NOT_SUPPORTED'],
            samplingEpoch: workpaperReviewEpoch('2026-07'),
        });
        const payload = proposal.payload;
        expect(payload).toMatchObject({
            type: 'NONCONFORMITY',
            sourceKind: WORKPAPER_REVIEW_FINDING_SOURCE_KIND,
            sourceRef: 'rev_1',
        });
        const description = String(payload.description);
        for (const needle of ['wp_1', 'iam.leaver_timeliness', 'agent_1', 'reviewer user_9', 'EXCEPTION_MISSED, CONCLUSION_NOT_SUPPORTED']) {
            expect(description).toContain(needle);
        }
        expect(proposal.rationale.startsWith('Internal audit dissented from sampled workpaper wp_1:')).toBe(true);
        expect(String(payload.title).length).toBeLessThanOrEqual(200);
    });
});
