/**
 * #2492 — `setEmployeeManager`: the manager field's update path.
 *
 * Three things are under test, and the third is the one the issue turned on.
 *
 *  1. The write itself — set, clear, and the four refusals (no permission,
 *     unknown employee, a manager from another tenant, self-reference).
 *
 *  2. `status` is unreachable. The operator decision on #2492 was that the new
 *     path must not be able to write it, because `TERMINATED` is what makes a
 *     worker a candidate for a real disable in a customer's directory and
 *     CLAUDE.md's one-write-seam rule exists at exactly that column. Asserted
 *     behaviourally here (the schema refuses the key; the Prisma call carries
 *     one column) and structurally in
 *     `tests/guards/employee-status-single-write-seam.test.ts`.
 *
 *  3. PRECEDENCE between this path and the HRIS sync. The decision: the feed
 *     wins when it speaks, the manual value stands when it does not. That is
 *     the behaviour `hris-sync.ts` already had — its manager pass writes only
 *     for roster rows whose `managerEmail` resolves, and never writes null —
 *     so this change introduced no precedence, it settled and pinned one. Both
 *     directions are exercised below against the real `runHrisSync`, because
 *     an argument about which writer wins is worth nothing unless the losing
 *     direction is shown not to fire.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/app-layer/events/audit', () => ({
    logEvent: jest.fn(async () => undefined),
}));
jest.mock('@/lib/security/encryption', () => ({
    decryptField: jest.fn(() => '{}'),
    encryptField: jest.fn((s: string) => s),
}));
jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('@/app-layer/integrations/bootstrap', () => ({}));
jest.mock('@/app-layer/integrations/registry', () => ({ registry: { getProvider: jest.fn() } }));

import {
    setEmployeeManager,
    SetEmployeeManagerSchema,
} from '@/app-layer/usecases/personnel';
import { runHrisSync } from '@/app-layer/usecases/hris-sync';
import { logEvent } from '@/app-layer/events/audit';
import { makeRequestContext } from '../helpers/make-context';
import type { NormalizedEmployee } from '@/app-layer/integrations/providers/hris';

const NOW = new Date('2026-09-12T05:00:00.000Z');

/** A real cuid shape — the schema validates the format, so 'e-bob' would 400. */
const WORKER = 'ckt0000000000000000000001';
const MANAGER = 'ckt0000000000000000000002';
const OUTSIDER = 'ckt0000000000000000000003';

const mockDb = {
    employee: {
        // The blast-radius cap (#2838) counts twice, and the two calls differ
        // ONLY by `syncedAt`: the numerator is the not-seen-this-pass set, the
        // denominator is the whole live HRIS population. A single stubbed
        // number makes them equal, so share = 1.0 and the cap refuses every
        // run — these suites then report PARTIAL, not their expected PASSED.
        //
        // Answer the two queries as reality would: one straggler against a
        // population of a thousand. That is below TERMINATE_SHARE_FLOOR, so
        // the cap stays silent by the floor rather than by a tuned share —
        // which is what these suites want, since none of them tests the cap.
        count: jest.fn(async (args?: { where?: { syncedAt?: unknown } }) =>
            args?.where?.syncedAt ? 1 : 1000,
        ),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn(),
    },
    integrationConnection: {
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
    },
    integrationExecution: { create: jest.fn(), update: jest.fn() },
};

const admin = makeRequestContext('ADMIN');

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.employee.updateMany.mockResolvedValue({ count: 0 });
    mockDb.employee.upsert.mockResolvedValue({});
    mockDb.employee.findMany.mockResolvedValue([]);
    mockDb.integrationConnection.update.mockResolvedValue({});
    mockDb.integrationConnection.updateMany.mockResolvedValue({ count: 0 });
    mockDb.integrationExecution.update.mockResolvedValue({});
});

/** The worker row, then (when asked for a second time) the manager row. */
function resolveWorkerThenManager(manager: { id: string } | null) {
    mockDb.employee.findFirst
        .mockResolvedValueOnce({
            id: WORKER,
            fullName: 'Bob Worker',
            workEmail: 'bob@x.com',
            managerEmployeeId: null,
        })
        .mockResolvedValueOnce(manager);
}

