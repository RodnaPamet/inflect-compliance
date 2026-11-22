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
        // every offered event lands in exactly one group; hidden ones in none
        const offered = groups.flatMap((g) => g.events.map((e) => e.name));
        expect(new Set(offered).size).toBe(offered.length);
        const hidden = AUTOMATION_EVENT_NAMES.filter((n) => EVENT_LABELS[n].hidden);
        expect(offered.length + hidden.length).toBe(AUTOMATION_EVENT_NAMES.length);
    });

    it('does not offer the Issue triggers, which nothing emits, but keeps their labels for stored rules', () => {
        const offered = eventOptionsByDomain().flatMap((g) => g.events.map((e) => e.name));
        expect(offered).not.toContain('ISSUE_CREATED');
        expect(offered).not.toContain('ISSUE_STATUS_CHANGED');
        expect(eventOptionsByDomain().map((g) => g.domain)).not.toContain('Issue');
        expect(EVENT_LABELS.ISSUE_CREATED.label).toBe('Issue created');
        expect(AUTOMATION_EVENT_NAMES.filter((n) => EVENT_LABELS[n].hidden).sort()).toEqual([
            'ISSUE_CREATED',
            'ISSUE_STATUS_CHANGED',
        ]);
    });

    it('returns filter fields for an event that has them, [] otherwise', () => {
        const riskFields = filterFieldsForEvent('RISK_CREATED');
        expect(riskFields.map((f) => f.field).sort()).toEqual(['category', 'score', 'status']);
        expect(filterFieldsForEvent('NONEXISTENT_EVENT')).toEqual([]);
    });

    it('offers no risk condition on a field the risk payload does not carry', () => {
        // A risk has no severity; RISK_UPDATED carries only changedFields.
        expect(filterFieldsForEvent('RISK_CREATED').some((f) => f.field === 'severity')).toBe(false);
        expect(filterFieldsForEvent('RISK_UPDATED')).toEqual([]);
    });

    it('enum filter fields carry options', () => {
        const status = filterFieldsForEvent('RISK_CREATED').find((f) => f.field === 'status');
        expect(status?.type).toBe('enum');
        expect(status?.options?.length).toBeGreaterThan(0);
    });

    it('a risk status picker offers every RiskStatus, MITIGATED included (#5316)', () => {
        for (const field of ['toStatus', 'fromStatus']) {
            const def = filterFieldsForEvent('RISK_STATUS_CHANGED').find((f) => f.field === field);
            expect(def?.options?.map((o) => o.value).sort()).toEqual(Object.values(RiskStatus).sort());
        }
    });
});
