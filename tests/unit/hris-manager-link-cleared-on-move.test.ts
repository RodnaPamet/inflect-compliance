/**
 * #2879 finding 59 — A MOVE IS A CHANGE OF MANAGER, AND THE SYNC COULD ONLY SET.
 *
 * ═══ THE HOLE ═══
 *
 * `hris-sync` pass 2 resolved `managerEmail` → `managerEmployeeId`. Every
 * branch that failed to resolve one did `continue`, and the only write it could
 * issue was `data: { managerEmployeeId: <id> }`. So the column had no path back
 * to null through the sync: a worker who transferred to a manager outside the
 * synced roster kept their FORMER manager on record indefinitely.
 *
 * ═══ WHY THAT IS NOT COSMETIC ═══
 *
 * `notifications/leaver.ts` addresses the termination notice to
 * `Employee.managerEmployeeId`. It is the one mail this product deliberately
 * aims at exactly one human, and a stale link aims it at a former manager —
 * someone who by definition no longer has any business learning that this
 * person is leaving. The staleness is silent at every other surface, so the
 * disclosure is the first place anybody would notice.
 *
 * ═══ THE THREE CASES, AND WHY SILENCE IS ITS OWN ═══
 *
 * The suite is organised around the distinction the fix rests on, because a
 * two-case reading of it is a REGRESSION rather than a simplification:
 *
 *   · the feed RESOLVES a manager      → link (unchanged behaviour)
 *   · the feed NAMES one we cannot resolve, or names the worker themselves
 *                                      → the feed has just said the manager is
 *                                        not who we hold → CLEAR
 *   · the feed SAYS NOTHING            → leave it alone
 *
 * `managerEmail` is `?: string | null`, so a feed that omits the field is
 * indistinguishable from one that sends it empty. #2492 added a second writer
 * to this column — `personnel.ts::setEmployeeManager` — so clearing on silence
 * would let every scheduled sync quietly undo a manager a human set by hand.
 * That is asserted here as its own test, not as a footnote, because it is the
 * half a future simplification would delete.
 *
 * ═══ AND THE CAP ═══
 *
 * The resolution map is read with `take: MANAGER_MAP_TAKE`. At the cap,
 * "this manager is not an employee here" and "this manager is past row 10000"
 * are the SAME observation, so clearing on a truncated map would sever good
 * links in bulk. Linking is unaffected — a manager that resolved, resolved —
 * and the withheld-clear case is proved against the exported constant rather
 * than a copy of its value.
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
// Spread rather than replace: `markAuthFailure` reaches into this module too,
// and a bare factory silently removes every counter this file does not name.
jest.mock('@/lib/observability/integration-metrics', () => ({
    ...jest.requireActual('@/lib/observability/integration-metrics'),
    recordSyncTruncated: jest.fn(),
}));

import { runHrisSync, MANAGER_MAP_TAKE } from '@/app-layer/usecases/hris-sync';
import type { NormalizedEmployee } from '@/app-layer/integrations/providers/hris';

const mockDb = {
    integrationConnection: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    integrationExecution: { create: jest.fn(), update: jest.fn() },
    employee: { upsert: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
};

const NOW = new Date('2026-09-26T03:00:00.000Z');

/** A roster row. `managerEmail: undefined` is the feed SAYING NOTHING. */
function rosterRow(local: string, managerEmail?: string | null): NormalizedEmployee {
    return {
        externalId: local,
        hrisRecordId: local,
        fullName: `Person ${local}`,
        workEmail: `${local}@acme.test`,
        status: 'ACTIVE',
        department: 'Eng',
        jobTitle: 'Engineer',
        managerEmail: managerEmail ?? null,
        startDate: null,
        endDate: null,
    };
}

/** An existing Employee row as pass 2's map query returns it. */
function dbRow(local: string, managerEmployeeId: string | null) {
    return { id: `id-${local}`, workEmail: `${local}@acme.test`, managerEmployeeId };
}

function stubProvider(employees: NormalizedEmployee[]) {
    return { listEmployees: jest.fn(async () => ({ employees, complete: true, resumeToken: null })) };
}

