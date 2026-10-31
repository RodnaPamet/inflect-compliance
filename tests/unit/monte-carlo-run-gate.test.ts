/**
 * #4768 — running a simulation is a write.
 *
 * A run stores the result the dashboard and the board read as the
 * portfolio's figure, replacing the previous one. `runSimulation` asserted
 * read alone, so any Reader or Auditor could replace the board's headline.
 */
const runInTenantContext = jest.fn();
jest.mock('@/lib/db-context', () => ({
    runInTenantContext: (...args: unknown[]) => runInTenantContext(...args),
}));

import { runSimulation } from '@/app-layer/usecases/monte-carlo';
import { makeRequestContext } from '../helpers/make-context';

beforeEach(() => runInTenantContext.mockReset());

describe('runSimulation — write gate', () => {
    it.each(['READER', 'AUDITOR'] as const)('refuses a %s before reading anything', async (role) => {
        await expect(runSimulation(makeRequestContext(role), { iterations: 100 })).rejects.toThrow(/permission/i);
        expect(runInTenantContext).not.toHaveBeenCalled();
    });

    it('lets an Editor through to the read', async () => {
        runInTenantContext.mockRejectedValue(new Error('reached the read'));
        await expect(runSimulation(makeRequestContext('EDITOR'), { iterations: 100 })).rejects.toThrow('reached the read');
        expect(runInTenantContext).toHaveBeenCalled();
    });
});
