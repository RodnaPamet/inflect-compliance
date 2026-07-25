/**
 * Coverage wave E — `src/app-layer/ai/compliance-posture/stub-provider.ts`.
 *
 * The deterministic summary is not just the zero-config default — it is also
 * the fallback every LLM provider degrades to, so it has to produce a usable
 * result for any tenant shape, including a brand-new empty one. These tests
 * walk the scoring penalties, each narrative clause, and the advice ladder
 * (which fills to at most three items by descending urgency).
 *
 * Everything here is pure; nothing is mocked.
 */
import {
    derivePostureScore,
    scoreToPostureLabel,
    buildSummaryText,
    buildAdvice,
    computeDeterministicSummary,
    StubCompliancePostureProvider,
} from '@/app-layer/ai/compliance-posture/stub-provider';
import type { PostureSummaryInput } from '@/app-layer/ai/compliance-posture/types';

function makeInput(over: Partial<PostureSummaryInput> = {}): PostureSummaryInput {
    return {
        controls: {
            applicable: 100,
            implemented: 100,
            inProgress: 0,
            notStarted: 0,
            coveragePercent: 100,
        },
        frameworks: [],
        risks: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
        evidence: { overdue: 0, dueSoon: 0, current: 10 },
        findings: { open: 0 },
        tasks: { open: 0, overdue: 0 },
        policies: { total: 5, overdueReview: 0 },
        vendors: { overdueReview: 0 },
        maturityAverage: null,
        ...over,
    };
}

const fw = (name: string, coveragePercent: number, total = 100) => ({
    key: name,
    name,
    mapped: Math.round((coveragePercent / 100) * total),
    total,
    coveragePercent,
});

describe('derivePostureScore', () => {
    it('anchors on control coverage with no penalties', () => {
        expect(derivePostureScore(makeInput())).toBe(100);
    });

    it('penalises critical and high risks, capped at 20', () => {
        expect(
            derivePostureScore(
                makeInput({ risks: { total: 1, critical: 1, high: 0, medium: 0, low: 0 } }),
            ),
        ).toBe(94);
        // 10 criticals would be −60 uncapped; the cap holds it at −20.
        expect(
            derivePostureScore(
                makeInput({ risks: { total: 10, critical: 10, high: 0, medium: 0, low: 0 } }),
            ),
        ).toBe(80);
    });

    it('penalises overdue evidence, capped at 15', () => {
        expect(
            derivePostureScore(makeInput({ evidence: { overdue: 1, dueSoon: 0, current: 0 } })),
        ).toBe(98);
        expect(
            derivePostureScore(makeInput({ evidence: { overdue: 50, dueSoon: 0, current: 0 } })),
        ).toBe(85);
    });

    it('penalises overdue tasks, policies, and vendors within their caps', () => {
        expect(derivePostureScore(makeInput({ tasks: { open: 0, overdue: 99 } }))).toBe(90);
        expect(
            derivePostureScore(makeInput({ policies: { total: 5, overdueReview: 99 } })),
        ).toBe(92);
        expect(derivePostureScore(makeInput({ vendors: { overdueReview: 99 } }))).toBe(94);
    });

    it('blends self-assessed maturity at 30% when present', () => {
        // 100 * 0.7 + (5/5 * 100) * 0.3 = 100
        expect(derivePostureScore(makeInput({ maturityAverage: 5 }))).toBe(100);
        // 100 * 0.7 + 0 * 0.3 = 70
        expect(derivePostureScore(makeInput({ maturityAverage: 0 }))).toBe(70);
    });

    it('clamps into 0-100', () => {
        const wrecked = makeInput({
            controls: {
                applicable: 10,
                implemented: 0,
                inProgress: 0,
                notStarted: 10,
                coveragePercent: 0,
            },
            risks: { total: 20, critical: 20, high: 20, medium: 0, low: 0 },
            evidence: { overdue: 50, dueSoon: 0, current: 0 },
            tasks: { open: 0, overdue: 50 },
            policies: { total: 5, overdueReview: 50 },
            vendors: { overdueReview: 50 },
        });
        const score = derivePostureScore(wrecked);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(100);
    });
});

describe('scoreToPostureLabel', () => {
    it.each([
        [100, 'STRONG'],
        [80, 'STRONG'],
        [79, 'ESTABLISHED'],
        [60, 'ESTABLISHED'],
        [59, 'DEVELOPING'],
        [40, 'DEVELOPING'],
        [39, 'AT_RISK'],
        [0, 'AT_RISK'],
    ])('maps %i to %s', (score, label) => {
        expect(scoreToPostureLabel(score)).toBe(label);
    });
});

