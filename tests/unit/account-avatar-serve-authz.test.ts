/**
 * `GET /api/account/avatar/[userId]` — who may read whose avatar (#2104).
 *
 * Before this gate the route checked authentication only: any signed-in
 * account, including one with zero tenant memberships, could stream any
 * user's avatar, and the 200-versus-404 split answered "is this person a
 * user of the platform" for anyone who could guess an id. On a compliance
 * product that answer is itself information.
 *
 * The audience is now "users who share a tenant with the subject", and a
 * caller outside it is answered with the SAME 404 an absent avatar
 * returns — the final describe block compares the two responses byte for
 * byte, because a 403 (or a differently-worded 404) would put the oracle
 * straight back.
 *
 * Prisma is faked rather than stubbed at `canViewAvatar`: the fixture
 * below is a real membership table and the fake evaluates the route's
 * actual `where` against it, so a widened predicate — dropping `status`,
 * dropping `deletedAt`, matching the wrong user — fails here instead of
 * passing through a mock that was told what to answer.
 */

// ─── Fixture: three tenants, and the membership rows over them ───
//
// t-acme and t-globex are live; t-ghost is soft-deleted. Statuses are
// the real `MembershipStatus` values, so DEACTIVATED / INVITED rows can
// be asserted against rather than assumed away.
const TENANTS: Record<string, { deletedAt: Date | null }> = {
    't-acme': { deletedAt: null },
    't-globex': { deletedAt: null },
    't-ghost': { deletedAt: new Date('2026-01-01T00:00:00Z') },
};

const MEMBERSHIPS: ReadonlyArray<{
    id: string;
    userId: string;
    tenantId: string;
    status: 'ACTIVE' | 'INVITED' | 'DEACTIVATED' | 'REMOVED';
}> = [
    { id: 'm-alice', userId: 'alice', tenantId: 't-acme', status: 'ACTIVE' },
    { id: 'm-bob', userId: 'bob', tenantId: 't-acme', status: 'ACTIVE' },
    { id: 'm-carol', userId: 'carol', tenantId: 't-globex', status: 'ACTIVE' },
    // A colleague of alice's who has never uploaded an avatar.
    { id: 'm-frank', userId: 'frank', tenantId: 't-acme', status: 'ACTIVE' },
    // Left the company: the row survives, the audience does not.
    { id: 'm-erin', userId: 'erin', tenantId: 't-acme', status: 'DEACTIVATED' },
    // Invited but never accepted — not a colleague yet.
    { id: 'm-ivan', userId: 'ivan', tenantId: 't-acme', status: 'INVITED' },
    // Both ACTIVE, but their tenant is soft-deleted.
    { id: 'm-gina', userId: 'gina', tenantId: 't-ghost', status: 'ACTIVE' },
    { id: 'm-hank', userId: 'hank', tenantId: 't-ghost', status: 'ACTIVE' },
    // 'dave' appears nowhere: a signed-in account with zero memberships.
];

/** Users with an object in storage. Everyone else 404s on the stream. */
const STORED_AVATARS = new Set([
    'alice',
    'bob',
    'carol',
    'dave',
    'erin',
    'gina',
    'hank',
]);

/**
 * Evaluate the ONE query shape this route is allowed to make.
 *
 * Deliberately strict: an unrecognised `where` throws instead of
 * quietly returning null, because a silently-null fake would turn every
 * "denied" assertion below green while the real gate did nothing.
 */
function findFirstMembership(args: {
    where: Record<string, unknown>;
}): { id: string } | null {
    const where = args.where;
    const keys = Object.keys(where).sort().join(',');
    if (keys !== 'status,tenant,userId') {
        throw new Error(
            `avatar audience fake: unexpected where keys [${keys}]. This fake ` +
                'models only the #2104 shared-tenant query; if the route\'s ' +
                'query shape changed, update the fake AND re-check the rule.',
        );
    }

    const subjectId = where.userId as string;
    const subjectStatus = where.status as string;
    const tenantFilter = where.tenant as {
        deletedAt: Date | null;
        memberships: { some: { userId: string; status: string } };
    };
    const tenantKeys = Object.keys(tenantFilter).sort().join(',');
    if (tenantKeys !== 'deletedAt,memberships' || tenantFilter.deletedAt !== null) {
        throw new Error(
            `avatar audience fake: unexpected tenant filter [${tenantKeys}].`,
        );
    }
    const viewer = tenantFilter.memberships.some;

    const row = MEMBERSHIPS.find(
        (m) =>
            m.userId === subjectId &&
            m.status === subjectStatus &&
            // `deletedAt: null` — live tenants only.
            TENANTS[m.tenantId]?.deletedAt === null &&
            MEMBERSHIPS.some(
                (v) =>
                    v.tenantId === m.tenantId &&
                    v.userId === viewer.userId &&
                    v.status === viewer.status,
            ),
    );
    return row ? { id: row.id } : null;
}

