/**
 * #2879 / #2881 finding 14 — the product's only TRUE role-change signal.
 *
 * ═══ WHY A NEW ROW, WHEN EVERY UPSERT IS ALREADY AUDITED ═══
 *
 * `lib/prisma.ts` carries a `$allModels` audit extension over every write, so
 * the HRIS upserts have always produced audit rows. Those rows cannot answer
 * "who moved", by construction:
 *
 *     export function extractChangedFields(data) {
 *         return Object.keys(data).filter((key) => !key.startsWith('_'));
 *     }
 *
 * `changedFields` is the keys of the PAYLOAD, not a diff — nothing reads the
 * prior row. The upsert's update arm names ten columns unconditionally, so
 * every audit row it writes claims `department` and `jobTitle` changed, for
 * every employee, on every run. A worker who really transferred is recorded
 * identically to the ones who did not.
 *
 * So the assertion that carries this suite is the NEGATIVE one: an unchanged
 * employee must produce NO row. A signal that fires on everybody is the defect
 * being fixed, not a noisier version of the fix.
 *
 * ═══ HOW THE FIXTURES DISPATCH ═══
 *
 * `employee.findMany` now has TWO call sites — pass 1's prior-role read and
 * pass 2's manager map. They are told apart by their PREDICATE, never by call
 * order, for the same reason `hris-terminate-blast-radius` dispatches its two
 * counts that way: an assertion keyed to call index keeps passing if the two
 * queries are swapped.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/lib/security/encryption', () => ({
    decryptField: jest.fn(() => '{}'),
    encryptField: jest.fn((s: string) => s),
}));
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/app-layer/integrations/bootstrap', () => ({}));
jest.mock('@/app-layer/integrations/registry', () => ({ registry: { getProvider: jest.fn() } }));
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordSyncTruncated: jest.fn(),
}));
// Complete, not partial: `logEvent` is this module's only runtime export.
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

import { runHrisSync } from '@/app-layer/usecases/hris-sync';
import { logEvent } from '@/app-layer/events/audit';
import type { NormalizedEmployee } from '@/app-layer/integrations/providers/hris';

const mockDb = {
    integrationConnection: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    integrationExecution: { create: jest.fn(), update: jest.fn() },
    employee: { upsert: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
};

const NOW = new Date('2026-09-26T03:00:00.000Z');

function rosterRow(local: string, over: Partial<NormalizedEmployee> = {}): NormalizedEmployee {
    return {
        externalId: local,
        hrisRecordId: local,
        fullName: `Person ${local}`,
        workEmail: `${local}@acme.test`,
        status: 'ACTIVE',
        department: 'Eng',
        jobTitle: 'Engineer',
        managerEmail: null,
        startDate: null,
        endDate: null,
        ...over,
    };
}

/** An Employee row as pass 1's prior-role read returns it. */
function priorRow(local: string, department: string | null, jobTitle: string | null) {
    return { id: `id-${local}`, workEmail: `${local}@acme.test`, fullName: `Person ${local}`, department, jobTitle };
}

/**
 * Dispatch on the SELECT, which is what distinguishes the two reads now that
 * both are whole-tenant: pass 1's prior-role map asks for `department`, pass
 * 2's manager map asks for `managerEmployeeId`. Keyed on the query rather than
 * on call order — an assertion keyed to call index would keep passing if the
 * two reads were swapped, which is the confusion worth ruling out.
 */
function findManyBy(priors: ReturnType<typeof priorRow>[]) {
    return async (args: { select?: Record<string, unknown> }) =>
        args?.select?.department !== undefined ? priors : [];
}

/** The prior-role reads this run issued, told apart from the manager map. */
function priorRoleReads() {
    return mockDb.employee.findMany.mock.calls.filter((c) => c[0]?.select?.department !== undefined);
}

function stubProvider(employees: NormalizedEmployee[]) {
    return { listEmployees: jest.fn(async () => ({ employees, complete: true, resumeToken: null })) };
}

/** Every role-change event this pass emitted, flattened to what it claims. */
function emitted() {
    return (logEvent as jest.Mock).mock.calls.map((c) => ({
        entityId: c[2].entityId,
        changedFields: c[2].detailsJson.changedFields,
        before: c[2].detailsJson.before,
        after: c[2].detailsJson.after,
    }));
}

function run(roster: NormalizedEmployee[]) {
    return runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider(roster) });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.integrationConnection.findFirst.mockResolvedValue({
        id: 'conn-1', provider: 'bamboohr', configJson: {}, secretEncrypted: null,
        syncCursor: null, syncPassStartedAt: null,
    });
    mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-1' });
    mockDb.integrationExecution.update.mockResolvedValue({});
    mockDb.employee.upsert.mockResolvedValue({});
    mockDb.employee.findMany.mockImplementation(findManyBy([]));
    mockDb.employee.update.mockResolvedValue({});
    mockDb.employee.updateMany.mockResolvedValue({ count: 0 });
    mockDb.integrationConnection.updateMany.mockResolvedValue({ count: 1 });
    mockDb.employee.count.mockImplementation(async (args: { where?: { syncedAt?: unknown } }) =>
        args?.where?.syncedAt !== undefined ? 0 : 100,
    );
});