/** Every manager-link write this pass issued, as `{ id → value written }`. */
function managerWrites(): Array<{ id: unknown; managerEmployeeId: unknown }> {
    return mockDb.employee.update.mock.calls.map((c) => ({
        id: c[0].where.id,
        managerEmployeeId: c[0].data.managerEmployeeId,
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
    mockDb.employee.findMany.mockResolvedValue([]);
    mockDb.employee.update.mockResolvedValue({});
    mockDb.employee.updateMany.mockResolvedValue({ count: 0 });
    mockDb.integrationConnection.updateMany.mockResolvedValue({ count: 1 });
    // Well under the blast-radius cap, so the departure reconcile is never
    // what refuses a pass in this file.
    mockDb.employee.count.mockImplementation(async (args: { where?: { syncedAt?: unknown } }) =>
        args?.where?.syncedAt !== undefined ? 0 : 100,
    );
});

describe('a mover whose new manager is outside the synced roster', () => {
    it('has the stale link CLEARED, so the leaver notice cannot reach the former manager', async () => {
        // `a` reported to `old`. The feed now names a manager this tenant has
        // no employee row for — the transfer-out-of-scope case finding 59
        // describes. The old link is the one thing we KNOW to be wrong.
        mockDb.employee.findMany.mockResolvedValue([dbRow('a', 'id-old'), dbRow('old', null)]);

        const r = await run([rosterRow('a', 'newboss@elsewhere.test')]);

        expect(managerWrites()).toStrictEqual([{ id: 'id-a', managerEmployeeId: null }]);
        expect(r.managersCleared).toBe(1);
        expect(r.managersLinked).toBe(0);
    });

    it('is counted apart from a link, because severing and establishing are opposite events', async () => {
        // One of each in a single pass. A single counter would report 2 and an
        // operator could not tell a run that built two org-chart edges from one
        // that cut one — which is the whole reason the field was added.
        mockDb.employee.findMany.mockResolvedValue([
            dbRow('a', 'id-old'), dbRow('old', null), dbRow('b', null), dbRow('boss', null),
        ]);

        const r = await run([
            rosterRow('a', 'newboss@elsewhere.test'), // unresolvable → clear
            rosterRow('b', 'boss@acme.test'), // resolvable → link
        ]);

        expect(r.managersCleared).toBe(1);
        expect(r.managersLinked).toBe(1);
        expect(managerWrites()).toStrictEqual([
            { id: 'id-a', managerEmployeeId: null },
            { id: 'id-b', managerEmployeeId: 'id-boss' },
        ]);
    });
});

describe('a feed that says nothing about managers', () => {
    it('does NOT clear, because silence is not an assertion — #2492’s human writer survives', async () => {
        // THE REGRESSION GUARD. `a` has a manager a human set through
        // `setEmployeeManager`; this feed never carried `managerEmail` at all.
        // Treating that as "no manager" would undo the human on every run.
        mockDb.employee.findMany.mockResolvedValue([dbRow('a', 'id-handset'), dbRow('handset', null)]);

        const r = await run([rosterRow('a')]);

        expect(managerWrites()).toStrictEqual([]);
        expect(r.managersCleared).toBe(0);
    });
});

describe('a feed that names the worker as their own manager', () => {
    it('clears, because that is how some feeds encode top-of-tree', async () => {
        // Distinct from silence: the feed DID answer, and its answer resolves
        // to nobody above this person. Previously this hit the
        // `managerId === selfId` guard and left the stale link untouched.
        mockDb.employee.findMany.mockResolvedValue([dbRow('a', 'id-old'), dbRow('old', null)]);

        const r = await run([rosterRow('a', 'a@acme.test')]);

        expect(managerWrites()).toStrictEqual([{ id: 'id-a', managerEmployeeId: null }]);
        expect(r.managersCleared).toBe(1);
    });
});

describe('a row with nothing to clear', () => {
    it('is not written at all, so the fix costs no write volume on a steady roster', async () => {
        // The common shape by far: most rows have a null manager already. A
        // clear that wrote null over null would put one UPDATE per employee per
        // run onto every tenant with an unresolvable feed.
        mockDb.employee.findMany.mockResolvedValue([dbRow('a', null)]);

        const r = await run([rosterRow('a', 'newboss@elsewhere.test')]);

        expect(managerWrites()).toStrictEqual([]);
        expect(r.managersCleared).toBe(0);
    });
});

describe('when the resolution map is truncated at the cap', () => {
    /**
     * Exactly `MANAGER_MAP_TAKE` rows — what Prisma returns when there are at
     * least that many. Built from the exported constant so this stays true if
     * the cap moves.
     */
    function cappedMap() {
        const rows = [dbRow('a', 'id-old')];
        while (rows.length < MANAGER_MAP_TAKE) rows.push(dbRow(`filler${rows.length}`, null));
        return rows;
    }

    it('WITHHOLDS the clear, because "not an employee" and "past the cap" are the same observation', async () => {
        mockDb.employee.findMany.mockResolvedValue(cappedMap());

        const r = await run([rosterRow('a', 'newboss@elsewhere.test')]);

        expect(managerWrites()).toStrictEqual([]);
        expect(r.managersCleared).toBe(0);
    });

    it('still LINKS, because a manager that resolved is resolved whatever the cap', async () => {
        // The withholding must be scoped to clears. A fixture that stopped
        // linking too would be a different, worse bug wearing this one's fix.
        const rows = cappedMap();
        rows[1] = dbRow('boss', null);
        mockDb.employee.findMany.mockResolvedValue(rows);

        const r = await run([rosterRow('a', 'boss@acme.test')]);

        expect(managerWrites()).toStrictEqual([{ id: 'id-a', managerEmployeeId: 'id-boss' }]);
        expect(r.managersLinked).toBe(1);
    });
});
