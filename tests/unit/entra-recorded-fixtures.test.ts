/**
 * EI-4 — anchor the hermetic Graph mocks to Microsoft's real response shapes.
 *
 * `tests/helpers/entra.ts` mocks the Graph boundary with shapes WE author, so a
 * drift between our assumptions and Microsoft's actual JSON would pass silently.
 * These fixtures are the documented Graph / token shapes (no live capture was
 * available — see tests/fixtures/entra/README.md); this test runs them through
 * the REAL parsing code so that when a redacted live capture replaces the JSON
 * verbatim, any shape drift fails CI instead of breaking production.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fetchUserGroupsFromGraph } from '@/lib/auth/entra-graph';
import { resolveEntraGroupClaims } from '@/lib/auth/entra-group-claims';

const FIX = path.resolve(__dirname, '../fixtures/entra');
const readFix = (f: string) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf-8'));

// The resolver records a metric + logs; mute those side-effects.
jest.mock('@/lib/observability/metrics', () => ({
    __esModule: true,
    recordEntraGroupResolution: jest.fn(),
}));
jest.mock('@/lib/observability/edge-logger', () => ({
    __esModule: true,
    edgeLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const okJson = (body: unknown) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

describe('Entra recorded fixtures parse through the real code', () => {
    it('memberOf-page.json has the keys fetchUserGroupsFromGraph relies on', () => {
        const page = readFix('memberOf-page.json');
        expect(Array.isArray(page.value)).toBe(true);
        // Bracket access — the key literally contains a dot, so toHaveProperty
        // (which treats '.' as a path separator) would misread it.
        expect(page['@odata.nextLink']).toBeDefined();
        for (const item of page.value) expect(item.id).toBeDefined();
    });

    it('fetchUserGroupsFromGraph follows the fixture nextLink and extracts every id', async () => {
        const page = readFix('memberOf-page.json');
        const expectedIds = page.value.map((v: { id: string }) => v.id);

        const fetchImpl = jest
            .fn()
            .mockResolvedValueOnce(okJson(page)) // page 1 (carries @odata.nextLink)
            .mockResolvedValueOnce(okJson({ value: [] })); // terminal page via nextLink

        const read = await fetchUserGroupsFromGraph('tok', fetchImpl as unknown as typeof fetch);

        // The `microsoft.graph.group` typed endpoint returns groups only, so
        // every id in the page is a group id and all are kept.
        expect(read.groups.map((g) => g.id)).toEqual(expectedIds);
        // A recorded page plus its terminal page IS the whole membership, so
        // the read reports itself complete and the caller may act on it (#5600).
        expect(read.complete).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('overage-claim-names.json triggers the overage Graph path in resolveEntraGroupClaims', async () => {
        const overage = readFix('overage-claim-names.json');
        expect(overage._claim_names?.groups).toBeTruthy();
        expect(overage._claim_sources?.[overage._claim_names.groups]).toHaveProperty('endpoint');

        const memberOf = readFix('memberOf-page.json');
        const fetchImpl = jest
            .fn()
            .mockResolvedValueOnce(okJson(memberOf))
            .mockResolvedValueOnce(okJson({ value: [] }));

        const res = await resolveEntraGroupClaims(
            { profile: overage, accessToken: 'graph-tok' },
            { fetchImpl: fetchImpl as unknown as typeof fetch },
        );

        expect(res.overage).toBe(true); // the `_claim_names` marker drove the Graph fetch
        expect(res.groups.length).toBeGreaterThan(0);
    });
});
