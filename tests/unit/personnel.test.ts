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

    function stub(roster: NormalizedEmployee[], complete = true) {
        return { listEmployees: jest.fn(async () => ({ employees: roster, complete })) };
    }
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
        expect(call.where.workEmail.notIn).toContain('alice@x.com');
        expect(call.data.status).toBe('TERMINATED');
    });

    it('H3 — a TRUNCATED roster fails ERROR and does NOT run the departure reconcile', async () => {
        const provider = stub([nEmp({ workEmail: 'alice@x.com' })], false); // complete=false
        const r = await runHrisSync({ tenantId: 't1', connectionId: 'conn-1', now: NOW, provider });
        expect(r.status).toBe('ERROR');
        expect(mockDb.employee.updateMany).not.toHaveBeenCalled(); // no mass-terminate on partial roster
        expect(mockDb.employee.upsert).toHaveBeenCalled(); // but seen rows still upserted
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
