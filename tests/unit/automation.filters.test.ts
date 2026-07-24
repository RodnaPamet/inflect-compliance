/**
 * Unit Test: triggerFilterJson evaluation.
 *
 * `matchesFilter` is the single gate between "rule subscribed to this
 * event" and "this specific payload instance fires it". The contract
 * here is deliberately strict — richer matching should land as a
 * versioned DSL, not as a looser implementation of this function.
 */

import { matchesFilter } from '@/app-layer/automation/filters';
import type { AutomationDomainEvent } from '@/app-layer/automation/event-contracts';

function riskEvent(
    data: { title: string; score: number; category: string | null }
): AutomationDomainEvent {
    return {
        event: 'RISK_CREATED',
        tenantId: 't',
        entityType: 'Risk',
        entityId: 'r-1',
        actorUserId: null,
        emittedAt: new Date(),
        data,
    };
}

describe('matchesFilter', () => {
    it('null filter matches any event', () => {
        const evt = riskEvent({ title: 't', score: 10, category: 'SEC' });
        expect(matchesFilter(evt, null)).toBe(true);
        expect(matchesFilter(evt, undefined)).toBe(true);
    });

    it('empty filter matches any event', () => {
        const evt = riskEvent({ title: 't', score: 10, category: null });
        expect(matchesFilter(evt, {})).toBe(true);
    });

    it('single-key equality match', () => {
        const evt = riskEvent({ title: 't', score: 10, category: 'SEC' });
        expect(matchesFilter(evt, { category: 'SEC' })).toBe(true);
        expect(matchesFilter(evt, { category: 'COMP' })).toBe(false);
    });

    it('multi-key match is AND', () => {
        const evt = riskEvent({ title: 't', score: 10, category: 'SEC' });
        expect(matchesFilter(evt, { category: 'SEC', score: 10 })).toBe(true);
        expect(matchesFilter(evt, { category: 'SEC', score: 9 })).toBe(false);
    });

    it('unknown filter key fails closed', () => {
        const evt = riskEvent({ title: 't', score: 10, category: 'SEC' });
        expect(matchesFilter(evt, { nope: 'x' })).toBe(false);
    });

    it('only looks at event.data, not metadata', () => {
        const evt = riskEvent({ title: 't', score: 10, category: 'SEC' });
        // tenantId is metadata, not filter-addressable
        expect(matchesFilter(evt, { tenantId: 't' })).toBe(false);
    });

    it('boolean + number equality', () => {
        const evt: AutomationDomainEvent = {
            event: 'TEST_RUN_COMPLETED',
            tenantId: 't',
            entityType: 'ControlTestRun',
            entityId: 'r-1',
            actorUserId: null,
            emittedAt: new Date(),
            data: { testPlanId: 'p', result: 'PASS' },
        };
        expect(matchesFilter(evt, { result: 'PASS' })).toBe(true);
        expect(matchesFilter(evt, { result: 'FAIL' })).toBe(false);
    });
});

