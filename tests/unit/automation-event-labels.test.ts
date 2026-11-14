/**
 * Automation Epic 3 — event-label metadata.
 *
 * The builder's Step 1 (trigger picker, grouped by domain) and Step 2
 * (condition fields) read from EVENT_LABELS. Lock the grouping + the
 * filter-field lookup.
 */
import {
    EVENT_LABELS,
    eventOptionsByDomain,
    filterFieldsForEvent,
} from '@/lib/automation/event-labels';
import { AUTOMATION_EVENT_NAMES } from '@/app-layer/automation/events';
import { RiskStatus } from '@prisma/client';

describe('event-labels', () => {
    it('has a label entry for every catalog event', () => {
        for (const name of AUTOMATION_EVENT_NAMES) {
            expect(EVENT_LABELS[name]).toBeDefined();
            expect(EVENT_LABELS[name].label.length).toBeGreaterThan(0);
        }
    });

    it('groups events by domain', () => {
        const groups = eventOptionsByDomain();
        const domains = groups.map((g) => g.domain);
        expect(domains).toContain('Risk');
        expect(domains).toContain('Task');
        // every event lands in exactly one group
        const total = groups.reduce((n, g) => n + g.events.length, 0);
        expect(total).toBe(AUTOMATION_EVENT_NAMES.length);
    });

    it('returns filter fields for an event that has them, [] otherwise', () => {
        const riskFields = filterFieldsForEvent('RISK_CREATED');
        expect(riskFields.some((f) => f.field === 'severity')).toBe(true);
        expect(filterFieldsForEvent('NONEXISTENT_EVENT')).toEqual([]);
    });

    it('enum filter fields carry options', () => {
        const sev = filterFieldsForEvent('RISK_CREATED').find((f) => f.field === 'severity');
        expect(sev?.type).toBe('enum');
        expect(sev?.options?.length).toBeGreaterThan(0);
    });

    it('a risk status picker offers every RiskStatus, MITIGATED included (#5316)', () => {
        for (const field of ['toStatus', 'fromStatus']) {
            const def = filterFieldsForEvent('RISK_STATUS_CHANGED').find((f) => f.field === field);
            expect(def?.options?.map((o) => o.value).sort()).toEqual(Object.values(RiskStatus).sort());
        }
    });
});