describe('buildSummaryText', () => {
    it('leads with coverage when controls exist', () => {
        const text = buildSummaryText(makeInput(), 100);
        expect(text).toContain('100% control coverage');
        expect(text).toContain('100 of 100 controls implemented');
    });

    it('leads with the empty-state sentence when no controls are applicable', () => {
        const text = buildSummaryText(
            makeInput({
                controls: {
                    applicable: 0,
                    implemented: 0,
                    inProgress: 0,
                    notStarted: 0,
                    coveragePercent: 0,
                },
            }),
            0,
        );
        expect(text).toContain('No applicable controls are configured yet');
    });

    it('names up to three frameworks and counts the rest', () => {
        const text = buildSummaryText(
            makeInput({ frameworks: [fw('A', 50), fw('B', 50), fw('C', 50), fw('D', 50), fw('E', 50)] }),
            70,
        );
        expect(text).toContain('across A, B, C and 2 more');
    });

    it('omits the "and N more" tail at exactly three frameworks', () => {
        const text = buildSummaryText(
            makeInput({ frameworks: [fw('A', 50), fw('B', 50), fw('C', 50)] }),
            70,
        );
        expect(text).toContain('across A, B, C');
        expect(text).not.toContain('more');
    });

    it('reports a clean hygiene clause when nothing is overdue', () => {
        expect(buildSummaryText(makeInput(), 100)).toContain(
            'operational hygiene is clean',
        );
    });

    it('lists at most three attention items', () => {
        const text = buildSummaryText(
            makeInput({
                risks: { total: 4, critical: 2, high: 2, medium: 0, low: 0 },
                evidence: { overdue: 3, dueSoon: 0, current: 0 },
                tasks: { open: 0, overdue: 2 },
                findings: { open: 7 },
            }),
            50,
        );
        expect(text).toContain('4 high-severity open risks');
        expect(text).toContain('3 overdue evidence reviews');
        expect(text).toContain('2 overdue tasks');
        // The fourth item (open findings) is dropped by the slice(0, 3).
        expect(text).not.toContain('7 open findings');
    });

    it('singularises each attention item', () => {
        const text = buildSummaryText(
            makeInput({
                risks: { total: 1, critical: 1, high: 0, medium: 0, low: 0 },
                evidence: { overdue: 1, dueSoon: 0, current: 0 },
                tasks: { open: 0, overdue: 1 },
            }),
            50,
        );
        // Singular, and followed by the list comma — not pluralised to "risks".
        expect(text).toContain('1 high-severity open risk,');
        expect(text).toContain('1 overdue evidence review');
        expect(text).toContain('1 overdue task');
    });

    it('mentions open findings when they are within the first three items', () => {
        const text = buildSummaryText(makeInput({ findings: { open: 1 } }), 50);
        expect(text).toContain('1 open finding');
    });

    it.each([
        [90, 'posture is strong'],
        [70, 'established with room to tighten'],
        [50, 'developing — prioritise the gaps'],
        [10, 'at risk — the items below are urgent'],
    ])('appends the verdict for score %i', (score, fragment) => {
        expect(buildSummaryText(makeInput(), score)).toContain(fragment);
    });
});