// ─── DSL v2 (Epic 4) — FilterGroup ─────────────────────────────────────
describe('matchesFilter — FilterGroup DSL v2', () => {
    const evt = riskEvent({ title: 'Breach', score: 18, category: 'SEC' });

    it('AND passes only when every condition matches', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [
                    { field: 'category', operator: 'eq', value: 'SEC' },
                    { field: 'score', operator: 'gt', value: 10 },
                ],
            }),
        ).toBe(true);
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [
                    { field: 'category', operator: 'eq', value: 'SEC' },
                    { field: 'score', operator: 'gt', value: 20 },
                ],
            }),
        ).toBe(false);
    });

    it('OR passes when any condition matches', () => {
        expect(
            matchesFilter(evt, {
                logic: 'OR',
                conditions: [
                    { field: 'category', operator: 'eq', value: 'NOPE' },
                    { field: 'score', operator: 'gt', value: 10 },
                ],
            }),
        ).toBe(true);
        expect(
            matchesFilter(evt, {
                logic: 'OR',
                conditions: [
                    { field: 'category', operator: 'eq', value: 'NOPE' },
                    { field: 'score', operator: 'lt', value: 5 },
                ],
            }),
        ).toBe(false);
    });

    it('in / not_in operate on a value set', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'category', operator: 'in', value: ['SEC', 'COMP'] }],
            }),
        ).toBe(true);
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'category', operator: 'not_in', value: ['SEC'] }],
            }),
        ).toBe(false);
    });

    it('gt / lt are numeric; contains is substring', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'score', operator: 'lt', value: 20 }],
            }),
        ).toBe(true);
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'title', operator: 'contains', value: 'reach' }],
            }),
        ).toBe(true);
    });

    it('nested groups compose (AND of an OR)', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [
                    { field: 'score', operator: 'gt', value: 10 },
                    {
                        logic: 'OR',
                        conditions: [
                            { field: 'category', operator: 'eq', value: 'COMP' },
                            { field: 'category', operator: 'eq', value: 'SEC' },
                        ],
                    },
                ],
            }),
        ).toBe(true);
    });

    it('unknown field fails closed inside a group', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'ghost', operator: 'eq', value: 'x' }],
            }),
        ).toBe(false);
    });

    it('empty conditions array matches (no constraints)', () => {
        expect(matchesFilter(evt, { logic: 'AND', conditions: [] })).toBe(true);
    });
});

// ─── eq/neq type coercion (Bug 2) ──────────────────────────────────────
// The visual builder authors every filter value as a STRING (HTML inputs),
// so a `score eq 5` rule edited + saved becomes value:'5'. eq/neq must still
// match the typed numeric/boolean payload — coercion keyed on the payload's
// (authoritative) type, mirroring what gt/lt already do.
describe('matchesFilter — eq/neq coerce string filter values to the payload type', () => {
    const evt = riskEvent({ title: 'Breach', score: 5, category: 'SEC' });

    it('numeric eq matches a string-authored value', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'score', operator: 'eq', value: '5' }],
            }),
        ).toBe(true);
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'score', operator: 'eq', value: '6' }],
            }),
        ).toBe(false);
    });

    it('numeric neq is the negation of the coerced eq', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'score', operator: 'neq', value: '5' }],
            }),
        ).toBe(false);
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'score', operator: 'neq', value: '6' }],
            }),
        ).toBe(true);
    });

    it('numeric eq still matches a typed numeric value (no regression)', () => {
        expect(
            matchesFilter(evt, {
                logic: 'AND',
                conditions: [{ field: 'score', operator: 'eq', value: 5 }],
            }),
        ).toBe(true);
    });

    it('boolean eq matches a string-authored "true"/"false"', () => {
        const boolEvt = {
            event: 'TEST_RUN_COMPLETED',
            tenantId: 't',
            entityType: 'ControlTestRun',
            entityId: 'r-1',
            actorUserId: null,
            emittedAt: new Date(),
            data: { testPlanId: 'p', active: true },
        } as unknown as AutomationDomainEvent;
        expect(
            matchesFilter(boolEvt, {
                logic: 'AND',
                conditions: [{ field: 'active', operator: 'eq', value: 'true' }],
            }),
        ).toBe(true);
        expect(
            matchesFilter(boolEvt, {
                logic: 'AND',
                conditions: [{ field: 'active', operator: 'eq', value: 'false' }],
            }),
        ).toBe(false);
        expect(
            matchesFilter(boolEvt, {
                logic: 'AND',
                conditions: [{ field: 'active', operator: 'eq', value: true }],
            }),
        ).toBe(true);
    });

    it('legacy flat map coerces the same way', () => {
        expect(matchesFilter(evt, { score: '5' })).toBe(true);
        expect(matchesFilter(evt, { score: '6' })).toBe(false);
    });
});