describe('setEmployeeManager — the write', () => {
    it('sets the manager and records the change with before + after', async () => {
        resolveWorkerThenManager({ id: MANAGER });
        mockDb.employee.update.mockResolvedValue({
            id: WORKER,
            fullName: 'Bob Worker',
            workEmail: 'bob@x.com',
            managerEmployeeId: MANAGER,
        });

        const result = await setEmployeeManager(admin, WORKER, { managerEmployeeId: MANAGER });

        expect(result.managerEmployeeId).toBe(MANAGER);
        expect(mockDb.employee.update).toHaveBeenCalledTimes(1);
        const call = mockDb.employee.update.mock.calls[0][0];
        expect(call.where).toEqual({ id: WORKER });
        // The KEY SET, not merely "no status". Rail 2 of #2492 is that the
        // Prisma literal names one column; a write that had silently gained a
        // second would satisfy a `not.toHaveProperty('status')`.
        expect(Object.keys(call.data)).toStrictEqual(['managerEmployeeId']);
        expect(call.data.managerEmployeeId).toBe(MANAGER);

        const audit = (logEvent as jest.Mock).mock.calls[0][2];
        expect(audit.action).toBe('UPDATE');
        expect(audit.entityType).toBe('Employee');
        expect(audit.detailsJson.changedFields).toStrictEqual(['managerEmployeeId']);
        expect(audit.detailsJson.before).toEqual({ managerEmployeeId: null });
        expect(audit.detailsJson.after).toEqual({ managerEmployeeId: MANAGER });
    });

    it('clears the manager on null, without looking a manager up', async () => {
        mockDb.employee.findFirst.mockResolvedValueOnce({
            id: WORKER,
            fullName: 'Bob Worker',
            workEmail: 'bob@x.com',
            managerEmployeeId: MANAGER,
        });
        mockDb.employee.update.mockResolvedValue({
            id: WORKER,
            fullName: 'Bob Worker',
            workEmail: 'bob@x.com',
            managerEmployeeId: null,
        });

        await setEmployeeManager(admin, WORKER, { managerEmployeeId: null });

        // One lookup only: the worker. Null is "reports to nobody", so there
        // is no second row to validate.
        expect(mockDb.employee.findFirst).toHaveBeenCalledTimes(1);
        expect(mockDb.employee.update.mock.calls[0][0].data).toEqual({ managerEmployeeId: null });
    });

    it('refuses a caller without personnel.manage, before touching the database', async () => {
        const editor = makeRequestContext('EDITOR');
        expect(editor.appPermissions?.personnel?.manage).toBe(false);

        await expect(
            setEmployeeManager(editor, WORKER, { managerEmployeeId: MANAGER }),
        ).rejects.toThrow(/permission/i);
        expect(mockDb.employee.findFirst).not.toHaveBeenCalled();
        expect(mockDb.employee.update).not.toHaveBeenCalled();
    });

    it('refuses an employee that is not in this tenant', async () => {
        mockDb.employee.findFirst.mockResolvedValueOnce(null);

        await expect(
            setEmployeeManager(admin, WORKER, { managerEmployeeId: MANAGER }),
        ).rejects.toThrow(/Employee not found/);
        expect(mockDb.employee.update).not.toHaveBeenCalled();
    });

    it('refuses a manager that is not in this tenant', async () => {
        // The FK is not tenant-scoped, so the database would accept this id.
        // The tenant-scoped read is what refuses it.
        resolveWorkerThenManager(null);

        await expect(
            setEmployeeManager(admin, WORKER, { managerEmployeeId: OUTSIDER }),
        ).rejects.toThrow(/Manager not found/);
        expect(mockDb.employee.update).not.toHaveBeenCalled();
    });

    it('refuses an employee as their own manager', async () => {
        mockDb.employee.findFirst.mockResolvedValueOnce({
            id: WORKER,
            fullName: 'Bob Worker',
            workEmail: 'bob@x.com',
            managerEmployeeId: null,
        });

        await expect(
            setEmployeeManager(admin, WORKER, { managerEmployeeId: WORKER }),
        ).rejects.toThrow(/own manager/);
        expect(mockDb.employee.update).not.toHaveBeenCalled();
    });
});

