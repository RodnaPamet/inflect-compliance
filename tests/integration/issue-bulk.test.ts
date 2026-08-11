import { existsSync } from 'fs';
import { join } from 'path';

/**
 * Integration tests for issue bulk and metrics API routes.
 * These verify route module exports exist AND that Zod validation is enforced.
 */
describe('Issue Bulk & Metrics Routes', () => {
    const apiBase = join(process.cwd(), 'src/app/api/t/[tenantSlug]/issues');

    // The "Route modules exist" block was deleted with the routes it asserted.
    // Those five `existsSync` checks certified that a FILE was on disk — not
    // that anything called it, not that it was gated, not that it behaved like
    // its `/tasks` twin. All five were green the entire time
    // `POST /issues/bulk/status` bypassed the four-eyes reviewer gate, which is
    // the clearest possible statement of what they were worth.
    //
    // The schema assertions below are kept: `BulkAssignSchema` and friends are
    // still exported and still validate the shared `/tasks` bulk bodies.

    describe('Bulk schemas enforce tenant isolation via Zod', () => {
        // Schema-level tests ensuring issueIds are required and capped
        const { BulkAssignSchema, BulkStatusSchema, BulkDueDateSchema } = require('../../src/lib/schemas');

        it('BulkAssignSchema rejects missing issueIds', () => {
            expect(BulkAssignSchema.safeParse({ assigneeUserId: null }).success).toBe(false);
        });

        it('BulkStatusSchema rejects missing status', () => {
            expect(BulkStatusSchema.safeParse({ issueIds: ['id1'] }).success).toBe(false);
        });

        it('BulkDueDateSchema rejects missing issueIds', () => {
            expect(BulkDueDateSchema.safeParse({ dueAt: null }).success).toBe(false);
        });

        it('All schemas enforce min 1 issueId', () => {
            expect(BulkAssignSchema.safeParse({ issueIds: [], assigneeUserId: null }).success).toBe(false);
            expect(BulkStatusSchema.safeParse({ issueIds: [], status: 'OPEN' }).success).toBe(false);
            expect(BulkDueDateSchema.safeParse({ issueIds: [], dueAt: null }).success).toBe(false);
        });

        it('All schemas enforce max 100 issueIds', () => {
            const ids = Array.from({ length: 101 }, (_, i) => `id${i}`);
            expect(BulkAssignSchema.safeParse({ issueIds: ids, assigneeUserId: null }).success).toBe(false);
            expect(BulkStatusSchema.safeParse({ issueIds: ids, status: 'OPEN' }).success).toBe(false);
            expect(BulkDueDateSchema.safeParse({ issueIds: ids, dueAt: null }).success).toBe(false);
        });
    });

    describe('SLA service is importable and functional', () => {
        const { computeSLADates, isSlaBreach } = require('../../src/app-layer/services/sla');

        it('computes SLA dates correctly', () => {
            const sla = computeSLADates('CRITICAL', new Date('2025-01-01T00:00:00Z'));
            expect(sla.triageDueAt).toBeTruthy();
            expect(sla.resolveDueAt).toBeTruthy();
        });

        it('isSlaBreach works', () => {
            expect(isSlaBreach(new Date('2020-01-01'))).toBe(true);
            expect(isSlaBreach(null)).toBe(false);
        });
    });
});
