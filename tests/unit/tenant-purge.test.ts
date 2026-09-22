/**
 * The tenant purge (#2747): ordering, and the retained set.
 *
 * The purge itself is exercised against a real database in
 * `tests/integration/tenant-purge-live.test.ts`; this file covers the pure
 * parts, where a wrong answer is cheapest to find.
 */
import {
    deletionOrder,
    TENANT_PURGE_RETAINED,
    DEFAULT_TENANT_PURGE_GRACE_DAYS,
} from '@/app-layer/usecases/tenant-purge';

describe('deletionOrder — children before parents', () => {
    it('puts a child before the parent it references', () => {
        const order = deletionOrder([
            { table: 'Parent', dependsOn: new Set() },
            { table: 'Child', dependsOn: new Set(['Parent']) },
        ]);
        expect(order.indexOf('Child')).toBeLessThan(order.indexOf('Parent'));
    });

    it('handles a three-level chain', () => {
        const order = deletionOrder([
            { table: 'A', dependsOn: new Set() },
            { table: 'B', dependsOn: new Set(['A']) },
            { table: 'C', dependsOn: new Set(['B']) },
        ]);
        expect(order).toEqual(['C', 'B', 'A']);
    });

    it('emits every table exactly once', () => {
        const tables = ['A', 'B', 'C', 'D', 'E'];
        const order = deletionOrder([
            { table: 'A', dependsOn: new Set() },
            { table: 'B', dependsOn: new Set(['A']) },
            { table: 'C', dependsOn: new Set(['A', 'B']) },
            { table: 'D', dependsOn: new Set() },
            { table: 'E', dependsOn: new Set(['D']) },
        ]);
        expect([...order].sort()).toEqual(tables);
        expect(order.length).toBe(new Set(order).size);
    });

    /**
     * A self-referencing hierarchy is a legitimate shape — `RiskHierarchyNode`
     * has one — and a purge that THREW on it would refuse to delete a tenant
     * for a reason that is not a fault. The whole table goes in one statement,
     * so intra-table order never mattered.
     */
    it('does not hang or throw on a cycle', () => {
        const order = deletionOrder([
            { table: 'X', dependsOn: new Set(['Y']) },
            { table: 'Y', dependsOn: new Set(['X']) },
        ]);
        expect([...order].sort()).toEqual(['X', 'Y']);
    });

    it('does not hang on a self-reference', () => {
        const order = deletionOrder([{ table: 'Node', dependsOn: new Set(['Node']) }]);
        expect(order).toEqual(['Node']);
    });
});

describe('the retained set is a compliance decision, not a convenience', () => {
    it('retains the regulatory artefacts data-retention.md names', () => {
        // Each of these has a NON-NULLABLE, non-cascading FK to Tenant, so the
        // Tenant row cannot go while they stay — which is exactly why the purge
        // leaves a tombstone rather than deleting the tenant.
        for (const t of [
            'AuditLog',
            'Incident',
            'IncidentNotification',
            'IncidentTimelineEntry',
            'ReadinessSnapshot',
            'AgentActionReceipt',
            'AiDecisionLog',
        ]) {
            expect(TENANT_PURGE_RETAINED.has(t)).toBe(true);
        }
    });

    it('retains Tenant itself — the tombstone the artefacts point at', () => {
        expect(TENANT_PURGE_RETAINED.has('Tenant')).toBe(true);
    });

    it('does NOT retain ordinary business data — that is the bug being fixed', () => {
        // 9 soft-deleted tenants were holding 768 controls when this was
        // reported. If Control ever lands in the retained set the report is
        // back, silently.
        for (const t of ['Control', 'Risk', 'Policy', 'Evidence', 'Employee', 'Asset']) {
            expect(TENANT_PURGE_RETAINED.has(t)).toBe(false);
        }
    });

    it('keeps the grace period aligned with the repo-wide soft-delete window', () => {
        // docs/data-retention.md documents a 90-day purge for soft-deleted
        // records. A tenant that vanished sooner than its own rows would be a
        // surprise; one that vanished later would leave the report unfixed.
        expect(DEFAULT_TENANT_PURGE_GRACE_DAYS).toBe(90);
    });
});