describe('setEmployeeManager — `status` is not reachable', () => {
    it('refuses a body carrying status rather than silently dropping it', () => {
        // .strict(), not .strip(): a caller who sends `status` must be told it
        // was refused. A stripped field looks, from the outside, exactly like
        // an applied one.
        expect(() =>
            SetEmployeeManagerSchema.parse({ managerEmployeeId: MANAGER, status: 'TERMINATED' }),
        ).toThrow();
        // …and the accepted shape still parses, so the assertion above is
        // about the extra key and not about the schema rejecting everything.
        expect(SetEmployeeManagerSchema.parse({ managerEmployeeId: MANAGER })).toEqual({
            managerEmployeeId: MANAGER,
        });
    });

    it('declares exactly one key', () => {
        expect(Object.keys(SetEmployeeManagerSchema.shape)).toStrictEqual(['managerEmployeeId']);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// PRECEDENCE
// ─────────────────────────────────────────────────────────────────────────

describe('precedence between the manual path and the HRIS feed', () => {
    function nEmp(over: Partial<NormalizedEmployee>): NormalizedEmployee {
        return {
            externalId: over.externalId ?? '1',
            fullName: over.fullName ?? 'X',
            workEmail: over.workEmail ?? 'x@x.com',
            status: over.status ?? 'ACTIVE',
            managerEmail: over.managerEmail ?? null,
            startDate: null,
            endDate: null,
        };
    }
    function stub(roster: NormalizedEmployee[]) {
        return { listEmployees: jest.fn(async () => ({ employees: roster, complete: true, resumeToken: null })) };
    }

    beforeEach(() => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1',
            provider: 'bamboohr',
            configJson: {},
            secretEncrypted: null,
            syncCursor: null,
            syncPassStartedAt: null,
        });
        mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-1' });
        // Bob already has a MANUALLY set manager — Alice. The roster is what
        // varies between the two tests below.
        mockDb.employee.findMany.mockResolvedValue([
            { id: MANAGER, workEmail: 'alice@x.com' },
            { id: WORKER, workEmail: 'bob@x.com' },
            { id: OUTSIDER, workEmail: 'carol@x.com' },
        ]);
    });

    it('the feed WINS when it names a manager — it overwrites the manual value', async () => {
        const r = await runHrisSync({
            tenantId: 'tenant-1',
            connectionId: 'conn-1',
            now: NOW,
            provider: stub([
                nEmp({ workEmail: 'carol@x.com' }),
                nEmp({ workEmail: 'bob@x.com', managerEmail: 'carol@x.com' }),
            ]),
        });

        expect(r.status).toBe('PASSED');
        expect(r.managersLinked).toBe(1);
        // Carol, from the feed — not Alice, whoever set her by hand.
        expect(mockDb.employee.update).toHaveBeenCalledWith({
            where: { id: WORKER },
            data: { managerEmployeeId: OUTSIDER },
        });
    });

    it('the manual value STANDS when the feed is silent — the sync writes no manager', async () => {
        const r = await runHrisSync({
            tenantId: 'tenant-1',
            connectionId: 'conn-1',
            now: NOW,
            provider: stub([nEmp({ workEmail: 'bob@x.com', managerEmail: null })]),
        });

        // The positive half: the pass really ran and really touched Bob, so
        // the absence below is a decision and not an empty selection.
        expect(r.status).toBe('PASSED');
        expect(r.upserted).toBe(1);
        expect(r.managersLinked).toBe(0);
        // The sync never nulls the column, so a manager set by hand survives
        // every pass that does not name one.
        expect(mockDb.employee.update).not.toHaveBeenCalled();
        const upsertArgs = mockDb.employee.upsert.mock.calls[0][0];
        expect(Object.keys(upsertArgs.update)).not.toContain('managerEmployeeId');
    });
});
