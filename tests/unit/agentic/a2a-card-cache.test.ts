/**
 * The fifteen-minute card copy every A2A message is compared against (#3679;
 * owner decision R18). A copy older than the bound is never used, a failed
 * read is never cached, and a caller can only narrow the bound.
 */
import {
    A2A_CARD_MAX_AGE_MS,
    clearAgentCardCacheForTests,
    recentAgentCard,
} from '@/lib/agentic/a2a/card-cache';

const card = { name: 'P', description: 'd', url: 'https://peer.example/a2a', skills: [] };
const key = { tenantId: 't1', peerId: 'p1', cardUrl: 'https://peer.example/card.json' };

let t = 1_000_000;
const now = () => t;
const fetchImpl = jest.fn(async () => new Response(JSON.stringify(card), { status: 200 }));

beforeEach(() => {
    clearAgentCardCacheForTests();
    fetchImpl.mockClear();
    t = 1_000_000;
});

describe('recentAgentCard', () => {
    it('fetches once, then serves the copy until it is fifteen minutes old', async () => {
        expect((await recentAgentCard(key, { fetchImpl, now })).ok).toBe(true);
        t += A2A_CARD_MAX_AGE_MS;
        expect((await recentAgentCard(key, { fetchImpl, now })).ok).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        t += 1;
        expect((await recentAgentCard(key, { fetchImpl, now })).ok).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('never caches a failed read, so the next message tries again and a failure refuses', async () => {
        const down = jest.fn(async () => new Response('x', { status: 503 }));
        expect(await recentAgentCard(key, { fetchImpl: down, now })).toEqual({ ok: false, reason: 'HTTP_ERROR' });
        expect(await recentAgentCard(key, { fetchImpl: down, now })).toEqual({ ok: false, reason: 'HTTP_ERROR' });
        expect(down).toHaveBeenCalledTimes(2);
    });

    it('a caller may narrow the bound and may not widen it', async () => {
        await recentAgentCard(key, { fetchImpl, now });
        t += 1000;
        await recentAgentCard(key, { fetchImpl, now, maxAgeMs: 500 });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        t += A2A_CARD_MAX_AGE_MS + 1;
        await recentAgentCard(key, { fetchImpl, now, maxAgeMs: 10 * A2A_CARD_MAX_AGE_MS });
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('keys the copy by tenant and peer, so one registration never answers for another', async () => {
        await recentAgentCard(key, { fetchImpl, now });
        await recentAgentCard({ ...key, tenantId: 't2' }, { fetchImpl, now });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
});
