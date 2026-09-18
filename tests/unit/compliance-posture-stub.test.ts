/**
 * Unit tests — compliance-posture stub provider + output guard.
 *
 * The stub is the zero-config default AND the fallback for every LLM
 * provider, so its determinism + usefulness are load-bearing. These tests are
 * pure (no network, no DB, no mocks).
 */
import {
    StubCompliancePostureProvider,
    computeDeterministicSummary,
    derivePostureScore,
    scoreToPostureLabel,
} from '@/app-layer/ai/compliance-posture/stub-provider';
import { applyPostureOutputGuard, MAX_ADVICE } from '@/app-layer/ai/compliance-posture/output-guard';
import type {
    PostureSummaryInput,
    PostureSummaryResult,
} from '@/app-layer/ai/compliance-posture/types';

function baseSignals(overrides: Partial<PostureSummaryInput> = {}): PostureSummaryInput {
    return {
        controls: { applicable: 40, implemented: 30, inProgress: 5, notStarted: 5, coveragePercent: 75 },
        frameworks: [
            // mapped >> implemented on purpose: that gap is the state installing a
            // framework pack produces, and it used to be reported as coverage.
            {
                key: 'ISO27001', name: 'ISO/IEC 27001', mapped: 80, total: 93,
                requirementsMappedPercent: 86, implemented: 28, requirementsImplementedPercent: 30,
            },
            {
                key: 'SOC2', name: 'SOC 2', mapped: 20, total: 60,
                requirementsMappedPercent: 33, implemented: 6, requirementsImplementedPercent: 10,
            },
        ],
        risks: { total: 10, critical: 0, high: 2, medium: 5, low: 3 },
        evidence: { overdue: 3, dueSoon: 4, current: 100 },
        findings: { open: 2 },
        tasks: { open: 8, overdue: 1 },
        policies: { total: 5, overdueReview: 0 },
        vendors: { overdueReview: 0 },
        maturityAverage: null,
        ...overrides,
    };
}

describe('derivePostureScore + scoreToPostureLabel', () => {
    it('is deterministic — same input yields the same score', () => {
        const s = baseSignals();
        expect(derivePostureScore(s)).toBe(derivePostureScore(s));
    });

    it('clamps into [0, 100]', () => {
        const strong = derivePostureScore(
            baseSignals({ controls: { applicable: 40, implemented: 40, inProgress: 0, notStarted: 0, coveragePercent: 100 }, risks: { total: 0, critical: 0, high: 0, medium: 0, low: 0 }, evidence: { overdue: 0, dueSoon: 0, current: 100 }, tasks: { open: 0, overdue: 0 }, policies: { total: 0, overdueReview: 0 }, vendors: { overdueReview: 0 } }),
        );
        expect(strong).toBeLessThanOrEqual(100);
        expect(strong).toBeGreaterThanOrEqual(0);
    });

    it('penalises open critical risks + overdue work below the coverage anchor', () => {
        const clean = baseSignals({ risks: { total: 0, critical: 0, high: 0, medium: 0, low: 0 }, evidence: { overdue: 0, dueSoon: 0, current: 100 }, tasks: { open: 0, overdue: 0 } });
        const messy = baseSignals({ risks: { total: 6, critical: 3, high: 3, medium: 0, low: 0 }, evidence: { overdue: 8, dueSoon: 0, current: 10 }, tasks: { open: 8, overdue: 6 } });
        expect(derivePostureScore(messy)).toBeLessThan(derivePostureScore(clean));
    });

    it('maps score bands to labels', () => {
        expect(scoreToPostureLabel(95)).toBe('STRONG');
        expect(scoreToPostureLabel(70)).toBe('ESTABLISHED');
        expect(scoreToPostureLabel(45)).toBe('DEVELOPING');
        expect(scoreToPostureLabel(10)).toBe('AT_RISK');
    });

    it('blends in self-assessed maturity when present', () => {
        const withMaturity = derivePostureScore(baseSignals({ maturityAverage: 1 }));
        const withoutMaturity = derivePostureScore(baseSignals({ maturityAverage: null }));
        // A low (1/5) self-rating pulls a 75%-coverage score down.
        expect(withMaturity).toBeLessThan(withoutMaturity);
    });
});

