/* eslint-disable @typescript-eslint/no-explicit-any -- test mocks and Prisma
 * adapter shims that mirror runtime contracts. Per-line typing has poor
 * cost/benefit in test files; the file-level disable is this repo's standard
 * pattern for these surfaces. */

/**
 * An audit's scheduling metadata is editable after creation.
 *
 * THE DEFECT
 * ----------
 * `CreateAuditSchema` accepted `schedule`, `departments`, `frameworkKey` and
 * `auditCycleId`. `UpdateAuditSchema` accepted none of them, and it ends in
 * `.strip()` — so a PUT carrying those keys returned **200 with the fields
 * silently discarded**. No 400, no log, nothing to notice. Since there is no
 * other write path, all four were write-once: a mis-typed audit date or an
 * audit attached to the wrong cycle could only be corrected by deleting the
 * audit, which takes its checklist and findings with it.
 *
 * The silence is the reason this needs a behavioural test rather than a
 * schema-shape assertion. A test that only checked "the schema has a
 * `schedule` key" would pass against a usecase that parses the field and then
 * never forwards it to the repository — which is exactly the failure the
 * `.strip()` produced one layer up.
 *
 * So each assertion below goes end-to-end through `updateAudit` and reads what
 * actually reached `db.audit.update`.
 */

const mockDbHolder: { db: any } = { db: null };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: any, fn: (db: any) => any) => fn(mockDbHolder.db)),
}));

jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

jest.mock('@/lib/observability/business-metrics', () => ({
    recordAuditCycleStarted: jest.fn(),
    recordFindingRaised: jest.fn(),
}));

jest.mock('@/lib/cache/list-cache', () => ({
    bumpEntityCacheVersion: jest.fn(),
    cachedListRead: jest.fn(),
}));

import { UpdateAuditSchema } from '@/lib/schemas';
import { updateAudit } from '@/app-layer/usecases/audit';
import { makeRequestContext } from '../helpers/make-context';

const ctx = makeRequestContext('ADMIN');

const EXISTING = {
    id: 'audit-1',
    tenantId: ctx.tenantId,
    title: 'Q3 internal audit',
    status: 'PLANNED',
};

/** Captures the `data` payload the repository hands to Prisma. */
function dbWithAudit(opts: { cycleIds?: string[] } = {}) {
    const writes: any[] = [];
    mockDbHolder.db = {
        audit: {
            findFirst: jest.fn(async () => EXISTING),
            update: jest.fn(async ({ data }: any) => {
                writes.push(data);
                return { ...EXISTING, ...data };
            }),
        },
        auditCycle: {
            findFirst: jest.fn(async ({ where }: any) =>
                (opts.cycleIds ?? []).includes(where.id) ? { id: where.id } : null,
            ),
        },
        auditChecklistItem: { findMany: jest.fn(async () => []), updateMany: jest.fn() },
        auditLog: { create: jest.fn(), findFirst: jest.fn(async () => null) },
    };
    return writes;
}

describe('the four fields survive the HTTP boundary', () => {
    // `.strip()` is what silently ate them. Parse each through the real
    // schema — if a field is dropped here, no usecase change can save it.
    it.each([
        ['schedule', '2026-09-14'],
        ['departments', 'Engineering, Finance'],
        ['frameworkKey', 'ISO27001'],
        ['auditCycleId', 'cycle-1'],
    ])('%s is not stripped from the update payload', (field, value) => {
        const parsed = UpdateAuditSchema.parse({ [field]: value });
        expect(parsed).toHaveProperty(field, value);
    });

    it('an explicit null is preserved — clearing a field is a real edit', () => {
        const parsed = UpdateAuditSchema.parse({
            schedule: null,
            departments: null,
            frameworkKey: null,
            auditCycleId: null,
        });
        expect(parsed.schedule).toBeNull();
        expect(parsed.departments).toBeNull();
        expect(parsed.frameworkKey).toBeNull();
        expect(parsed.auditCycleId).toBeNull();
    });

    it('still rejects a frameworkKey past the 60-char Framework.key budget', () => {
        expect(UpdateAuditSchema.safeParse({ frameworkKey: 'x'.repeat(61) }).success).toBe(false);
    });
});

