/**
 * The concurrent-run cap's setter refuses an out-of-range cap with the RULE as
 * its message (#4471).
 *
 * The route used to hold the range as a Zod `int().min(0).max(1000)`, and a Zod
 * refusal reaches the client as "Invalid request payload" with the reason
 * tucked into `details` — which is what the register showed an operator who
 * typed 1001. The setter now refuses first, as the budget's does, so whoever
 * sends the cap reads the limit. Nothing is written for a refused cap.
 */
const upsertMock = jest.fn();
const appendAuditEntryMock = jest.fn();

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantSecuritySettings: {
            upsert: (...a: unknown[]) => upsertMock(...a),
            findUnique: async () => ({ agentMaxConcurrentRuns: 3 }),
        },
    },
}));
// `strictMock`: `@/lib/audit` is a guarded barrel (partial-mock-of-a-guarded-barrel),
// so an export this fixture forgot fails loudly rather than resolving undefined.
jest.mock('@/lib/audit', () =>
    strictMock('@/lib/audit', jest.requireActual('@/lib/audit'), {
        appendAuditEntry: (...a: unknown[]) => appendAuditEntryMock(...a),
    }),
);

import { strictMock } from '../../helpers/strict-mock';
import { setConcurrencyCap } from '@/lib/agentic/run-concurrency-policy';
import { CONCURRENCY_CAP_SETTING_MESSAGE } from '@/lib/agentic/run-concurrency';
import { makeRequestContext } from '../../helpers/make-context';

beforeEach(() => jest.clearAllMocks());

describe('setConcurrencyCap', () => {
    it.each([1001, -1, 2.5])('refuses %p with the rule and its limit, and writes nothing', async (cap) => {
        await expect(setConcurrencyCap(makeRequestContext('ADMIN'), cap)).rejects.toMatchObject({
            status: 400,
            message: CONCURRENCY_CAP_SETTING_MESSAGE,
        });
        expect(upsertMock).not.toHaveBeenCalled();
        expect(appendAuditEntryMock).not.toHaveBeenCalled();
    });

    it('stores the limit itself', async () => {
        await expect(setConcurrencyCap(makeRequestContext('ADMIN'), 1000)).resolves.toEqual({ cap: 1000 });
        expect(upsertMock).toHaveBeenCalledTimes(1);
    });
});
