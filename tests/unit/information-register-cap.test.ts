/**
 * #4639 — the Information Registry is read with its cap made visible.
 *
 * `listInformationRegister` reads one row past `INFORMATION_REGISTER_CAP`, so
 * "exactly the cap" and "more than the cap" are told apart, and counts the
 * whole register for the header, so a cut-short list never undercounts the
 * arrangements supporting a critical or important function.
 */
const findMany = jest.fn(async (_args: unknown): Promise<unknown[]> => []);
const count = jest.fn(async (_args: unknown): Promise<number> => 0);
const mockDb = { vendor: { findMany, count } };

jest.mock('@/lib/db-context', () => ({
    runInTenantContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
    runInTenantReadContext: jest.fn(async (_ctx: unknown, fn: (db: unknown) => unknown) => fn(mockDb)),
}));

import { listInformationRegister } from '@/app-layer/usecases/vendor';
import { INFORMATION_REGISTER_CAP } from '@/app-layer/repositories/VendorRepository';
import { CRITICAL_FUNCTION_CRITICALITIES, supportsCriticalFunction } from '@/lib/dora/critical-function';
import { makeRequestContext } from '../helpers/make-context';

const ctx = () => makeRequestContext('READER', { tenantId: 't-1' });
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `v-${i}` }));

beforeEach(() => {
    findMany.mockReset();
    count.mockReset();
});

describe('listInformationRegister', () => {
    it('reads one past the cap, most critical first, and is not truncated at exactly the cap', async () => {
        findMany.mockResolvedValueOnce(rows(INFORMATION_REGISTER_CAP));
        count.mockResolvedValueOnce(INFORMATION_REGISTER_CAP).mockResolvedValueOnce(12);

        const result = await listInformationRegister(ctx());

        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany.mock.calls[0][0]).toMatchObject({
            where: { tenantId: 't-1', deletedAt: null },
            orderBy: [{ criticality: 'desc' }, { name: 'asc' }],
            take: INFORMATION_REGISTER_CAP + 1,
        });
        expect(result.truncated).toBe(false);
        expect(result.rows).toHaveLength(INFORMATION_REGISTER_CAP);
    });

    it('past the cap, returns the cap, says so, and counts the whole register', async () => {
        findMany.mockResolvedValueOnce(rows(INFORMATION_REGISTER_CAP + 1));
        count.mockResolvedValueOnce(1500).mockResolvedValueOnce(640);

        const result = await listInformationRegister(ctx());

        expect(result.truncated).toBe(true);
        expect(result.rows).toHaveLength(INFORMATION_REGISTER_CAP);
        expect(result.total).toBe(1500);
        expect(result.criticalOrImportant).toBe(640);
        expect(count.mock.calls[0][0]).toEqual({ where: { tenantId: 't-1', deletedAt: null } });
        expect(count.mock.calls[1][0]).toEqual({
            where: { tenantId: 't-1', deletedAt: null, criticality: { in: ['CRITICAL', 'HIGH'] } },
        });
    });
});

describe('supportsCriticalFunction', () => {
    it('is the count query’s own set: CRITICAL and HIGH, nothing else', () => {
        expect([...CRITICAL_FUNCTION_CRITICALITIES]).toEqual(['CRITICAL', 'HIGH']);
        expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].filter(supportsCriticalFunction)).toEqual(['CRITICAL', 'HIGH']);
    });
});