describe('updateAudit writes them through to the row', () => {
    beforeEach(() => jest.clearAllMocks());

    it('persists a corrected schedule as a Date', async () => {
        const writes = dbWithAudit();
        await updateAudit(ctx, 'audit-1', { schedule: '2026-09-14' });
        expect(writes).toHaveLength(1);
        expect(writes[0].schedule).toBeInstanceOf(Date);
        expect((writes[0].schedule as Date).toISOString()).toContain('2026-09-14');
    });

    it('persists departments and frameworkKey', async () => {
        const writes = dbWithAudit();
        await updateAudit(ctx, 'audit-1', {
            departments: 'Engineering, Finance',
            frameworkKey: 'SOC2',
        });
        expect(writes[0].departments).toBe('Engineering, Finance');
        expect(writes[0].frameworkKey).toBe('SOC2');
    });

    it('re-attaches the audit to a cycle the tenant owns', async () => {
        const writes = dbWithAudit({ cycleIds: ['cycle-1'] });
        await updateAudit(ctx, 'audit-1', { auditCycleId: 'cycle-1' });
        expect(writes[0].auditCycleId).toBe('cycle-1');
    });

    it('clears a field when sent an explicit null', async () => {
        // Distinct from "absent". A user who deletes a wrong date must be able
        // to leave it empty, not be forced to pick another wrong one.
        const writes = dbWithAudit();
        await updateAudit(ctx, 'audit-1', {
            schedule: null,
            departments: null,
            frameworkKey: null,
            auditCycleId: null,
        });
        expect(writes[0].schedule).toBeNull();
        expect(writes[0].departments).toBeNull();
        expect(writes[0].frameworkKey).toBeNull();
        expect(writes[0].auditCycleId).toBeNull();
    });

    it('leaves an untouched field alone rather than nulling it', async () => {
        // The three-state contract. A PUT that only changes the title must not
        // wipe the schedule — `undefined` has to reach Prisma as "no change".
        const writes = dbWithAudit();
        await updateAudit(ctx, 'audit-1', { title: 'Renamed audit' });
        expect(writes[0].title).toBe('Renamed audit');
        expect(writes[0].schedule).toBeUndefined();
        expect(writes[0].departments).toBeUndefined();
        expect(writes[0].frameworkKey).toBeUndefined();
        expect(writes[0].auditCycleId).toBeUndefined();
    });

    it('sanitises departments and frameworkKey before persistence', async () => {
        // Epic D.2 — both reach audit-log details and PDF exports. Create
        // sanitises them; update must not be the hole.
        const writes = dbWithAudit();
        await updateAudit(ctx, 'audit-1', {
            departments: '<img src=x onerror=alert(1)>Finance',
            frameworkKey: '<script>alert(1)</script>ISO27001',
        });
        expect(writes[0].departments).not.toMatch(/<img|onerror/i);
        expect(writes[0].frameworkKey).not.toMatch(/<script/i);
    });
});

describe('the cycle reference is tenant-scoped on update, as it is on create', () => {
    beforeEach(() => jest.clearAllMocks());

    it('rejects a cycle the tenant does not own', async () => {
        // Without this, widening the schema would have handed callers a way to
        // point an audit at a foreign cycle — RLS blocks the read, so the
        // audit would simply render with a cycle it can never resolve.
        // Same failure shape `createAudit` raises — `badRequest(code, detail)`
        // puts the machine-readable code in `message`.
        const writes = dbWithAudit({ cycleIds: ['cycle-mine'] });
        await expect(
            updateAudit(ctx, 'audit-1', { auditCycleId: 'cycle-theirs' }),
        ).rejects.toThrow('INVALID_AUDIT_CYCLE');
        expect(writes).toHaveLength(0);
    });

    it('detaching (null) needs no cycle lookup', async () => {
        const writes = dbWithAudit();
        await updateAudit(ctx, 'audit-1', { auditCycleId: null });
        expect(mockDbHolder.db.auditCycle.findFirst).not.toHaveBeenCalled();
        expect(writes[0].auditCycleId).toBeNull();
    });
});