const findFirstSpy = jest.fn(findFirstMembership);

/** Storage probe, spied so the AUTHORIZE-then-READ order is provable. */
const headSpy = jest.fn(async (key: string) => {
    const userId = key.replace(/^avatars\//, '').replace(/\.webp$/, '');
    if (!STORED_AVATARS.has(userId)) throw new Error('no such object');
    return { sizeBytes: 12 };
});

jest.mock('@/lib/prisma', () => ({
    __esModule: true,
    default: {
        tenantMembership: {
            findFirst: (args: { where: Record<string, unknown> }) =>
                findFirstSpy(args),
        },
    },
}));

jest.mock('@/lib/storage', () => ({
    getStorageProvider: () => ({
        head: (key: string) => headSpy(key),
        readStream: () => {
            const { Readable } = jest.requireActual<typeof import('node:stream')>(
                'node:stream',
            );
            return Readable.from([Buffer.from('RIFF....WEBP')]);
        },
    }),
}));

// `@/auth` drags in every provider + the Prisma adapter; the route uses
// it only as the opaque config argument to `getServerSession`.
jest.mock('@/auth', () => ({ authOptions: {} }));

const getServerSessionMock = jest.fn();
jest.mock('next-auth', () => ({
    getServerSession: () => getServerSessionMock(),
}));

import { NextRequest } from 'next/server';

import { GET } from '@/app/api/account/avatar/[userId]/route';

/** Pinned so two responses differ only where the ROUTE makes them differ. */
const FIXED_REQUEST_ID = 'req-avatar-authz';

function requestFor(subjectUserId: string): NextRequest {
    return new NextRequest(
        `http://localhost/api/account/avatar/${subjectUserId}`,
        { method: 'GET', headers: { 'x-request-id': FIXED_REQUEST_ID } },
    );
}

/** Drive the route as a given signed-in user (or `null` for anonymous). */
async function get(
    viewerUserId: string | null,
    subjectUserId: string,
): Promise<Response> {
    getServerSessionMock.mockResolvedValue(
        viewerUserId ? { user: { id: viewerUserId } } : null,
    );
    return GET(requestFor(subjectUserId), {
        params: Promise.resolve({ userId: subjectUserId }),
    });
}

/** Everything a caller can observe, flattened for comparison. */
async function observable(res: Response): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
}> {
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
        headers[key] = value;
    });
    return { status: res.status, headers, body: await res.text() };
}

beforeEach(() => {
    findFirstSpy.mockClear();
    headSpy.mockClear();
    getServerSessionMock.mockReset();
});

