/**
 * `readFanOutCap` — what a run's fan-out cap reads as (#5376).
 *
 * A failed settings read resolves to NO delegation (owner decision,
 * 2026-11-12): the product default (3) it used to fall back to is wider than a
 * tenant that stored 0 ("no delegation") or 1 chose. An absent row still reads
 * as the default — a tenant that never chose.
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

    it('a failed read allows NO delegation — never wider than a tenant cap of 0 — and logs it', async () => {
        // The tenant's stored cap may be 0, but the read never gets that far.
        mockFindUnique.mockRejectedValue(new Error('connection reset'));
        const cap = await readFanOutCap('t-narrow', 'req-9');

        expect(cap).toBe(0);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(
            'subagent-fanout: settings read failed, allowing no delegation',
            expect.objectContaining({
                tenantId: 't-narrow',
                requestId: 'req-9',
                cap: 0,
                error: 'connection reset',
            }),
        );
    });

    it('never throws, whatever the read throws', async () => {
        mockFindUnique.mockRejectedValue('not even an Error');
        await expect(readFanOutCap('t1', undefined)).resolves.toBe(0);
    });
});
