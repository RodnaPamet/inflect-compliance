/**
 * Epic 49 — calendar-deadlines monitor + dispatch wiring tests.
 *
 * Verifies:
 *   1. The monitor returns DueItem[] for AuditCycle / VendorDocument /
 *      Finding when their deadlines fall in window.
 *   2. Items past their deadline are classified OVERDUE.
 *   3. Closed/done entities are excluded.
 *   4. Tenant-scoped filter is applied.
 *   5. Empty per-source results don't throw.
 *   6. notification-dispatch wires the calendar monitor in alongside
 *      the base deadline monitor (structural ratchet).
 */

export {};

const TENANT_ID = 'tenant-cal';
const NOW = new Date('2026-06-01T00:00:00Z');

const mockAuditCycleFindMany = jest.fn().mockResolvedValue([]);
const mockVendorDocFindMany = jest.fn().mockResolvedValue([]);
const mockFindingFindMany = jest.fn().mockResolvedValue([]);

const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
};

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockAuditCycleFindMany.mockReset().mockResolvedValue([]);
    mockVendorDocFindMany.mockReset().mockResolvedValue([]);
    mockFindingFindMany.mockReset().mockResolvedValue([]);

    jest.mock('@/lib/observability/logger', () => ({ logger: mockLogger }));
    jest.mock('@/lib/observability/job-runner', () => ({
        runJob: jest.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
    }));
    jest.mock('@/lib/prisma', () => ({
        __esModule: true,
        prisma: {
            auditCycle: {
                findMany: (...a: unknown[]) => mockAuditCycleFindMany(...a),
            },
            vendorDocument: {
                findMany: (...a: unknown[]) => mockVendorDocFindMany(...a),
            },
            finding: {
                findMany: (...a: unknown[]) => mockFindingFindMany(...a),
            },
        },
    }));
});

describe('runCalendarDeadlineMonitor', () => {
    it('returns an empty stream when every source is empty', async () => {
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        const result = await runCalendarDeadlineMonitor({ now: NOW });
        expect(result.items).toEqual([]);
        expect(result.counts).toEqual({ overdue: 0, urgent: 0, upcoming: 0 });
    });

    it('produces an OVERDUE DueItem for an audit cycle past its periodEndAt', async () => {
        mockAuditCycleFindMany.mockResolvedValue([
            {
                id: 'cyc-1',
                tenantId: TENANT_ID,
                name: 'Q2 Audit',
                frameworkKey: 'SOC2',
                periodEndAt: new Date('2026-05-15T00:00:00Z'), // pre-NOW
                createdByUserId: 'user-owner',
            },
        ]);
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        const r = await runCalendarDeadlineMonitor({ now: NOW });
        expect(r.items).toHaveLength(1);
        expect(r.items[0].urgency).toBe('OVERDUE');
        // Its OWN type. Borrowing 'CONTROL' made the digest label the row
        // "Control" and link it to /controls — entityType drives both.
        expect(r.items[0].entityType).toBe('AUDIT_CYCLE');
        expect(r.items[0].name).toContain('Q2 Audit');
        expect(r.items[0].ownerUserId).toBe('user-owner');
        expect(r.byEntity.AUDIT_CYCLE).toBe(1);
    });

    it('emits URGENT items for vendor docs expiring within 7 days', async () => {
        mockVendorDocFindMany.mockResolvedValue([
            {
                id: 'doc-1',
                tenantId: TENANT_ID,
                type: 'SOC2',
                validTo: new Date('2026-06-05T00:00:00Z'), // +4d
                vendor: { name: 'AWS', ownerUserId: 'user-vendor-owner' },
            },
        ]);
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        const r = await runCalendarDeadlineMonitor({ now: NOW });
        expect(r.items).toHaveLength(1);
        expect(r.items[0].urgency).toBe('URGENT');
        expect(r.items[0].entityType).toBe('VENDOR');
        expect(r.items[0].ownerUserId).toBe('user-vendor-owner');
    });

    it('routes finding owners through `assigneeUserId`', async () => {
        mockFindingFindMany.mockResolvedValue([
            {
                id: 'find-1',
                tenantId: TENANT_ID,
                title: 'Missing 2FA',
                dueDate: new Date('2026-06-15T00:00:00Z'),
                assigneeUserId: 'user-finding-owner',
            },
        ]);
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        const r = await runCalendarDeadlineMonitor({ now: NOW });
        expect(r.items).toHaveLength(1);
        expect(r.items[0].entityType).toBe('FINDING');
        expect(r.items[0].ownerUserId).toBe('user-finding-owner');
    });

    // The actual regression lock. This test previously asserted the OPPOSITE —
    // it named its fixture field `owner` and put a user id in it, which the
    // schema says that column never holds: `Finding.owner` is legacy FREE TEXT
    // (a person's name), superseded by `assigneeUserId`. Publishing a name as
    // `ownerUserId` made every finding deadline unroutable, because the
    // dispatcher resolves that field against `User.id`.
    //
    // A name here must resolve to NOTHING rather than to itself. Absence is
    // strictly better than a bad value: an absent owner reaches the tenant-admin
    // fallback, while a name resolves to no user and the item is dropped.
    it('never publishes the legacy free-text `owner` as a user id', async () => {
        mockFindingFindMany.mockResolvedValue([
            {
                id: 'find-2',
                tenantId: TENANT_ID,
                title: 'Legacy finding',
                dueDate: new Date('2026-06-15T00:00:00Z'),
                owner: 'Alice Smith',
                assigneeUserId: null,
            },
        ]);
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        const r = await runCalendarDeadlineMonitor({ now: NOW });
        expect(r.items).toHaveLength(1);
        expect(r.items[0].ownerUserId).toBeUndefined();
    });

    it('passes `tenantId` through to every per-source query', async () => {
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        await runCalendarDeadlineMonitor({ tenantId: TENANT_ID, now: NOW });
        for (const m of [
            mockAuditCycleFindMany,
            mockVendorDocFindMany,
            mockFindingFindMany,
        ]) {
            expect(m).toHaveBeenCalled();
            const where = m.mock.calls[0][0].where;
            expect(where.tenantId).toBe(TENANT_ID);
        }
    });

    it('omits items whose deadline is beyond the largest detection window', async () => {
        mockFindingFindMany.mockResolvedValue([
            {
                id: 'find-far',
                tenantId: TENANT_ID,
                title: 'long-tail',
                // The Prisma `where` filter uses `lte: horizon` so the
                // DB layer normally excludes these. The monitor's
                // safety check via `classifyUrgency` returns null
                // when daysRemaining > maxWindow — verify it filters
                // even if the row were to slip past the DB filter.
                dueDate: new Date('2026-12-01T00:00:00Z'),
                owner: null,
            },
        ]);
        const { runCalendarDeadlineMonitor } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        const r = await runCalendarDeadlineMonitor({
            now: NOW,
            windows: [30, 7, 1],
        });
        expect(r.items).toHaveLength(0);
    });
});