describe('avatar serve route — the audience', () => {
    it('serves the avatar to a caller who shares a tenant with the subject', async () => {
        const res = await get('alice', 'bob');

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/webp');
        expect(await res.text()).toBe('RIFF....WEBP');
    });

    it('serves the caller their own avatar', async () => {
        const res = await get('bob', 'bob');

        expect(res.status).toBe(200);
        expect(await res.text()).toBe('RIFF....WEBP');
    });

    it('serves the caller their own avatar even with zero memberships', async () => {
        // `dave` is in no tenant at all — the self case must not depend
        // on the membership query having anything to find.
        const res = await get('dave', 'dave');

        expect(res.status).toBe(200);
        expect(await res.text()).toBe('RIFF....WEBP');
        // …and it costs no round trip.
        expect(findFirstSpy).not.toHaveBeenCalled();
    });

    it('refuses a caller from a different tenant', async () => {
        const res = await get('carol', 'bob');

        expect(res.status).toBe(404);
        // The gate was REACHED and answered no — without this the 404
        // above would also pass if the handler had thrown on the way in.
        expect(findFirstSpy).toHaveBeenCalledTimes(1);
        expect(findFirstSpy).toHaveReturnedWith(null);
    });

    it('refuses a caller with no tenant memberships at all', async () => {
        const res = await get('dave', 'bob');

        expect(res.status).toBe(404);
        expect(findFirstSpy).toHaveBeenCalledTimes(1);
        expect(findFirstSpy).toHaveReturnedWith(null);
    });

    it('refuses a caller whose membership is DEACTIVATED', async () => {
        // erin and bob are both rows on t-acme; only the status differs,
        // so this fails the moment `status: ACTIVE` leaves the query.
        expect((await get('erin', 'bob')).status).toBe(404);
        // Positive companion: the same subject, from an ACTIVE colleague.
        expect((await get('alice', 'bob')).status).toBe(200);
    });

    it('refuses a caller whose membership is only INVITED', async () => {
        expect((await get('ivan', 'bob')).status).toBe(404);
        expect((await get('alice', 'bob')).status).toBe(200);
    });

    it('refuses a subject whose only ACTIVE membership is DEACTIVATED', async () => {
        // The gate is symmetric: erin is ACTIVE nowhere, so an ACTIVE
        // colleague on the same tenant still cannot read her avatar.
        expect((await get('alice', 'erin')).status).toBe(404);
        expect(findFirstSpy).toHaveReturnedWith(null);
    });

    it('grants nothing through a soft-deleted tenant', async () => {
        // gina and hank are both ACTIVE on t-ghost, whose deletedAt is
        // set. Nobody can enter that tenant, so it confers no audience.
        expect((await get('gina', 'hank')).status).toBe(404);
        // Positive companion: gina can still read her own avatar, so the
        // 404 above is the tenant filter and not a broken fixture.
        expect((await get('gina', 'gina')).status).toBe(200);
    });

    it('rejects an unauthenticated caller before any lookup', async () => {
        const res = await get(null, 'bob');

        expect(res.status).toBe(401);
        expect(findFirstSpy).not.toHaveBeenCalled();
    });

    it('authorizes BEFORE touching storage', async () => {
        // `bob` HAS a stored object, so the probe would succeed if it
        // ran. Refusing without probing is what keeps the refusal from
        // costing a storage round trip whose duration differs between
        // "no such object" and "not your colleague".
        expect((await get('carol', 'bob')).status).toBe(404);
        expect(findFirstSpy).toHaveBeenCalledTimes(1);
        expect(headSpy).not.toHaveBeenCalled();

        // Positive companion: the same object IS probed for a caller
        // who passes the gate — so the assertion above is about the
        // ORDER, not about a probe that never happens.
        expect((await get('alice', 'bob')).status).toBe(200);
        expect(headSpy).toHaveBeenCalledWith('avatars/bob.webp');
    });
});

describe('avatar serve route — refusal and absence are the same response', () => {
    it('a not-permitted read is byte-identical to a genuinely-absent one', async () => {
        // (a) carol may not read bob's avatar — but it exists.
        const refused = await observable(await get('carol', 'bob'));
        // (b) alice may read her colleague bob's avatar, but here the
        //     subject id has no stored object and no membership row at
        //     all: a plain "no such avatar".
        const absent = await observable(await get('alice', 'ghost-user'));

        // Status, every header, and the body — nothing distinguishes
        // "you may not" from "there is nothing". A 403, or a different
        // message on either branch, fails right here.
        expect(refused).toEqual(absent);
        expect(refused.status).toBe(404);
        expect(refused.body).toContain('Avatar not found.');

        // Positive companion: this comparison is capable of failing.
        // An avatar the caller MAY read is plainly different.
        const allowed = await observable(await get('alice', 'bob'));
        expect(allowed).not.toEqual(refused);
        expect(allowed.status).toBe(200);
    });

    it('an authorized caller whose subject has no stored object gets that same 404', async () => {
        // alice and frank share t-acme, so the audience gate PASSES and
        // the 404 comes from storage instead. It must not be
        // distinguishable from the refusal either.
        const noObject = await observable(await get('alice', 'frank'));
        expect(findFirstSpy).toHaveReturnedWith({ id: 'm-frank' });

        const refused = await observable(await get('carol', 'bob'));

        expect(noObject).toEqual(refused);
    });
});
