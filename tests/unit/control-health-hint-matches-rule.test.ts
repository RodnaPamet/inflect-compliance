/**
 * The Health hint states the rule the verdict actually applies (#4275).
 *
 * `controls.dashboard.controlHealthMeasuredOnly` is the tooltip beside the
 * Health column on the Controls list and the Control health card on the
 * controls dashboard. It said health "reflects MEASURED test
 * operating-effectiveness only" and that a control "with a declared score but
 * no tests reads Unknown here" — while `computeControlHealthVerdict` counts an
 * IMPLEMENTED status as a signal, so an Implemented control that was never
 * tested and is not overdue reads Healthy.
 *
 * The owner chose to make the text true rather than change the rule. So each
 * claim the hint makes is checked against the rule itself, in both catalogues:
 * a reworded hint that drifts from the rule, or a rule change that leaves the
 * hint behind, fails here.
 */
import {
    computeControlHealthVerdict,
    HEALTH_PASS_RATE_STRONG,
    HEALTH_PASS_RATE_WEAK,
    type ControlHealthSignals,
} from '@/lib/controls/control-health';

const en = require('../../messages/en.json');
const bg = require('../../messages/bg.json');

const verdict = (over: Partial<ControlHealthSignals>) =>
    computeControlHealthVerdict({
        applicability: 'APPLICABLE',
        status: 'IN_PROGRESS',
        passRate: null,
        total: 0,
        overdue: false,
        ...over,
    });

describe.each([
    ['en', en],
    ['bg', bg],
] as const)('the Health hint (%s) states the rule', (_lang, catalogue) => {
    const c = catalogue.controls;
    const hint: string = c.dashboard.controlHealthMeasuredOnly;
    const V = c.health.verdict;
    const S = c.filterEnums.status;

    it('says an untested Implemented control reads Healthy — which the rule does', () => {
        expect(verdict({ status: 'IMPLEMENTED' })).toBe('HEALTHY');
        expect(hint).toContain(S.IMPLEMENTED);
        expect(hint).toContain(V.HEALTHY);
    });

    it('says an untested control that is not Implemented reads Unknown — which the rule does', () => {
        expect(verdict({ status: 'IN_PROGRESS' })).toBe('UNKNOWN');
        expect(hint).toContain(V.UNKNOWN);
    });

    it('names the thresholds the rule uses', () => {
        expect(verdict({ status: 'IMPLEMENTED', total: 10, passRate: HEALTH_PASS_RATE_WEAK - 1 })).toBe('AT_RISK');
        expect(verdict({ status: 'IMPLEMENTED', total: 10, passRate: HEALTH_PASS_RATE_STRONG - 1 })).toBe('DEGRADED');
        expect(hint).toContain(`${HEALTH_PASS_RATE_WEAK}%`);
        expect(hint).toContain(`${HEALTH_PASS_RATE_STRONG}%`);
        expect(hint).toContain(V.AT_RISK);
        expect(hint).toContain(V.DEGRADED);
    });

    it('names the overdue and scoped-out outcomes', () => {
        expect(verdict({ status: 'IMPLEMENTED', overdue: true })).toBe('DEGRADED');
        expect(verdict({ applicability: 'NOT_APPLICABLE' })).toBe('NOT_APPLICABLE');
        expect(hint).toContain(V.NOT_APPLICABLE);
    });
});
