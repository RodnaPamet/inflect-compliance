/**
 * Route → executor → job → pass, for the joiner (#2895).
 *
 * The leaver's version of this fix was verified at both ends and inert in the
 * middle for weeks: the route built the payload correctly, the usecase
 * consumed it correctly, and the executor between them silently dropped the
 * field. Nothing walked the chain, and the chain was where it broke.
 *
 * The joiner had the same hole one layer further out — no payload field at all
 * — so this suite exists before the equivalent bug can be introduced rather
 * than after. It mocks only the leaf usecase; the executor and the job layer
 * run for real, because those are the two seams that have no other coverage.
 */
import { executorRegistry } from '@/app-layer/jobs/executor-registry';

const mockRunPass = jest.fn();

jest.mock('@/lib/observability/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('@/app-layer/jobs/queue', () => ({ enqueue: jest.fn() }));

// Over a requireActual spread: a subset mock here would drop the other exports
// of a usecase module this suite does not name, and the failure would surface
// somewhere else entirely (#2897).
jest.mock('@/app-layer/usecases/identity-joiner-run', () => ({
    ...jest.requireActual('@/app-layer/usecases/identity-joiner-run'),
    runIdentityJoinerPass: (...args: unknown[]) => mockRunPass(...args),
}));

const JOB = 'identity-joiner-pass';

const RESULT = {
    status: 'PASSED',
    mode: 'DRY_RUN',
    starters: 2,
    wouldCreate: 1,
    decisions: [],
};

describe('a joiner requester survives every hop to the pass', () => {
    beforeEach(() => {
        mockRunPass.mockReset();
        mockRunPass.mockResolvedValue(RESULT);
    });

    it('drives the real executor, not a stand-in', () => {
        expect(executorRegistry.has(JOB)).toBe(true);
    });

    it('carries a named requester through the executor AND the job layer', async () => {
        await executorRegistry.execute(JOB, {
            tenantId: 't-1',
            provider: 'entra-id',
            requestedByUserId: 'user-42',
        });

        expect(mockRunPass).toHaveBeenCalledTimes(1);
        expect(mockRunPass.mock.calls[0][0]).toEqual(
            expect.objectContaining({ requestedByUserId: 'user-42' }),
        );
    });

    it('leaves it absent for the 04:30 dispatch', async () => {
        await executorRegistry.execute(JOB, { tenantId: 't-1', provider: 'entra-id' });

        // Absent, not invented. The scheduled path has nobody to name and
        // must not borrow one.
        expect(mockRunPass.mock.calls[0][0]).toEqual(
            expect.objectContaining({ requestedByUserId: undefined }),
        );
    });

    it('still scopes the pass to the tenant and provider it was given', async () => {
        // The naming discipline at the registration exists to keep a scoped
        // job scoped. Adding a field must not have loosened that.
        await executorRegistry.execute(JOB, {
            tenantId: 't-9',
            provider: 'active-directory',
            requestedByUserId: 'user-7',
        });

        expect(mockRunPass.mock.calls[0][0]).toEqual(
            expect.objectContaining({ tenantId: 't-9', provider: 'active-directory' }),
        );
    });
});
