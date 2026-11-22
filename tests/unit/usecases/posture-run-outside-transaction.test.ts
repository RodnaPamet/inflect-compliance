/**
 * #5064 — the cloud benchmark runs outside any database transaction.
 *
 * A Powerpipe benchmark takes minutes; a tenant transaction expires after
 * seconds. Holding one across the run rolled back the RUNNING execution and
 * failed every write after it, so a real collection never recorded anything.
 * The collections now open the run in one short transaction, run the
 * benchmark with none open, and record the result in another.
 */
jest.mock('@/lib/db-context', () => ({
    ...jest.requireActual('@/lib/db-context'),
    runInTenantContext: jest.fn(),
}));
jest.mock('@/lib/security/encryption', () => ({
    ...jest.requireActual('@/lib/security/encryption'),
    decryptField: jest.fn(() => '{}'),
}));
jest.mock('@/app-layer/integrations/connection-health', () => ({
    markAuthFailure: jest.fn(),
    clearAuthFailure: jest.fn(),
}));

import { runInTenantContext } from '@/lib/db-context';
import { runAwsPostureCollection } from '@/app-layer/usecases/aws-posture';
import { runCloudPostureCollection } from '@/app-layer/usecases/cloud-posture';

const runInTenant = runInTenantContext as unknown as jest.Mock;

let openTransactions = 0;
let transactionsOpened = 0;
const db = {
    integrationConnection: {
        findFirst: jest.fn(async () => ({ id: 'conn-1', configJson: { benchmark: 'soc2' }, secretEncrypted: null, isEnabled: true })),
    },
    integrationExecution: {
        create: jest.fn(async () => ({ id: 'exec-1' })),
        update: jest.fn(async () => ({})),
    },
    controlRequirementLink: { findFirst: jest.fn(async () => null) },
    evidence: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    evidenceControlLink: { create: jest.fn() },
    controlEvidenceLink: { create: jest.fn() },
};

beforeEach(() => {
    openTransactions = 0;
    transactionsOpened = 0;
    jest.clearAllMocks();
    runInTenant.mockImplementation(async (_ctx: unknown, cb: (d: unknown) => Promise<unknown>) => {
        openTransactions += 1;
        transactionsOpened += 1;
        try {
            return await cb(db);
        } finally {
            openTransactions -= 1;
        }
    });
});

const passing = { status: 'PASSED' as const, summary: 'ok', details: { counts: { ok: 1, alarm: 0, skip: 0, error: 0, total: 1 }, controls: [] } };

describe.each([
    ['aws-posture', (runCheck: jest.Mock) => runAwsPostureCollection({ tenantId: 't-1', connectionId: 'conn-1', provider: { runCheck } })],
    ['azure-posture', (runCheck: jest.Mock) =>
        runCloudPostureCollection({ cloud: 'azure-posture', tenantId: 't-1', connectionId: 'conn-1', provider: { runCheck }, controlMap: {} })],
])('%s', (_name, collect) => {
    it('runs the benchmark with no transaction open, then records the result', async () => {
        const runCheck = jest.fn(async () => {
            expect(openTransactions).toBe(0);
            return passing;
        });
        const r = await collect(runCheck);
        expect(runCheck).toHaveBeenCalledTimes(1);
        expect(r.status).toBe('PASSED');
        expect(transactionsOpened).toBe(2);
        expect(db.integrationExecution.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'exec-1' }, data: expect.objectContaining({ status: 'PASSED' }) }),
        );
    });

    it('a benchmark that throws is recorded as ERROR in a transaction of its own', async () => {
        const runCheck = jest.fn(async () => {
            expect(openTransactions).toBe(0);
            throw new Error('powerpipe exited 2');
        });
        const r = await collect(runCheck);
        expect(r.status).toBe('ERROR');
        expect(transactionsOpened).toBe(2);
        expect(db.integrationExecution.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'exec-1' }, data: expect.objectContaining({ status: 'ERROR' }) }),
        );
    });
});
