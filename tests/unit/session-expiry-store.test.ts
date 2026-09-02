/**
 * #2222 — the app-wide "this session is gone" store.
 *
 * The store's whole job is to be the ONE place that decides what counts as a
 * session verdict, so every assertion here is about the predicate rather than
 * the plumbing. Three properties carry real risk if they regress:
 *
 *   1. **401 only.** A 403 must never mark. Three of its producers are
 *      `no_tenant_access`, `cross_tenant_access_denied`, and a
 *      `requirePermission` denial — an EDITOR hitting an admin endpoint is
 *      correctly signed in, and signing them out would be a regression that
 *      also renders a hash-chained `AUTHZ_DENIED` as an auth failure.
 *   2. **One notification.** ~38 pollers run on a process canvas with 20 edges
 *      and 15 linked nodes. If every one of them produced a notice, the fix
 *      would be worse than the bug.
 *   3. **Terminal.** A later 200 from a public route must not un-expire the
 *      session — there is deliberately no `clear()` outside the test reset.
 */

import {
    isSessionExpired,
    markSessionExpired,
    noteUnauthorized,
    subscribe,
    __resetSessionExpiryForTests,
} from '@/lib/auth/session-expiry';

beforeEach(() => {
    __resetSessionExpiryForTests();
});

afterEach(() => {
    __resetSessionExpiryForTests();
});

describe('session-expiry store', () => {
    it('starts un-expired', () => {
        expect(isSessionExpired()).toBe(false);
    });

    it('notifies subscribers exactly once no matter how many pollers mark it', () => {
        const seen = jest.fn();
        subscribe(seen);

        markSessionExpired();
        markSessionExpired();
        markSessionExpired();

        expect(isSessionExpired()).toBe(true);
        // Not "at least once" — the count IS the assertion. A per-mark
        // notification is what puts 38 identical banners on a canvas.
        expect(seen).toHaveBeenCalledTimes(1);
    });

    it('unsubscribes cleanly', () => {
        const seen = jest.fn();
        const off = subscribe(seen);
        off();

        markSessionExpired();

        expect(seen).not.toHaveBeenCalled();
        // The negative above is worthless on its own — it also passes if
        // `markSessionExpired` did nothing at all. Pin the side effect too.
        expect(isSessionExpired()).toBe(true);
    });

    it('is terminal — nothing in the public surface clears it', () => {
        markSessionExpired();
        // A later success on a public route must not un-expire the session.
        expect(noteUnauthorized(200, '/api/t/acme/controls')).toBe(false);
        expect(isSessionExpired()).toBe(true);
    });
});

describe('noteUnauthorized — the 401-only predicate', () => {
    it('marks on a 401 from a tenant-scoped API path', () => {
        expect(noteUnauthorized(401, '/api/t/acme/controls')).toBe(true);
        expect(isSessionExpired()).toBe(true);
    });

    it('marks on a 401 from a flat authenticated API path', () => {
        // `/api/notifications` is the bell's route: flat, so `isTenantPath`
        // never matches it, and still session-bearing.
        expect(noteUnauthorized(401, '/api/notifications')).toBe(true);
        expect(isSessionExpired()).toBe(true);
    });

    it('accepts an absolute same-origin URL — `Response.url` is absolute', () => {
        expect(
            noteUnauthorized(401, 'https://app.example.com/api/t/acme/risks'),
        ).toBe(true);
        expect(isSessionExpired()).toBe(true);
    });

    it.each([403, 404, 429, 500, 503])(
        'does NOT mark on %i',
        (status) => {
            expect(noteUnauthorized(status, '/api/t/acme/controls')).toBe(false);
            expect(isSessionExpired()).toBe(false);
        },
    );

    it('does NOT mark on a 401 from NextAuth\'s own endpoints', () => {
        // A 401 there is about the sign-in attempt being made right now, not
        // about an existing session having lapsed.
        expect(noteUnauthorized(401, '/api/auth/callback/credentials')).toBe(
            false,
        );
        expect(isSessionExpired()).toBe(false);
    });

    it('does NOT mark on a 401 from a non-API path or an unknown URL', () => {
        expect(noteUnauthorized(401, '/t/acme/controls')).toBe(false);
        expect(noteUnauthorized(401, undefined)).toBe(false);
        expect(noteUnauthorized(401, '')).toBe(false);
        expect(noteUnauthorized(undefined, '/api/t/acme/controls')).toBe(false);
        expect(isSessionExpired()).toBe(false);
    });
});
