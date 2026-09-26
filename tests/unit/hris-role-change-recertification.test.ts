/**
 * #2879 finding 58 — a move now asks somebody to look.
 *
 * The finding: "nothing recomputes access after a move and the compensating
 * control is manual-only — no job ever creates an access-review campaign".
 * #2927 gave the pass a way to KNOW a role changed; this is what it does about
 * it.
 *
 * ═══ A TASK, NOT A CAMPAIGN ═══
 *
 * `createConnectedAccessReview` scopes by PROVIDER, so a campaign triggered by
 * one transfer would put every account in that directory in front of a
 * reviewer. That is how a control becomes noise and then becomes ignored. The
 * task names the count and points at the audit trail; choosing the right
 * campaign is a judgement the reviewer makes with those rows in front of them.
 *
 * ═══ EVERY REFUSAL LANDS ON THE ROW ═══
 *
 * The assertions that matter most here are the negative ones. A pass that
 * quietly raises nothing is the same silence the finding is about, with more
 * code behind it — so `NO_OWNER` and `OWNER_NOT_ACTIVE` are values an operator
 * can read on the execution, not branches that return early.
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
jest.mock('@/app-layer/events/audit', () => ({ logEvent: jest.fn() }));

const mockResolveOwner = jest.fn();
jest.mock('@/app-layer/usecases/recertification-owner', () => ({
    resolveRecertificationOwner: (...a: unknown[]) => mockResolveOwner(...a),
}));
const mockCreateTask = jest.fn();
jest.mock('@/app-layer/usecases/task', () => ({
    ...jest.requireActual('@/app-layer/usecases/task'),
    createTask: (...a: unknown[]) => mockCreateTask(...a),
}));

import { runHrisSync } from '@/app-layer/usecases/hris-sync';
import type { NormalizedEmployee } from '@/app-layer/integrations/providers/hris';

const mockDb = {
    integrationConnection: { findFirst: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    integrationExecution: { create: jest.fn(), update: jest.fn() },
    employee: { upsert: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
};

const NOW = new Date('2026-09-26T03:00:00.000Z');

function rosterRow(local: string, over: Partial<NormalizedEmployee> = {}): NormalizedEmployee {
    return {
        externalId: local, hrisRecordId: local, fullName: `Person ${local}`,
        workEmail: `${local}@acme.test`, status: 'ACTIVE',
        department: 'Eng', jobTitle: 'Engineer', managerEmail: null,
        startDate: null, endDate: null, ...over,
    };
}

/** Pass 1's prior-role read is told apart by its `select`, never by call order. */
function priorRoles(rows: Array<{ id: string; workEmail: string; department: string | null; jobTitle: string | null }>) {
    return async (args: { select?: Record<string, unknown> }) =>
        args?.select?.department !== undefined ? rows.map((r) => ({ fullName: 'P', ...r })) : [];
}

function stubProvider(employees: NormalizedEmployee[]) {
    return { listEmployees: jest.fn(async () => ({ employees, complete: true, resumeToken: null })) };
}

const run = (roster: NormalizedEmployee[]) =>
    runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stubProvider(roster) });

/** A roster whose one row moved department, so `roleChanges` is 1. */
const AMOVED = () => {
    mockDb.employee.findMany.mockImplementation(
        priorRoles([{ id: 'id-a', workEmail: 'a@acme.test', department: 'Sales', jobTitle: 'Engineer' }]),
    );
    return [rosterRow('a')];
};

beforeEach(() => {
    jest.clearAllMocks();
    mockDb.integrationConnection.findFirst.mockResolvedValue({
        id: 'conn-1', provider: 'bamboohr', configJson: {}, secretEncrypted: null,
        syncCursor: null, syncPassStartedAt: null,
    });
    mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-1' });
    mockDb.integrationExecution.update.mockResolvedValue({});
    mockDb.employee.upsert.mockResolvedValue({});
    mockDb.employee.findMany.mockImplementation(priorRoles([]));
    mockDb.employee.update.mockResolvedValue({});
    mockDb.employee.updateMany.mockResolvedValue({ count: 0 });
    mockDb.integrationConnection.updateMany.mockResolvedValue({ count: 1 });
    mockDb.employee.count.mockImplementation(async (args: { where?: { syncedAt?: unknown } }) =>
        args?.where?.syncedAt !== undefined ? 0 : 100,
    );
    mockResolveOwner.mockResolvedValue({ kind: 'ready', userId: 'u1', ctx: { userId: 'u1', tenantId: 't1' } });
    mockCreateTask.mockResolvedValue({ id: 'task-1' });
});

describe('when workers moved and an owner is nominated', () => {
    it('raises ONE task naming the count, and reports RAISED', async () => {
        const r = await run(AMOVED());

        expect(mockCreateTask).toHaveBeenCalledTimes(1);
        expect(mockCreateTask.mock.calls[0][1].title).toContain('1');
        expect(r.recertification).toBe('RAISED');
    });

    it('acts as the OWNER, not as the sync’s system context', async () => {
        // The whole point of the setting: `Task.createdByUserId` is NOT NULL,
        // and a synthetic principal fails on the constraint at runtime.
        const ownerCtx = { userId: 'u1', tenantId: 't1' };
        mockResolveOwner.mockResolvedValue({ kind: 'ready', userId: 'u1', ctx: ownerCtx });

        await run(AMOVED());

        expect(mockCreateTask.mock.calls[0][0]).toBe(ownerCtx);
    });
});

describe('when nothing moved', () => {
    it('asks for no owner and raises nothing — recertification stays null', async () => {
        // Saying NO_OWNER on every quiet night would train people to ignore it.
        const r = await run([rosterRow('a')]);

        expect(r.roleChanges).toBe(0);
        expect(mockResolveOwner).not.toHaveBeenCalled();
        expect(mockCreateTask).not.toHaveBeenCalled();
        expect(r.recertification).toBeNull();
    });
});

describe('when the recertification cannot be raised', () => {
    it('reports NO_OWNER rather than passing silently', async () => {
        mockResolveOwner.mockResolvedValue({ kind: 'unset' });

        const r = await run(AMOVED());

        expect(mockCreateTask).not.toHaveBeenCalled();
        expect(r.recertification).toBe('NO_OWNER');
    });

    it('reports OWNER_NOT_ACTIVE — distinct from nobody being nominated', async () => {
        // A tenant that cannot tell "we never configured this" from "the person
        // we configured has left" cannot fix either.
        mockResolveOwner.mockResolvedValue({ kind: 'unresolvable', userId: 'u-gone' });

        const r = await run(AMOVED());

        expect(r.recertification).toBe('OWNER_NOT_ACTIVE');
    });

    it('reports OWNER_CANNOT_CREATE_TASKS when the nominee lacks the authority', async () => {
        // A READER who holds the tenant clears `resolveMemberContext` and then
        // fails `assertCanCreateTask`. That is the right refusal and the wrong
        // way to learn about it.
        mockCreateTask.mockRejectedValue(new Error('You do not have permission to create tasks.'));

        const r = await run(AMOVED());

        expect(r.recertification).toBe('OWNER_CANNOT_CREATE_TASKS');
    });

    it('NEVER fails the sync — the mirror the leaver pass reads still stands', async () => {
        // This runs after the roster is written. A follow-up that could roll
        // back an offboarding-critical mirror would be a worse bug than the
        // one it fixes.
        mockCreateTask.mockRejectedValue(new Error('database exploded'));

        const r = await run(AMOVED());

        expect(r.status).toBe('PASSED');
        expect(r.upserted).toBe(1);
        expect(r.recertification).toBe('FAILED');
    });
});
