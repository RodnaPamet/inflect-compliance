/**
 * `GET /api/t/:tenantSlug/admin/identity-write-journal` and its by-reference
 * sibling — the HTTP entrance to what a directory write REPLACED.
 *
 * The usecases' own shapes are covered in `identity-write-journal.test.ts`;
 * this file proves the ROUTES are wired to the right key and that the key is
 * one an ADMIN does not hold.
 *
 * THE FAILURE IT EXISTS TO CATCH is a future edit softening the gate to
 * `admin.manage` — which reads like a harmless tidy-up ("it is only a read",
 * "it sits next to the roster") and would hand every ADMIN, for every person
 * the product has ever offboarded, the captured prior state of their directory
 * account plus the provider's own free-text account of the change. That is the
 * same class of authority as granting the disable, which is why the write
 * policy, the leaver-pass report and these two routes all sit on one key.
 *
 * Both verbs are asserted SEPARATELY rather than through the index alone. They
 * are two files, and the by-reference one is the one that returns the captured
 * state and the encrypted `detail` — a gate softened on that file only would be
 * invisible to a test that exercised the index.
 *
 * Also asserted: the declarative side. `ROUTE_PERMISSIONS` resolves both paths
 * to the same key. The runtime middleware and the map are two separate
 * mechanisms (SDK generation and `/api/docs` read the map, not the handler), so
 * a disagreement between them is a real defect and is checked as its own thing.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getTenantCtxMock = jest.fn<any, [unknown, unknown]>();
jest.mock('@/app-layer/context', () => ({
    getTenantCtx: (params: unknown, req: unknown) => getTenantCtxMock(params, req),
}));

// The AUTHZ_DENIED row `requirePermission` writes on denial must not reach a
// real DB in a unit test. Its presence is the whole reason this population uses
// `requirePermission` rather than a usecase-layer assert — see CLAUDE.md C.1.
jest.mock('@/lib/audit', () => ({
    appendAuditEntry: jest.fn(async () => ({
        id: 'audit-x',
        entryHash: 'hash-x',
        previousHash: null,
    })),
}));

const listJournalWritesMock = jest.fn(async (_ctx: unknown, _options?: unknown) => [] as unknown[]);
const getJournalWriteMock = jest.fn(async (_ctx: unknown, _id: string) => null as unknown);
jest.mock('@/app-layer/usecases/identity-write-journal', () => ({
    ...jest.requireActual('@/app-layer/usecases/identity-write-journal'),
    listJournalWrites: (ctx: unknown, options?: unknown) => listJournalWritesMock(ctx, options),
    getJournalWrite: (ctx: unknown, id: string) => getJournalWriteMock(ctx, id),
}));

import { NextRequest } from 'next/server';
import { GET as GET_INDEX } from '@/app/api/t/[tenantSlug]/admin/identity-write-journal/route';
import { GET as GET_ONE } from '@/app/api/t/[tenantSlug]/admin/identity-write-journal/[journalId]/route';
import { getPermissionsForRole } from '@/lib/permissions';
import { resolveRoutePermission } from '@/lib/security/route-permissions';

function ctxFor(role: 'OWNER' | 'ADMIN' | 'EDITOR') {
    return {
        requestId: 'req-1',
        userId: `${role.toLowerCase()}-1`,
        tenantId: 'tenant-A',
        role,
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: role === 'OWNER' || role === 'ADMIN',
            canAudit: true,
            canExport: true,
        },
        appPermissions: getPermissionsForRole(role),
    };
}

function indexReq(query = ''): NextRequest {
    return new NextRequest(
        `http://localhost/api/t/acme/admin/identity-write-journal${query}`,
        { method: 'GET' },
    );
}

function oneReq(id: string): NextRequest {
    return new NextRequest(
        `http://localhost/api/t/acme/admin/identity-write-journal/${id}`,
        { method: 'GET' },
    );
}

const indexArgs = { params: Promise.resolve({ tenantSlug: 'acme' }) };
const oneArgs = (journalId: string) => ({
    params: Promise.resolve({ tenantSlug: 'acme', journalId }),
});

const ENTRY = {
    journalId: 'j1',
    linkId: 'link-1',
    provider: 'entra-id',
    action: 'DISABLE_ACCOUNT',
    mode: 'AUTOMATIC',
    outcome: 'APPLIED',
    attemptedAt: new Date('2026-09-12T05:00:00.000Z'),
    settledAt: new Date('2026-09-12T05:00:02.000Z'),
    actorUserId: null,
    priorState: { accountEnabled: true, userAccountControl: 512 },
    detail: 'Entra accepted the change.',
};

beforeEach(() => {
    jest.clearAllMocks();
    listJournalWritesMock.mockResolvedValue([ENTRY]);
    getJournalWriteMock.mockResolvedValue(ENTRY);
});

describe('GET …/admin/identity-write-journal (the index)', () => {
    it('refuses an ADMIN with 403 and never reaches the usecase', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('ADMIN'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_INDEX(indexReq(), indexArgs as any);

        expect(res.status).toBe(403);
        // The second assertion is not redundant. A 403 produced AFTER the read
        // has already run is a disclosure that happens to be discarded, and the
        // status alone cannot tell the two apart.
        expect(listJournalWritesMock).not.toHaveBeenCalled();
    });

    it('refuses an EDITOR with 403', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('EDITOR'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_INDEX(indexReq(), indexArgs as any);

        expect(res.status).toBe(403);
        expect(listJournalWritesMock).not.toHaveBeenCalled();
    });

    it('lets an OWNER through and returns the page', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_INDEX(indexReq(), indexArgs as any);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.writes).toHaveLength(1);
        expect(body.writes[0]).toMatchObject({ journalId: 'j1', outcome: 'APPLIED' });

        const [ctx] = listJournalWritesMock.mock.calls[0];
        expect((ctx as { tenantId: string }).tenantId).toBe('tenant-A');
    });

    it('forwards limit + provider from the query string', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await GET_INDEX(indexReq('?limit=25&provider=entra-id'), indexArgs as any);

        expect(listJournalWritesMock.mock.calls[0][1]).toEqual({
            limit: 25,
            provider: 'entra-id',
        });
    });

    it('ignores a non-numeric limit rather than 400-ing an incident surface', async () => {
        // Somebody reaches this from a link in an email, mid-offboarding. A
        // rejected request teaches them nothing about their directory, and the
        // usecase clamps the value regardless, so a garbage limit costs a
        // default page rather than an error page.
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_INDEX(indexReq('?limit=lots'), indexArgs as any);

        expect(res.status).toBe(200);
        expect(listJournalWritesMock.mock.calls[0][1]).toEqual({
            limit: undefined,
            provider: undefined,
        });
    });

    it('treats an EMPTY limit as no opinion, not as a one-row page', async () => {
        // `?limit=` is what a form submits for an untouched field, and it is the
        // case the obvious parse gets wrong: Number('') is 0, not NaN, so a bare
        // Number.isFinite check admits it and a Math.max(1, …) floor turns it
        // into a single row. That answer is silently, baffingly wrong — the
        // operator asked for the page and got one entry, with a 200 and no clue.
        // The `>= 1` half of the guard is the only thing standing between those,
        // and until this test nothing failed when it was removed.
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_INDEX(indexReq('?limit='), indexArgs as any);

        expect(res.status).toBe(200);
        expect(listJournalWritesMock.mock.calls[0][1]).toEqual({
            limit: undefined,
            provider: undefined,
        });
    });

    it('treats a zero or negative limit the same way', async () => {
        // Same guard, the two other values that reach it. Asserted separately
        // because `?limit=` only proves Number('') — 0 and -5 arrive as honest
        // finite numbers and would survive a fix that special-cased the empty
        // string instead of flooring the value.
        for (const q of ['?limit=0', '?limit=-5']) {
            listJournalWritesMock.mockClear();
            getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const res = await GET_INDEX(indexReq(q), indexArgs as any);
            expect(res.status).toBe(200);
            expect(listJournalWritesMock.mock.calls[0][1]).toEqual({
                limit: undefined,
                provider: undefined,
            });
        }
    });
});

describe('GET …/admin/identity-write-journal/<reference> (the captured state)', () => {
    it('refuses an ADMIN with 403 and never reads the capture', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('ADMIN'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_ONE(oneReq('j1'), oneArgs('j1') as any);

        expect(res.status).toBe(403);
        expect(getJournalWriteMock).not.toHaveBeenCalled();
    });

    it('refuses an EDITOR with 403', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('EDITOR'));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_ONE(oneReq('j1'), oneArgs('j1') as any);

        expect(res.status).toBe(403);
        expect(getJournalWriteMock).not.toHaveBeenCalled();
    });

    it('lets an OWNER read the captured prior state and the settle detail', async () => {
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_ONE(oneReq('j1'), oneArgs('j1') as any);

        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.write.priorState).toEqual({ accountEnabled: true, userAccountControl: 512 });
        expect(body.write.detail).toBe('Entra accepted the change.');
        expect(getJournalWriteMock.mock.calls[0][1]).toBe('j1');
    });

    it('answers 404 for a reference this tenant does not hold', async () => {
        // Not 403. The lookup is tenant-scoped, so a reference belonging to
        // another tenant is simply not there — and answering the same way for a
        // mistyped id and a foreign one is what stops the response becoming an
        // oracle for whether a cuid exists somewhere else in the fleet.
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));
        getJournalWriteMock.mockResolvedValueOnce(null);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_ONE(oneReq('nope'), oneArgs('nope') as any);

        expect(res.status).toBe(404);
    });

    it('clips the quoted reference, so the 404 is not a log-volume lever', async () => {
        // The message names the reference back so an operator holding a mistyped
        // id from an email can see WHICH one missed. Nothing stops a client
        // sending kilobytes instead, and `withApiErrorHandling` writes the
        // message to the STRUCTURED LOG as well as the body — so an unbounded
        // echo hands anyone who can reach this route a way to inflate log
        // storage, from a 404 that looks like a typo.
        //
        // 64 is generous: a cuid is ~25 characters, so a real reference is never
        // clipped and this can only fire on something that was never going to
        // match anyway.
        getTenantCtxMock.mockResolvedValueOnce(ctxFor('OWNER'));
        getJournalWriteMock.mockResolvedValueOnce(null);
        const huge = 'z'.repeat(5000);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await GET_ONE(oneReq(huge), oneArgs(huge) as any);
        const body = await res.json();

        expect(res.status).toBe(404);
        // The whole body, not just the reference: the cap is worthless if the
        // id is clipped in one field and echoed whole in another.
        const serialised = JSON.stringify(body);
        expect(serialised).toContain('z'.repeat(64));
        expect(serialised).not.toContain('z'.repeat(65));
    });
});

describe('route-permission map', () => {
    it('declares the OWNER-only key for the index path', () => {
        const rule = resolveRoutePermission('/api/t/acme/admin/identity-write-journal', 'GET');
        expect(rule?.permission).toBe('admin.tenant_lifecycle');
    });

    it('declares the SAME key for the by-reference path', () => {
        // One subtree rule covers both, so they cannot drift apart — but the
        // map is what SDK generation and the API docs read, and a rule ordered
        // after a broader `admin/...` pattern would resolve elsewhere without
        // the handler changing at all.
        const rule = resolveRoutePermission('/api/t/acme/admin/identity-write-journal/j1', 'GET');
        expect(rule?.permission).toBe('admin.tenant_lifecycle');
    });

    it('is not shadowed by the identity-write-POLICY rule next to it', () => {
        // The two paths differ by one word and sit adjacent in the map. A
        // regex loosened to `identity-write-.*` on either would swallow the
        // other, and both currently resolve to the same key — so the shadowing
        // would be invisible until one of the keys changed.
        const policy = resolveRoutePermission('/api/t/acme/admin/identity-write-policy', 'GET');
        expect(policy?.rule.path.test('/api/t/acme/admin/identity-write-journal')).toBe(false);
    });

    it('the key is one an ADMIN does not hold', () => {
        // The load-bearing half of every 403 above. Without this, softening the
        // route to `admin.manage` would still have to be noticed by eye.
        expect(getPermissionsForRole('OWNER').admin.tenant_lifecycle).toBe(true);
        expect(getPermissionsForRole('ADMIN').admin.tenant_lifecycle).toBe(false);
    });
});
