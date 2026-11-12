/**
 * `readFanOutCap` — what a run's fan-out cap reads as (#5376).
 *
 * This PINS TODAY'S BEHAVIOUR; it does not endorse it. On a failed settings
 * read the reader returns the product default (3), and that default can be
 * WIDER than the cap the tenant stored: a tenant that set 0 ("no delegation")
 * or 1 is allowed three delegations per turn for as long as its row cannot be
 * read. The file's header argues for the default over "no cap"; it does not
 * weigh the default against the tenant's own narrower choice. Whether a failed
 * read should fail to the default or fail narrow (0) is an owner question,
 * raised on #5376. If that decision changes the behaviour, the failing case
 * below is the one to rewrite — deliberately.
 */
const mockFindUnique = jest.fn();
jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: { tenantSecuritySettings: { findUnique: (...a: unknown[]) => mockFindUnique(...a) } },
}));
const mockWarn = jest.fn();
jest.mock('@/lib/observability/logger', () => ({
    logger: { warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { readFanOutCap } from '@/lib/agentic/subagent-fanout-policy';
import { DEFAULT_MAX_SUBAGENTS_PER_TURN } from '@/lib/agentic/subagent-fanout';

beforeEach(() => jest.clearAllMocks());

describe('readFanOutCap', () => {
    it('reads the tenant row by tenant id, selecting only the cap', async () => {
        mockFindUnique.mockResolvedValue({ agentMaxSubagentsPerTurn: 1 });
        await expect(readFanOutCap('t1', 'r1')).resolves.toBe(1);
        expect(mockFindUnique).toHaveBeenCalledWith({
            where: { tenantId: 't1' },
            select: { agentMaxSubagentsPerTurn: true },
        });
    });

    it.each([0, 1, 2, 7])('returns the stored cap %i as stored', async (cap) => {
        mockFindUnique.mockResolvedValue({ agentMaxSubagentsPerTurn: cap });
        await expect(readFanOutCap('t1', undefined)).resolves.toBe(cap);
        expect(mockWarn).not.toHaveBeenCalled();
    });

    it('an absent settings row reads as the product default', async () => {
        mockFindUnique.mockResolvedValue(null);
        await expect(readFanOutCap('t1', undefined)).resolves.toBe(DEFAULT_MAX_SUBAGENTS_PER_TURN);
        expect(mockWarn).not.toHaveBeenCalled();
    });

    it('TODAY: a failed read returns the product default — WIDER than a tenant cap of 0 — and logs it', async () => {
        // The tenant's stored cap is 0, but the read never gets that far.
        mockFindUnique.mockRejectedValue(new Error('connection reset'));
        const cap = await readFanOutCap('t-narrow', 'req-9');

        expect(cap).toBe(DEFAULT_MAX_SUBAGENTS_PER_TURN);
        expect(cap).toBeGreaterThan(0);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(
            'subagent-fanout: settings read failed, using the product default',
            expect.objectContaining({
                tenantId: 't-narrow',
                requestId: 'req-9',
                cap: DEFAULT_MAX_SUBAGENTS_PER_TURN,
                error: 'connection reset',
            }),
        );
    });

    it('never throws, whatever the read throws', async () => {
        mockFindUnique.mockRejectedValue('not even an Error');
        await expect(readFanOutCap('t1', undefined)).resolves.toBe(DEFAULT_MAX_SUBAGENTS_PER_TURN);
    });
});
