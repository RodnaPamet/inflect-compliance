/**
 * #5196 — a truncated read may fail an internal check, never pass one.
 *
 * The personnel, training and device checks read their population with a cap.
 * They used to read exactly the cap, so a tenant past it was judged on a slice
 * and could PASS. Each now reads one row past the cap; a PASSED verdict over a
 * truncated read is ERROR, and a FAILED one stands.
 */
const findMany = {
    employee: jest.fn(),
    connectedIdentityAccount: jest.fn(),
    trainingAssignment: jest.fn(),
    backgroundCheck: jest.fn(),
    device: jest.fn(),
};
jest.mock('@/lib/prisma', () => ({
    prisma: Object.fromEntries(Object.entries(findMany).map(([k, fn]) => [k, { findMany: fn }])),
}));

import { PersonnelProvider } from '@/app-layer/integrations/providers/personnel';
import { TrainingProvider } from '@/app-layer/integrations/providers/training';
import { DeviceProvider } from '@/app-layer/integrations/providers/device';
import { INTERNAL_CHECK_READ_CAP } from '@/app-layer/integrations/providers/internal-check-read-cap';
import type { CheckInput } from '@/app-layer/integrations/types';

const input = (provider: string, checkType: string): CheckInput => ({
    automationKey: `${provider}.${checkType}`,
    parsed: { provider, checkType, raw: `${provider}.${checkType}` },
    tenantId: 'tenant-1',
    connectionConfig: {},
    triggeredBy: 'manual',
});

const rows = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
const employee = (i: number, manager: string | null = 'm-1') => ({
    workEmail: `p${i}@acme.test`, status: 'ACTIVE', managerEmployeeId: manager, startDate: new Date('2025-01-01'),
});
const device = (i: number) => ({
    serialNumber: `s${i}`, hostname: `h${i}`, platform: 'macos',
    diskEncrypted: true, screenLockEnabled: true, antivirusRunning: true, passwordManagerPresent: true,
});

beforeEach(() => {
    for (const fn of Object.values(findMany)) fn.mockReset().mockResolvedValue([]);
});

describe('personnel', () => {
    it('asks for one row past the cap', async () => {
        findMany.employee.mockResolvedValue(rows(3, (i) => employee(i)));
        await new PersonnelProvider().runCheck(input('personnel', 'every_employee_has_manager'));
        expect(findMany.employee.mock.calls[0][0].take).toBe(INTERNAL_CHECK_READ_CAP + 1);
        expect(findMany.connectedIdentityAccount.mock.calls[0][0].take).toBe(INTERNAL_CHECK_READ_CAP + 1);
    });

    it('a read past the cap that would PASS is ERROR', async () => {
        findMany.employee.mockResolvedValue(rows(INTERNAL_CHECK_READ_CAP + 1, (i) => employee(i)));
        const result = await new PersonnelProvider().runCheck(input('personnel', 'every_employee_has_manager'));
        expect(result.status).toBe('ERROR');
        expect(result.details).toMatchObject({ truncated: true });
    });

    it('a read past the cap that FAILS still fails', async () => {
        findMany.employee.mockResolvedValue(rows(INTERNAL_CHECK_READ_CAP + 1, (i) => employee(i, i === 0 ? null : 'm-1')));
        const result = await new PersonnelProvider().runCheck(input('personnel', 'every_employee_has_manager'));
        expect(result.status).toBe('FAILED');
    });

    it('exactly the cap is the whole population and may pass', async () => {
        findMany.employee.mockResolvedValue(rows(INTERNAL_CHECK_READ_CAP, (i) => employee(i)));
        const result = await new PersonnelProvider().runCheck(input('personnel', 'every_employee_has_manager'));
        expect(result.status).toBe('PASSED');
    });
});

describe('training', () => {
    it('a background-check read past the cap that would PASS is ERROR', async () => {
        findMany.backgroundCheck.mockResolvedValue(
            rows(INTERNAL_CHECK_READ_CAP + 1, (i) => ({ employeeId: `e${i}`, status: 'CLEAR', employee: { workEmail: `p${i}@acme.test` } })),
        );
        const result = await new TrainingProvider().runCheck(input('training', 'background_check_complete'));
        expect(findMany.backgroundCheck.mock.calls[0][0].take).toBe(INTERNAL_CHECK_READ_CAP + 1);
        expect(result.status).toBe('ERROR');
    });
});

describe('device', () => {
    it('a device read past the cap that would PASS is ERROR', async () => {
        findMany.device.mockResolvedValue(rows(INTERNAL_CHECK_READ_CAP + 1, device));
        const result = await new DeviceProvider().runCheck(input('device', 'devices_encrypted'));
        expect(findMany.device.mock.calls[0][0].take).toBe(INTERNAL_CHECK_READ_CAP + 1);
        expect(result.status).toBe('ERROR');
    });
});
