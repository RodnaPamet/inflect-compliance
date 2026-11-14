/**
 * EI-1 — Graph helper: cursor pagination, de-dup, fail-open.
 */
import { fetchUserGroupsFromGraph, lookupGroupFromGraph } from '@/lib/auth/entra-graph';

function jsonRes(body: unknown, ok = true): Response {
    return { ok, json: async () => body } as unknown as Response;
}

describe('fetchUserGroupsFromGraph', () => {
    it('concatenates all pages following @odata.nextLink', async () => {
        const fetchImpl = jest
            .fn()
            .mockResolvedValueOnce(
                jsonRes({ value: [{ id: 'g1' }, { id: 'g2' }], '@odata.nextLink': 'https://graph/p2' }),
            )
            .mockResolvedValueOnce(jsonRes({ value: [{ id: 'g3' }] }));

        const groups = await fetchUserGroupsFromGraph('tok', fetchImpl as unknown as typeof fetch);
        expect(groups.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('de-duplicates ids that appear across pages', async () => {
        const fetchImpl = jest
            .fn()
            .mockResolvedValueOnce(jsonRes({ value: [{ id: 'g1' }], '@odata.nextLink': 'x' }))
            .mockResolvedValueOnce(jsonRes({ value: [{ id: 'g1' }, { id: 'g2' }] }));
        const groups = await fetchUserGroupsFromGraph('tok', fetchImpl as unknown as typeof fetch);
        expect(groups.map((g) => g.id)).toEqual(['g1', 'g2']);
    });

    it('sends the bearer token', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(jsonRes({ value: [] }));
        await fetchUserGroupsFromGraph('my-token', fetchImpl as unknown as typeof fetch);
        expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer my-token');
    });

    it('fails open ([]) on a non-OK response or transport error', async () => {
        const bad = jest.fn().mockResolvedValue(jsonRes({}, false));
        expect(await fetchUserGroupsFromGraph('t', bad as unknown as typeof fetch)).toEqual([]);
        const threw = jest.fn().mockRejectedValue(new Error('network'));
        expect(await fetchUserGroupsFromGraph('t', threw as unknown as typeof fetch)).toEqual([]);
    });

    it('caps pagination at maxPages (runaway guard)', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(
            jsonRes({ value: [{ id: 'g' }], '@odata.nextLink': 'loop' }),
        );
        const groups = await fetchUserGroupsFromGraph('t', fetchImpl as unknown as typeof fetch, 3);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        // Pages left unread: the list is incomplete, so nothing is resolved.
        expect(groups).toEqual([]);
    });

    it('a failure after the first page returns [], never the partial list (#5306)', async () => {
        const throttled = jest
            .fn()
            .mockResolvedValueOnce(jsonRes({ value: [{ id: 'editors' }], '@odata.nextLink': 'https://graph/p2' }))
            .mockResolvedValueOnce(jsonRes({}, false));
        expect(await fetchUserGroupsFromGraph('t', throttled as unknown as typeof fetch)).toEqual([]);

        const dropped = jest
            .fn()
            .mockResolvedValueOnce(jsonRes({ value: [{ id: 'editors' }], '@odata.nextLink': 'https://graph/p2' }))
            .mockRejectedValueOnce(new Error('socket hang up'));
        expect(await fetchUserGroupsFromGraph('t', dropped as unknown as typeof fetch)).toEqual([]);
    });
});

describe('lookupGroupFromGraph', () => {
    it('returns id + displayName', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(jsonRes({ id: 'g1', displayName: 'Leads' }));
        expect(await lookupGroupFromGraph('t', 'g1', fetchImpl as unknown as typeof fetch)).toEqual({
            id: 'g1',
            displayName: 'Leads',
        });
    });
    it('returns null on failure', async () => {
        const fetchImpl = jest.fn().mockResolvedValue(jsonRes({}, false));
        expect(await lookupGroupFromGraph('t', 'g1', fetchImpl as unknown as typeof fetch)).toBeNull();
    });
});