describe('buildAdvice', () => {
    it('leads with criticals when present', () => {
        const [first] = buildAdvice(
            makeInput({ risks: { total: 2, critical: 2, high: 5, medium: 0, low: 0 } }),
        );
        expect(first.title).toBe('Treat 2 critical risks');
        expect(first.priority).toBe('high');
    });

    it('falls through to highs when there are no criticals', () => {
        const [first] = buildAdvice(
            makeInput({ risks: { total: 1, critical: 0, high: 1, medium: 0, low: 0 } }),
        );
        expect(first.title).toBe('Reduce 1 high risk');
    });

    it('escalates overdue evidence to high at five or more', () => {
        const medium = buildAdvice(
            makeInput({ evidence: { overdue: 4, dueSoon: 0, current: 0 } }),
        ).find((a) => a.title.includes('overdue evidence'));
        expect(medium?.priority).toBe('medium');

        const high = buildAdvice(
            makeInput({ evidence: { overdue: 5, dueSoon: 0, current: 0 } }),
        ).find((a) => a.title.includes('overdue evidence'));
        expect(high?.priority).toBe('high');
    });

    it('targets the weakest mapped framework and escalates below 50%', () => {
        const advice = buildAdvice(
            makeInput({ frameworks: [fw('Strong', 90), fw('Weak', 20)] }),
        );
        const item = advice.find((a) => a.title.includes('Weak'))!;
        expect(item.title).toBe('Raise Weak coverage (20%)');
        expect(item.priority).toBe('high');
        expect(item.detail).toContain('80 of 100 Weak requirements are unmapped');
    });

    it('ignores frameworks with no requirements, and fully-covered ones', () => {
        expect(
            buildAdvice(makeInput({ frameworks: [fw('Empty', 0, 0)] })).some((a) =>
                a.title.includes('Empty'),
            ),
        ).toBe(false);
        expect(
            buildAdvice(makeInput({ frameworks: [fw('Done', 100)] })).some((a) =>
                a.title.includes('Done'),
            ),
        ).toBe(false);
    });

    it('advises installing a framework on a brand-new tenant', () => {
        const advice = buildAdvice(
            makeInput({
                frameworks: [],
                controls: {
                    applicable: 0,
                    implemented: 0,
                    inProgress: 0,
                    notStarted: 0,
                    coveragePercent: 0,
                },
            }),
        );
        expect(advice[0].title).toBe('Install a compliance framework');
        expect(advice[0].priority).toBe('high');
    });

    it('fills with tasks, policies, findings, then vendors while under three', () => {
        expect(
            buildAdvice(makeInput({ tasks: { open: 0, overdue: 2 } }))[0].title,
        ).toBe('Clear 2 overdue tasks');
        expect(
            buildAdvice(makeInput({ policies: { total: 5, overdueReview: 1 } }))[0].title,
        ).toBe('Review 1 overdue policy');
        expect(buildAdvice(makeInput({ findings: { open: 2 } }))[0].title).toBe(
            'Close 2 open findings',
        );
        const vendor = buildAdvice(makeInput({ vendors: { overdueReview: 1 } }))[0];
        expect(vendor.title).toBe('Reassess 1 vendor');
        expect(vendor.priority).toBe('low');
    });

    it('pluralises policies correctly', () => {
        expect(
            buildAdvice(makeInput({ policies: { total: 5, overdueReview: 3 } }))[0].title,
        ).toBe('Review 3 overdue policies');
    });

    it('caps at three items', () => {
        const advice = buildAdvice(
            makeInput({
                risks: { total: 2, critical: 2, high: 0, medium: 0, low: 0 },
                evidence: { overdue: 6, dueSoon: 0, current: 0 },
                frameworks: [fw('Weak', 10)],
                tasks: { open: 0, overdue: 4 },
                policies: { total: 5, overdueReview: 4 },
                findings: { open: 4 },
                vendors: { overdueReview: 4 },
            }),
        );
        expect(advice).toHaveLength(3);
    });

    it('suggests finishing the remaining controls when nothing is broken', () => {
        const advice = buildAdvice(
            makeInput({
                controls: {
                    applicable: 10,
                    implemented: 8,
                    inProgress: 0,
                    notStarted: 2,
                    coveragePercent: 80,
                },
            }),
        );
        expect(advice[0].title).toBe('Implement 2 remaining controls');
    });

    it('falls back to the sustain message on a fully-healthy tenant', () => {
        const advice = buildAdvice(makeInput());
        expect(advice).toHaveLength(1);
        expect(advice[0].title).toBe('Sustain and evidence your controls');
        expect(advice[0].priority).toBe('low');
    });
});

describe('computeDeterministicSummary + StubCompliancePostureProvider', () => {
    it('marks a normal run as the stub provider', () => {
        const res = computeDeterministicSummary(makeInput());
        expect(res.provider).toBe('stub');
        expect(res.isFallback).toBe(false);
        expect(res.postureLabel).toBe('STRONG');
        expect(res.maturityScore).toBe(100);
        expect(res.summaryText.length).toBeGreaterThan(0);
        expect(res.advice.length).toBeGreaterThan(0);
    });

    it('marks a fallback run distinctly', () => {
        const res = computeDeterministicSummary(makeInput(), { isFallback: true });
        expect(res.provider).toBe('fallback');
        expect(res.isFallback).toBe(true);
    });

    it('the provider class delegates, defaulting to non-fallback mode', async () => {
        const normal = await new StubCompliancePostureProvider().generate(makeInput());
        expect(normal.provider).toBe('stub');
        expect(new StubCompliancePostureProvider().providerName).toBe('stub');

        const fallback = await new StubCompliancePostureProvider(true).generate(
            makeInput(),
        );
        expect(fallback.provider).toBe('fallback');
        expect(fallback.isFallback).toBe(true);
    });
});