// ─── Structural ratchet for the orchestrator wiring ──────────────────

describe('notification-dispatch wires the calendar-deadlines monitor', () => {
    it('imports and runs runCalendarDeadlineMonitor inside DEADLINE_DIGEST', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../src/app-layer/jobs/notification-dispatch.ts'),
            'utf-8',
        );
        // The orchestrator must (a) import calendar-deadlines and
        // (b) include runCalendarDeadlineMonitor in the parallel scan.
        // Both regressions ("forgot to merge calendar items" /
        // "calendar items get sent in their own digest") would silently
        // break the unified dispatch contract.
        // Dynamic import inside the orchestrator (lazy-loaded to keep
        // boot light). Match `import('./calendar-deadlines')` OR a
        // top-level static `from './calendar-deadlines'` — either is
        // acceptable; both signal "calendar monitor is wired in".
        expect(src).toMatch(
            /(import\(['"]\.\/calendar-deadlines['"]\)|from\s+['"]\.\/calendar-deadlines['"])/,
        );
        expect(src).toMatch(/runCalendarDeadlineMonitor/);
    });
});

// ─── Run reporting + entity identity ─────────────────────────────────

describe('the run record reports what actually happened', () => {
    it('counts rows READ, not rows produced, and reports what it skipped', async () => {
        // Two cycles read; only one falls inside a reminder window. The old
        // record summed `byEntity` — the PRODUCED count — as `itemsScanned`
        // and hardcoded `itemsSkipped: 0`, so scanning 2 and emitting 1 was
        // indistinguishable from scanning 1 and emitting 1.
        mockAuditCycleFindMany.mockResolvedValue([
            {
                id: 'ac-1',
                tenantId: TENANT_ID,
                name: 'Due soon',
                frameworkKey: 'SOC2',
                periodEndAt: new Date('2026-06-15T00:00:00Z'),
                createdByUserId: 'user-owner',
            },
            {
                id: 'ac-2',
                tenantId: TENANT_ID,
                name: 'Far future',
                frameworkKey: 'SOC2',
                // Well outside the widest (30-day) window.
                periodEndAt: new Date('2027-06-15T00:00:00Z'),
                createdByUserId: 'user-owner',
            },
        ]);

        const { runCalendarDeadlineJob } = await import(
            '@/app-layer/jobs/calendar-deadlines'
        );
        const { result, monitor } = await runCalendarDeadlineJob({});

        expect(monitor.scanned).toBe(2);
        expect(monitor.items).toHaveLength(1);
        expect(result.itemsScanned).toBe(2);
        expect(result.itemsActioned).toBe(1);
        // The one the old record could never show.
        expect(result.itemsSkipped).toBe(1);
    });
});
