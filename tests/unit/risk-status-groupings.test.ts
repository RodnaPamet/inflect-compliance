/**
 * The two lines `app-layer/domain/risk-status` draws through `RiskStatus`.
 *
 *   OPEN            — not closed, not accepted. The deadline monitor and the
 *                     compliance calendar read it, and it must not move: a
 *                     mitigated risk still has a review and an acceptance due.
 *   NEEDS TREATMENT — OPEN and MITIGATING. The Board's severity figures read
 *                     it (owner decision, 2026-10-30), and so do the risk
 *                     snapshot's open count and the automation suggestions'
 *                     active-risk count, which spelled exactly this set inline
 *                     before they were pointed here.
 *
 * Values, not shapes: each assertion names the statuses a reader gets, so a
 * reclassification in the module's map turns the reader's line red here.
 */
import {
    NEEDS_TREATMENT_RISK_STATUSES,
    OPEN_RISK_STATUSES,
    SETTLED_RISK_STATUSES,
    isSettledRiskStatus,
    needsTreatmentRiskStatusFilter,
    openRiskStatusFilter,
    riskStatusNeedsTreatment,
} from '@/app-layer/domain/risk-status';

describe('risk status groupings', () => {
    it('open is every status but closed and accepted, mitigated included', () => {
        expect([...OPEN_RISK_STATUSES].sort()).toEqual(['MITIGATED', 'MITIGATING', 'OPEN']);
        expect([...SETTLED_RISK_STATUSES].sort()).toEqual(['ACCEPTED', 'CLOSED']);
        expect(openRiskStatusFilter()).toEqual({ notIn: expect.arrayContaining(['ACCEPTED', 'CLOSED']) });
        expect(openRiskStatusFilter().notIn).toHaveLength(2);
        expect(isSettledRiskStatus('MITIGATED')).toBe(false);
    });

    it('needing treatment is open and mitigating, and never mitigated', () => {
        expect([...NEEDS_TREATMENT_RISK_STATUSES].sort()).toEqual(['MITIGATING', 'OPEN']);
        expect(riskStatusNeedsTreatment('MITIGATED')).toBe(false);
        expect(riskStatusNeedsTreatment('OPEN')).toBe(true);
        expect(riskStatusNeedsTreatment('MITIGATING')).toBe(true);
        expect(riskStatusNeedsTreatment('ACCEPTED')).toBe(false);
    });

    it("the filter is the automation suggestions' former inline set, in its order", () => {
        expect(needsTreatmentRiskStatusFilter()).toEqual({ in: ['OPEN', 'MITIGATING'] });
    });

    it('needing treatment is a strict subset of open', () => {
        for (const s of NEEDS_TREATMENT_RISK_STATUSES) expect(OPEN_RISK_STATUSES).toContain(s);
        expect(NEEDS_TREATMENT_RISK_STATUSES.length).toBeLessThan(OPEN_RISK_STATUSES.length);
    });
});
