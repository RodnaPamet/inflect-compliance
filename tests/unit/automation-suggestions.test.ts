/**
 * VR-9 — automation-rule suggestion ranker (pure core).
 */
import { rankRuleSuggestions } from '@/app-layer/usecases/automation-suggestions';

describe('rankRuleSuggestions', () => {
    it('returns ranked suggestions for a tenant with open risk', () => {
        const out = rankRuleSuggestions({ activeRiskCount: 12, coveredEvents: new Set() });
        expect(out.length).toBeGreaterThan(0);
        // ranks are 1-based + contiguous, ordered by descending confidence
        expect(out[0].rank).toBe(1);
        for (let i = 1; i < out.length; i++) {
            expect(out[i].rank).toBe(i + 1);
            expect(out[i - 1].confidenceScore).toBeGreaterThanOrEqual(out[i].confidenceScore);
        }
    });

    it('excludes suggestions whose trigger event is already covered by an enabled rule', () => {
        const covered = new Set(['RISK_CREATED', 'TEST_RUN_FAILED']);
        const out = rankRuleSuggestions({ activeRiskCount: 5, coveredEvents: covered });
        expect(out.find((s) => s.triggerEvent === 'RISK_CREATED')).toBeUndefined();
        expect(out.find((s) => s.triggerEvent === 'TEST_RUN_FAILED')).toBeUndefined();
        // non-covered ones survive
        expect(out.find((s) => s.triggerEvent === 'RISK_STATUS_CHANGED')).toBeDefined();
    });

    it('suggests no trigger that nothing emits (#5122)', () => {
        // 'Turn new issues into tracked tasks' was on ISSUE_CREATED, which no
        // code emits: a rule made from it could never fire.
        const out = rankRuleSuggestions({ activeRiskCount: 0, coveredEvents: new Set() });
        expect(out.map((s) => s.triggerEvent)).not.toContain('ISSUE_CREATED');
    });

    it('more active risk raises the risk-driven suggestion confidence', () => {
        const quiet = rankRuleSuggestions({ activeRiskCount: 0, coveredEvents: new Set() });
        const busy = rankRuleSuggestions({ activeRiskCount: 30, coveredEvents: new Set() });
        const q = quiet.find((s) => s.id === 'risk-created-task')!;
        const b = busy.find((s) => s.id === 'risk-created-task')!;
        expect(b.confidenceScore).toBeGreaterThan(q.confidenceScore);
    });

    it('never emits a confidence score above 1', () => {
        const out = rankRuleSuggestions({ activeRiskCount: 1000, coveredEvents: new Set() });
        for (const s of out) expect(s.confidenceScore).toBeLessThanOrEqual(1);
    });
});
