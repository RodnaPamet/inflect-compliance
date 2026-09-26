/**
 * #2877 finding 52 — the unsettled backlog had no surface.
 *
 * `listUnsettledWrites` was written, bounded and tested, and the only thing
 * that ever consulted it was a metrics counter. So the backlog it exists to
 * surface was COUNTED and shown to nobody: a number saying N accounts are in an
 * unknown state cannot say WHICH, and "go and look at the directory" is not an
 * instruction anyone can follow without the list.
 *
 * What these tests pin is the age window, because it is the one place this
 * route can quietly answer the wrong question. A write that has not settled in
 * the last few seconds is a pass still running, not a backlog; a request with a
 * malformed window must get the ordinary answer rather than a 400; and the
 * cutoff has to travel with the response, or an empty list cannot tell an
 * operator whether there is nothing outstanding or whether they asked about the
 * wrong hour.
 */
const mockList = jest.fn();
jest.mock('@/app-layer/usecases/identity-write-journal', () => ({
    listUnsettledWrites: (...a: unknown[]) => mockList(...a),
}));
jest.mock('@/lib/security/permission-middleware', () => ({
    requirePermission: (_key: string, handler: unknown) => handler,
}));
// Passed through: the wrapper reads `req.nextUrl` for its telemetry, which a
// plain `Request` does not carry. What is under test is the age window, not
// Next's request shape.
jest.mock('@/lib/errors/api', () => ({
    withApiErrorHandling: (handler: unknown) => handler,
}));

import { GET } from '@/app/api/t/[tenantSlug]/admin/identity-write-journal/unsettled/route';

const ctx = { tenantId: 't1' } as never;
const NOW = 1790000000000;

function call(query = '') {
    return (GET as unknown as (r: Request, a: unknown, c: unknown) => Promise<Response>)(
        new Request(`https://x/api/t/acme/admin/identity-write-journal/unsettled${query}`),
        {},
        ctx,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    mockList.mockResolvedValue([]);
});

afterEach(() => jest.restoreAllMocks());

/** The cutoff the usecase was asked for, in minutes before "now". */
function cutoffMinutes() {
    const olderThan = mockList.mock.calls[0][1] as Date;
    return Math.round((NOW - olderThan.getTime()) / 60_000);
}

describe('the age window', () => {
    it('defaults to an hour, so a pass in flight is not reported as a backlog', async () => {
        await call();
        expect(cutoffMinutes()).toBe(60);
    });

    it('honours an explicit window, for an operator working an incident', async () => {
        await call('?minutes=5');
        expect(cutoffMinutes()).toBe(5);
    });

    it('accepts zero — everything unsettled, right now', async () => {
        // Distinct from absent. `Number('')` is 0 and finite, and a route that
        // treated 0 as "no opinion" would silently answer a different question
        // than the one asked.
        await call('?minutes=0');
        expect(cutoffMinutes()).toBe(0);
    });

    it.each(['?minutes=abc', '?minutes=-5', '?minutes='])(
        'falls back to the default for %s rather than refusing',
        async (q) => {
            await call(q);
            expect(cutoffMinutes()).toBe(60);
        },
    );

    it('clamps an absurd window instead of computing a date nobody meant', async () => {
        await call('?minutes=99999999');
        expect(cutoffMinutes()).toBe(60 * 24 * 31);
    });
});

describe('the response', () => {
    it('carries the cutoff, so an empty list is legible', async () => {
        // Without this, "nothing outstanding" and "you asked about the wrong
        // window" render identically.
        const body = await (await call('?minutes=30')).json();

        expect(body.minutes).toBe(30);
        expect(new Date(body.olderThan).getTime()).toBe(NOW - 30 * 60_000);
    });

    it('passes a provider scope through when given, and nothing when not', async () => {
        await call('?provider=entra-id');
        expect(mockList.mock.calls[0][2]).toBe('entra-id');

        mockList.mockClear();
        await call();
        expect(mockList.mock.calls[0][2]).toBeUndefined();
    });
});
