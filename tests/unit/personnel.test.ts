/**
 * PR-4 — personnel checks (pure join logic), HRIS-sync idempotency, and the
 * personnel provider via its injectable data loader.
 */
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));
jest.mock('@/lib/security/encryption', () => ({ decryptField: jest.fn(() => '{}') }));
jest.mock('@/lib/observability/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@/app-layer/integrations/bootstrap', () => ({}));
jest.mock('@/app-layer/integrations/registry', () => ({ registry: { getProvider: jest.fn() } }));

import { runPersonnelCheck, type CheckEmployee, type CheckAccount } from '@/app-layer/integrations/providers/personnel/checks';
import { PersonnelProvider } from '@/app-layer/integrations/providers/personnel';
import { runHrisSync } from '@/app-layer/usecases/hris-sync';
import { listEmployees, createEmployee, getEmployee } from '@/app-layer/usecases/personnel';
import type { NormalizedEmployee } from '@/app-layer/integrations/providers/hris';

const NOW = new Date('2026-06-01T00:00:00.000Z');

const mockDb = {
    integrationConnection: { findFirst: jest.fn(), updateMany: jest.fn(async () => ({ count: 0 })) },
    integrationExecution: { create: jest.fn(), update: jest.fn() },
    // H3 — runHrisSync now reconciles departed employees via updateMany.
    employee: { upsert: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
};

function emp(over: Partial<CheckEmployee>): CheckEmployee {
    return { workEmail: over.workEmail ?? 'a@x.com', status: over.status ?? 'ACTIVE', managerEmployeeId: 'managerEmployeeId' in over ? over.managerEmployeeId ?? null : 'mgr', startDate: 'startDate' in over ? over.startDate ?? null : NOW };
}
function acct(over: Partial<CheckAccount>): CheckAccount {
    return { email: over.email ?? 'a@x.com', status: over.status ?? 'ACTIVE', provider: over.provider ?? 'okta' };
}

describe('runPersonnelCheck', () => {
    it('offboarded_access_removed FAILs an ACTIVE account for a TERMINATED employee', () => {
        const data = {
            employees: [emp({ workEmail: 'gone@x.com', status: 'TERMINATED' })],
            accounts: [acct({ email: 'gone@x.com', status: 'ACTIVE' }), acct({ email: 'ok@x.com', status: 'ACTIVE' })],
        };
        const r = runPersonnelCheck('offboarded_access_removed', data, {}, NOW);
        expect(r.status).toBe('FAILED');
        expect(r.details.failed).toBe(1);
    });

    it('offboarded_access_removed PASSes when the account is already deprovisioned', () => {
        const data = { employees: [emp({ workEmail: 'gone@x.com', status: 'TERMINATED' })], accounts: [acct({ email: 'gone@x.com', status: 'DEPROVISIONED' })] };
        expect(runPersonnelCheck('offboarded_access_removed', data, {}, NOW).status).toBe('PASSED');
    });

    it('onboarding_complete_within_sla FAILs an onboarding employee past the SLA', () => {
        const old = new Date(NOW.getTime() - 100 * 24 * 60 * 60 * 1000);
        const data = { employees: [emp({ status: 'ONBOARDING', startDate: old })], accounts: [] };
        expect(runPersonnelCheck('onboarding_complete_within_sla', data, { onboardingSlaDays: 30 }, NOW).status).toBe('FAILED');
    });

    it('every_employee_has_manager FAILs an active employee with no manager', () => {
        const data = { employees: [emp({ status: 'ACTIVE', managerEmployeeId: null })], accounts: [] };
        expect(runPersonnelCheck('every_employee_has_manager', data, {}, NOW).status).toBe('FAILED');
    });

    it('unknown check ERRORs', () => {
        expect(runPersonnelCheck('nope', { employees: [], accounts: [] }, {}, NOW).status).toBe('ERROR');
    });
});

describe('PersonnelProvider', () => {
    it('runCheck applies the check to the injected data', async () => {
        const provider = new PersonnelProvider({
            load: async () => ({ employees: [emp({ workEmail: 'gone@x.com', status: 'TERMINATED' })], accounts: [acct({ email: 'gone@x.com', status: 'ACTIVE' })] }),
            now: () => NOW,
        });
        const r = await provider.runCheck({ automationKey: 'personnel.offboarded_access_removed', parsed: { provider: 'personnel', checkType: 'offboarded_access_removed', raw: '' }, tenantId: 't1', connectionConfig: {}, triggeredBy: 'scheduled' });
        expect(r.status).toBe('FAILED');
        expect(provider.supportedChecks).toContain('offboarded_access_removed');
    });
});

describe('runHrisSync', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', provider: 'bamboohr', configJson: {}, secretEncrypted: null });
        mockDb.integrationExecution.create.mockResolvedValue({ id: 'exec-1' });
        mockDb.integrationExecution.update.mockResolvedValue({});
        mockDb.employee.upsert.mockResolvedValue({});
        mockDb.employee.update.mockResolvedValue({});
        mockDb.employee.findMany.mockResolvedValue([
            { id: 'e-alice', workEmail: 'alice@x.com' },
            { id: 'e-bob', workEmail: 'bob@x.com' },
        ]);
    });

    function stub(roster: NormalizedEmployee[], complete = true, resumeToken: string | null = null) {
        return { listEmployees: jest.fn(async () => ({ employees: roster, complete, resumeToken })) };
    }
    /** An earlier run of the same pass — deliberately before NOW. */
    const PASS_START = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
    function nEmp(over: Partial<NormalizedEmployee>): NormalizedEmployee {
        return { externalId: over.externalId ?? '1', fullName: over.fullName ?? 'X', workEmail: over.workEmail ?? 'x@x.com', status: over.status ?? 'ACTIVE', managerEmail: over.managerEmail ?? null, startDate: null, endDate: null };
    }

    it('upserts by (tenantId, workEmail) and links managers by email', async () => {
        const provider = stub([
            nEmp({ workEmail: 'alice@x.com' }),
            nEmp({ workEmail: 'bob@x.com', managerEmail: 'alice@x.com' }),
        ]);
        const r = await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });
        expect(r.status).toBe('PASSED');
        expect(r.upserted).toBe(2);
        expect(mockDb.employee.upsert.mock.calls[0][0].where.tenantId_workEmail).toEqual({ tenantId: 't1', workEmail: 'alice@x.com' });
        // bob's manager resolved to alice's id
        expect(r.managersLinked).toBe(1);
        expect(mockDb.employee.update).toHaveBeenCalledWith({ where: { id: 'e-bob' }, data: { managerEmployeeId: 'e-alice' } });
    });

    it('errors cleanly for a non-HRIS connection', async () => {
        mockDb.integrationConnection.findFirst.mockResolvedValue({ id: 'conn-1', provider: 'github', configJson: {}, secretEncrypted: null });
        const r = await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stub([]) });
        expect(r.status).toBe('ERROR');
        expect(mockDb.employee.upsert).not.toHaveBeenCalled();
    });

    it('H3 — reconciles departed (deleted-from-BambooHR) employees to TERMINATED on a complete roster', async () => {
        const provider = stub([nEmp({ workEmail: 'alice@x.com' })], true);
        await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });
        // Departure reconcile ran: HRIS employees not in the roster → TERMINATED.
        expect(mockDb.employee.updateMany).toHaveBeenCalled();
        const call = mockDb.employee.updateMany.mock.calls[0][0];
        expect(call.where).toMatchObject({ source: 'HRIS', status: { not: 'TERMINATED' } });
        // Reconciles on the PASS START, not on `workEmail: { notIn: roster }`.
        //
        // The notIn form was correct only while a pass was a single run. Once
        // a truncated roster can resume, `roster` is just the LAST run's
        // slice, so notIn would terminate every employee upserted by every
        // earlier run of the same pass. Anything untouched since the pass
        // began was absent across all of its runs, so it is genuinely gone.
        expect(call.where.syncedAt).toEqual({ lt: NOW });
        expect(call.where.workEmail).toBeUndefined();
        expect(call.data.status).toBe('TERMINATED');
    });

    it('H3-2 — a truncated roster WITH a resume token is PARTIAL, stores the cursor, and skips the reconcile', async () => {
        // The branch HRIS never had. Before this, any roster past the cap was
        // a permanent ERROR+noRetry, so a customer large enough to exceed it
        // had a provider that could never succeed on any run.
        const provider = stub([nEmp({ workEmail: 'alice@x.com' })], false, 'cursor-500');
        const r = await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        expect(r.status).toBe('PARTIAL');
        // Progress, not failure: what we saw is upserted...
        expect(mockDb.employee.upsert).toHaveBeenCalled();
        // ...the cursor is stored so the next run continues this pass...
        expect(mockDb.integrationConnection.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ syncCursor: 'cursor-500' }),
            }),
        );
        // ...and NOTHING is reconciled, because a partial pass has not seen
        // the whole roster and cannot conclude anyone left.
        expect(mockDb.employee.updateMany).not.toHaveBeenCalled();
    });

    it('H3 — a TRUNCATED roster fails ERROR and does NOT run the departure reconcile', async () => {
        const provider = stub([nEmp({ workEmail: 'alice@x.com' })], false); // complete=false
        const r = await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });
        expect(r.status).toBe('ERROR');
        expect(mockDb.employee.updateMany).not.toHaveBeenCalled(); // no mass-terminate on partial roster
        expect(mockDb.employee.upsert).toHaveBeenCalled(); // but seen rows still upserted
    });

    it('the LAST run of a resumed pass reconciles even though its own slice is empty', async () => {
        // The failure resume introduced, on the guard that was correct before it.
        //
        // A run stops at the per-run cap and stores a cursor. If the roster
        // size is an exact multiple of that cap, the NEXT run requests from an
        // offset at the end of the report, gets zero rows, and correctly
        // reports `complete: true` with nothing in hand. The old
        // `roster.length > 0` guard read that as the empty-response glitch it
        // was written for, skipped the reconcile, cleared the cursor and
        // reported PASSED — so for that tenant the departure reconcile never
        // ran again, on any night, and deleted employees stayed ACTIVE forever.
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1', provider: 'bamboohr', configJson: {}, secretEncrypted: null,
            syncCursor: '5000', syncPassStartedAt: PASS_START,
        });
        const provider = stub([], true);
        const r = await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });

        expect(r.status).toBe('PASSED');
        expect(mockDb.employee.updateMany).toHaveBeenCalled();
        // Against the PASS start, not this run's `now` — otherwise the rows the
        // earlier runs of this same pass upserted would themselves be departed.
        expect(mockDb.employee.updateMany.mock.calls[0][0].where.syncedAt).toEqual({ lt: PASS_START });
    });

    it('a FIRST-run empty roster still skips the reconcile — the glitch case is unchanged', async () => {
        // The case the guard was originally for: no cursor, no pass in flight,
        // and the API answered with nothing. That is far more likely to be a
        // broken report or a revoked report permission than a company that
        // fired everyone, so it must never mass-terminate.
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1', provider: 'bamboohr', configJson: {}, secretEncrypted: null,
            syncCursor: null, syncPassStartedAt: null,
        });
        const r = await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stub([], true) });

        expect(r.status).toBe('PASSED');
        expect(mockDb.employee.updateMany).not.toHaveBeenCalled();
    });

    it('an ABSENT pass marker reads as "not resumed", not as truthy', async () => {
        // `!== null` would read undefined as a resumed pass and make the guard
        // unconditional — reinstating the mass-terminate it exists to prevent,
        // via the one field shape a caller is most likely to omit.
        mockDb.integrationConnection.findFirst.mockResolvedValue({
            id: 'conn-1', provider: 'bamboohr', configJson: {}, secretEncrypted: null,
        });
        await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider: stub([], true) });
        expect(mockDb.employee.updateMany).not.toHaveBeenCalled();
    });

    it('records ERROR (not a throw) when the roster fetch fails', async () => {
        const provider = { listEmployees: jest.fn(async () => { throw new Error('bamboo 401'); }) };
        const r = await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });
        expect(r.status).toBe('ERROR');
        expect(r.errorMessage).toContain('bamboo 401');
    });
});

describe('personnel usecase exports', () => {
    it('exposes list/create/get', () => {
        expect(typeof listEmployees).toBe('function');
        expect(typeof createEmployee).toBe('function');
        expect(typeof getEmployee).toBe('function');
    });
});
