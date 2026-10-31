/**
 * #4793 — the controls predicates the dashboard cards and the list
 * drill-downs share. One definition per card, so a number and the list it
 * opens cannot disagree.
 */
import {
    controlsDueSoonWhere,
    controlsMissingEvidenceWhere,
    dueSoonThreshold,
} from '@/lib/compliance/control-predicates';

describe('controlsMissingEvidenceWhere (#4793)', () => {
    const where = controlsMissingEvidenceWhere('tenant-1', new Date('2026-06-01T00:00:00Z'));

    it('leaves out a control scoped out by its applicability', () => {
        expect(where).toMatchObject({ applicability: { not: 'NOT_APPLICABLE' } });
    });

    it('leaves out a control whose status is Not applicable', () => {
        expect(where).toMatchObject({ status: { not: 'NOT_APPLICABLE' } });
    });

    it('asks for no qualifying evidence link in the same tenant', () => {
        expect(where.NOT).toMatchObject({
            evidenceControlLinks: { some: { tenantId: 'tenant-1' } },
        });
    });
});

describe('controlsDueSoonWhere', () => {
    it('reaches 30 days ahead and has no lower bound, so overdue controls count', () => {
        const now = new Date('2026-06-01T00:00:00Z');
        const where = controlsDueSoonWhere(now);
        expect(where).toEqual({
            applicability: 'APPLICABLE',
            nextDueAt: { not: null, lte: dueSoonThreshold(now) },
        });
        expect(dueSoonThreshold(now).toISOString()).toBe('2026-07-01T00:00:00.000Z');
    });
});
