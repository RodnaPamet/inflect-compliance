/**
 * EI-4 Part A — the jwt-callback group-resolution path, deferred from EI-1.
 *
 * `resolveEntraGroupClaims` is the logic the `microsoft-entra-id` branch of the
 * `auth.ts` jwt callback delegates to. EI-1 unit-tested the pure Graph helper;
 * EI-4 tests the *decision* around it (inline claim vs overage Graph fetch vs
 * fail-open) plus the EI-4 observability wiring, using the shared Entra fixture
 * library — without standing up NextAuth.
 */
import {
    buildEntraProfile,
    buildEntraOverageProfile,
    graphMemberOfFetch,
    graphFailFetch,
} from '../helpers/entra';

const mockRecord = jest.fn();
jest.mock('@/lib/observability/metrics', () => ({
    __esModule: true,
    recordEntraGroupResolution: (...args: unknown[]) => mockRecord(...args),
}));
jest.mock('@/lib/observability/edge-logger', () => ({
    __esModule: true,
    edgeLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { resolveEntraGroupClaims } from '@/lib/auth/entra-group-claims';

beforeEach(() => mockRecord.mockClear());

describe('resolveEntraGroupClaims — inline groups claim', () => {
    it('returns the token groups verbatim with overage=false', async () => {
        const profile = buildEntraProfile(['g-1', 'g-2']);
        const res = await resolveEntraGroupClaims({ profile, accessToken: 'tok' });
        expect(res).toEqual({ groups: ['g-1', 'g-2'], overage: false, complete: true });
    });

    it('records source=token, outcome=resolved with the group count', async () => {
        await resolveEntraGroupClaims({ profile: buildEntraProfile(['g-1', 'g-2']) });
        expect(mockRecord).toHaveBeenCalledTimes(1);
        expect(mockRecord).toHaveBeenCalledWith({
            source: 'token',
            outcome: 'resolved',
            groupCount: 2,
        });
    });

    it('an empty/absent groups claim resolves to [] with outcome=empty', async () => {
        const res = await resolveEntraGroupClaims({ profile: {} });
        expect(res).toEqual({ groups: [], overage: false, complete: true });
        expect(mockRecord).toHaveBeenCalledWith({
            source: 'token',
            outcome: 'empty',
            groupCount: 0,
        });
    });

    it('a non-array groups claim is coerced to [] (defensive)', async () => {
        const res = await resolveEntraGroupClaims({
            profile: { groups: 'not-an-array' as unknown as string[] },
        });
        expect(res.groups).toEqual([]);
    });
});

describe('resolveEntraGroupClaims — overage Graph fetch', () => {
    it('fetches the full membership from Graph and flags overage=true', async () => {
        const fetchImpl = graphMemberOfFetch([
            { ids: ['g-1', 'g-2'], next: true },
            { ids: ['g-3'] },
        ]);
        const res = await resolveEntraGroupClaims(
            { profile: buildEntraOverageProfile(), accessToken: 'graph-tok' },
            { fetchImpl: fetchImpl as unknown as typeof fetch, now: makeClock([100, 180]) },
        );
        expect(res).toEqual({ groups: ['g-1', 'g-2', 'g-3'], overage: true, complete: true });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('records source=graph_overage with the fetch duration', async () => {
        const fetchImpl = graphMemberOfFetch([{ ids: ['g-1'] }]);
        await resolveEntraGroupClaims(
            { profile: buildEntraOverageProfile(), accessToken: 'graph-tok' },
            { fetchImpl: fetchImpl as unknown as typeof fetch, now: makeClock([100, 180]) },
        );
        expect(mockRecord).toHaveBeenCalledWith({
            source: 'graph_overage',
            outcome: 'resolved',
            groupCount: 1,
            graphFetchDurationMs: 80,
        });
    });

    it('fails open to [] on a Graph error — outcome=PARTIAL is the outage signal', async () => {
        const fetchImpl = graphFailFetch();
        const res = await resolveEntraGroupClaims(
            { profile: buildEntraOverageProfile(), accessToken: 'graph-tok' },
            { fetchImpl: fetchImpl as unknown as typeof fetch, now: makeClock([100, 120]) },
        );
        // `complete: false`, and the metric outcome is now `partial` rather
        // than `empty` (#5600). `empty` should mean the directory SAID this
        // user is in no groups — a fact. A failed read is not that fact, and
        // labelling it `empty` was the same conflation as returning a prefix
        // as the whole membership: the one signal this docblock offered
        // operators could not tell an outage from a user with no groups.
        expect(res).toEqual({ groups: [], overage: true, complete: false });
        expect(mockRecord).toHaveBeenCalledWith({
            source: 'graph_overage',
            outcome: 'partial',
            groupCount: 0,
            graphFetchDurationMs: 20,
        });
    });

    it('falls back to the inline path when overage is signalled but no access token exists', async () => {
        // No token ⇒ cannot call Graph ⇒ treat as the (absent) inline claim.
        const res = await resolveEntraGroupClaims({ profile: buildEntraOverageProfile() });
        expect(res).toEqual({ groups: [], overage: false, complete: true });
        expect(mockRecord).toHaveBeenCalledWith({
            source: 'token',
            outcome: 'empty',
            groupCount: 0,
        });
    });
});

/** A deterministic `now()` that returns the given values in order. */
function makeClock(values: number[]): () => number {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
}