describe('computeDeterministicSummary', () => {
    it('produces a STRONG posture for a clean, high-coverage tenant', async () => {
        const s = baseSignals({
            controls: { applicable: 40, implemented: 39, inProgress: 1, notStarted: 0, coveragePercent: 98 },
            risks: { total: 1, critical: 0, high: 0, medium: 1, low: 0 },
            evidence: { overdue: 0, dueSoon: 0, current: 100 },
            tasks: { open: 2, overdue: 0 },
            findings: { open: 0 },
        });
        const r = await new StubCompliancePostureProvider().generate(s);
        expect(r.postureLabel).toBe('STRONG');
        expect(r.provider).toBe('stub');
        expect(r.summaryText).toContain('98% control coverage');
        expect(r.advice.length).toBeGreaterThanOrEqual(1);
    });

    it('produces AT_RISK + high-priority advice for a struggling tenant', () => {
        const s = baseSignals({
            controls: { applicable: 40, implemented: 6, inProgress: 4, notStarted: 30, coveragePercent: 15 },
            risks: { total: 5, critical: 3, high: 2, medium: 0, low: 0 },
            evidence: { overdue: 9, dueSoon: 2, current: 5 },
            tasks: { open: 12, overdue: 7 },
            findings: { open: 4 },
        });
        const r = computeDeterministicSummary(s);
        expect(r.postureLabel).toBe('AT_RISK');
        expect(r.advice.length).toBeGreaterThanOrEqual(2);
        expect(r.advice.length).toBeLessThanOrEqual(3);
        // The critical-risk action leads and is high priority.
        expect(r.advice[0].priority).toBe('high');
        expect(r.advice[0].title.toLowerCase()).toContain('critical');
    });

    it('advises installing a framework when nothing is configured', () => {
        const s = baseSignals({
            controls: { applicable: 0, implemented: 0, inProgress: 0, notStarted: 0, coveragePercent: 0 },
            frameworks: [],
            risks: { total: 0, critical: 0, high: 0, medium: 0, low: 0 },
            evidence: { overdue: 0, dueSoon: 0, current: 0 },
            tasks: { open: 0, overdue: 0 },
            findings: { open: 0 },
            policies: { total: 0, overdueReview: 0 },
        });
        const r = computeDeterministicSummary(s);
        expect(r.advice.some((a) => a.title.toLowerCase().includes('framework'))).toBe(true);
    });

    it('marks fallback mode when constructed as fallback', async () => {
        const r = await new StubCompliancePostureProvider(true).generate(baseSignals());
        expect(r.isFallback).toBe(true);
        expect(r.provider).toBe('fallback');
    });
});

describe('applyPostureOutputGuard', () => {
    function result(overrides: Partial<PostureSummaryResult> = {}): PostureSummaryResult {
        return {
            postureLabel: 'STRONG',
            maturityScore: 80,
            summaryText: 'Solid posture.',
            advice: [{ title: 'Do a thing', detail: 'Because reasons.', priority: 'high' }],
            provider: 'stub',
            ...overrides,
        };
    }

    it('clamps an out-of-range maturityScore into [0,100]', () => {
        expect(applyPostureOutputGuard(result({ maturityScore: 250 })).maturityScore).toBe(100);
        expect(applyPostureOutputGuard(result({ maturityScore: -40 })).maturityScore).toBe(0);
    });

    it('coerces an unknown label from the score', () => {
        const guarded = applyPostureOutputGuard(
            result({ postureLabel: 'AMAZING' as never, maturityScore: 45 }),
        );
        expect(guarded.postureLabel).toBe('DEVELOPING');
    });

    it('strips HTML from the narrative and advice', () => {
        const guarded = applyPostureOutputGuard(
            result({
                summaryText: 'Hello <script>alert(1)</script> world',
                advice: [{ title: '<b>Fix</b> it', detail: '<img src=x onerror=1>', priority: 'high' }],
            }),
        );
        expect(guarded.summaryText).not.toContain('<script>');
        expect(guarded.advice[0].title).not.toContain('<b>');
    });

    it('caps advice at MAX_ADVICE and defaults an invalid priority', () => {
        const many = Array.from({ length: 9 }, (_, i) => ({
            title: `Item ${i}`,
            detail: 'x',
            priority: 'urgent' as never,
        }));
        const guarded = applyPostureOutputGuard(result({ advice: many }));
        expect(guarded.advice.length).toBe(MAX_ADVICE);
        expect(guarded.advice[0].priority).toBe('medium');
    });

    it('drops advice items with an empty title', () => {
        const guarded = applyPostureOutputGuard(
            result({ advice: [{ title: '', detail: 'orphan', priority: 'low' }] }),
        );
        expect(guarded.advice).toHaveLength(0);
    });
});