describe('an employee whose role actually changed', () => {
    it('emits one event naming ONLY the field that differs, with the real before and after', async () => {
        mockDb.employee.findMany.mockImplementation(findManyBy([priorRow('a', 'Sales', 'Engineer')]));

        const r = await run([rosterRow('a', { department: 'Eng', jobTitle: 'Engineer' })]);

        expect(emitted()).toStrictEqual([
            {
                entityId: 'id-a',
                changedFields: ['department'],
                before: { department: 'Sales' },
                after: { department: 'Eng' },
            },
        ]);
        expect(r.roleChanges).toBe(1);
    });

    it('names both fields when both moved, and neither when only one did', async () => {
        mockDb.employee.findMany.mockImplementation(
            findManyBy([priorRow('a', 'Sales', 'Rep'), priorRow('b', 'Eng', 'Engineer')]),
        );

        const r = await run([
            rosterRow('a', { department: 'Eng', jobTitle: 'Engineer' }), // both
            rosterRow('b', { department: 'Eng', jobTitle: 'Staff Engineer' }), // title only
        ]);

        expect(emitted()).toStrictEqual([
            {
                entityId: 'id-a',
                changedFields: ['department', 'jobTitle'],
                before: { department: 'Sales', jobTitle: 'Rep' },
                after: { department: 'Eng', jobTitle: 'Engineer' },
            },
            {
                entityId: 'id-b',
                changedFields: ['jobTitle'],
                before: { jobTitle: 'Engineer' },
                after: { jobTitle: 'Staff Engineer' },
            },
        ]);
        expect(r.roleChanges).toBe(2);
    });
});

describe('an employee whose role did NOT change', () => {
    it('emits NOTHING — the assertion the whole finding is about', async () => {
        // The generic `$allModels` audit row says `department` and `jobTitle`
        // changed here, because it lists the payload's keys. This signal must
        // not inherit that. If this test ever passes with an event emitted,
        // the row has become the defect it was written to replace.
        mockDb.employee.findMany.mockImplementation(findManyBy([priorRow('a', 'Eng', 'Engineer')]));

        const r = await run([rosterRow('a', { department: 'Eng', jobTitle: 'Engineer' })]);

        expect(emitted()).toStrictEqual([]);
        expect(r.roleChanges).toBe(0);
    });

    it('treats a field the feed omits as equal to a null column, not as a change', async () => {
        // `undefined` from the feed and `null` in the column are the same
        // state, and the upsert writes `?? null`. Comparing them raw would
        // report a move for every employee whose feed carries no department —
        // the same "fires on everybody" failure, arrived at differently.
        mockDb.employee.findMany.mockImplementation(findManyBy([priorRow('a', null, null)]));

        const r = await run([rosterRow('a', { department: undefined, jobTitle: undefined })]);

        expect(emitted()).toStrictEqual([]);
        expect(r.roleChanges).toBe(0);
    });
});

describe('an employee arriving for the first time', () => {
    it('is a joiner, not a mover — no prior row means no event', async () => {
        // Without this, every employee of every tenant's FIRST sync is recorded
        // as having changed role.
        mockDb.employee.findMany.mockImplementation(findManyBy([]));

        const r = await run([rosterRow('a'), rosterRow('b')]);

        expect(emitted()).toStrictEqual([]);
        expect(r.roleChanges).toBe(0);
    });
});

describe('the prior-role read', () => {
    it('is ONE read for the RUN, not one per chunk — the lock lease pays for each', async () => {
        // #2522: `sync-transaction-shape` counts the bookkeeping transactions
        // the sync lease covers, because a run that opens more than the lease
        // pays for lets a second run start alongside it. A per-chunk read would
        // add one per chunk; this must stay at one however long the roster is.
        mockDb.employee.findMany.mockImplementation(findManyBy([priorRow('a', 'Sales', 'Engineer')]));

        await run([rosterRow('a'), rosterRow('b'), rosterRow('c')]);

        expect(priorRoleReads()).toHaveLength(1);
    });

    it('is bounded, and a truncated map under-reports rather than inventing a move', async () => {
        // An employee past the cap has no prior here, so they read as a joiner
        // and emit nothing. A missed move is a gap; a fabricated one would be
        // the defect this signal exists to replace.
        mockDb.employee.findMany.mockImplementation(findManyBy([]));

        await run([rosterRow('a')]);

        expect(priorRoleReads()[0][0].take).toBeGreaterThan(0);
    });

    it('keys the map on the address EXACTLY, as the upsert does — not lowercased', async () => {
        // The upsert keys on `tenantId_workEmail` with the address as the feed
        // sent it. Lowercasing either side would miss a prior row whose stored
        // casing differs, and report that employee as unchanged forever.
        mockDb.employee.findMany.mockImplementation(
            findManyBy([{ id: 'id-a', workEmail: 'Mixed.Case@acme.test', fullName: 'A', department: 'Sales', jobTitle: 'Rep' }]),
        );

        const r = await run([
            rosterRow('a', { workEmail: 'Mixed.Case@acme.test', department: 'Eng', jobTitle: 'Rep' }),
        ]);

        expect(r.roleChanges).toBe(1);
        expect(emitted()).toStrictEqual([
            { entityId: 'id-a', changedFields: ['department'], before: { department: 'Sales' }, after: { department: 'Eng' } },
        ]);
    });
});
