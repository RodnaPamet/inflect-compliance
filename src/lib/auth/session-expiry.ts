/**
 * #2222 — the one place the app records "this browser's session is gone".
 *
 * The problem this exists for is a CLASS, not a component: a client-side
 * poller keeps requesting an authenticated endpoint after the session cookie
 * expires, forever, with nothing surfaced. The notifications bell was the
 * visible member (it threw, so the console filled with 401s); the three
 * process-canvas entity hooks are the quiet ones — they discard the failure
 * with a bare `return` and keep rendering compliance status chips from
 * whenever the session was last alive.
 *
 * ─── Why module scope and not React state ──────────────────────────────
 *
 * A poller is an already-scheduled `setInterval` callback. It closes over the
 * bindings it had when it was scheduled and can never see a `setState` — which
 * is the exact shape of the bug (`notifications-bell.tsx` documents the same
 * reasoning for its `useRef`). So the flag lives at module scope and pollers
 * PULL it at the top of each tick. React components read it through
 * `useSyncExternalStore(subscribe, isSessionExpired, () => false)`.
 *
 * ─── Why 401 only, and never 403 ───────────────────────────────────────
 *
 * For a browser request there is exactly one 401 producer: `middleware.ts`
 * calling `unauthorizedJson()` because `getToken()` returned null (missing,
 * malformed, expired or bad-signature cookie). None of those resolve by asking
 * again — only signing in does.
 *
 * 403 is overloaded three ways and NONE of them is a session problem:
 * `no_tenant_access`, `cross_tenant_access_denied`, and a `requirePermission`
 * denial. An EDITOR hitting an admin endpoint is correctly signed in; marking
 * them expired would sign out a legitimate session and render a hash-chained
 * `AUTHZ_DENIED` as an auth failure.
 *
 * (`notifications-bell.tsx` treats BOTH statuses as terminal *for itself* and
 * is right to: `/api/notifications` is a flat route — `isTenantPath` matches
 * only `/t/` and `/api/t/` — and it carries no `requirePermission`, so its
 * only reachable 403 is `resolveTenantContext` refusing a DEACTIVATED/REMOVED
 * membership, terminal in the same sense. That is a property of that route's
 * shape, not a rule that generalises, which is why the bell marks the store
 * here on 401 only while keeping both arms terminal for itself.)
 *
 * ─── Terminal, never cleared ───────────────────────────────────────────
 *
 * `markSessionExpired()` is one-way. A later 200 from a public route must not
 * un-expire the session. The flag clears on reload, i.e. after re-auth.
 *
 * ─── NOT a server-side concern ─────────────────────────────────────────
 *
 * Nothing here belongs in `withApiErrorHandling`: `app-layer/context.ts` and
 * `lib/mcp/auth.ts` raise 401 for a rejected API KEY on server-to-server
 * calls, which has nothing to do with a browser session.
 */

let expired = false;
const listeners = new Set<() => void>();

/** Has the browser session been observed as terminally unauthenticated? */
export function isSessionExpired(): boolean {
    return expired;
}

/**
 * Record the session as gone. Idempotent — listeners are notified only on the
 * false → true transition, so N pollers failing in the same tick produce ONE
 * notice rather than one per hook (a process canvas with 20 edges and 15
 * linked nodes runs ~38 of them).
 */
export function markSessionExpired(): void {
    if (expired) return;
    expired = true;
    for (const fn of [...listeners]) fn();
}

/** Subscribe to the transition. Returns the unsubscribe function. */
export function subscribe(onChange: () => void): () => void {
    listeners.add(onChange);
    return () => {
        listeners.delete(onChange);
    };
}

/**
 * Same-origin app-API paths whose 401 is a session verdict.
 *
 * `/api/auth/**` is excluded deliberately: those are NextAuth's own endpoints,
 * where a 401 is about the sign-in attempt being made right now, not about an
 * existing session having lapsed. Anything that is not a recognised `/api/`
 * path is ignored — the failure mode of a false positive here is telling a
 * signed-in user they are signed out, so an unrecognised URL fails towards
 * doing nothing.
 */
function isSessionBearingApiPath(url: string): boolean {
    let pathname = url;
    if (/^https?:\/\//i.test(url)) {
        try {
            pathname = new URL(url).pathname;
        } catch {
            return false;
        }
    }
    if (!pathname.startsWith('/api/')) return false;
    return !pathname.startsWith('/api/auth/');
}

/**
 * The single predicate every 401 writer goes through. Returns whether this
 * response marked the session expired, so a caller can branch its own copy
 * (`EvidenceBulkImportModal` does) without re-deriving the rule.
 *
 * @param status HTTP status of the response that just failed.
 * @param url    The request URL. When absent or unrecognised, nothing is
 *               marked — see `isSessionBearingApiPath`.
 */
export function noteUnauthorized(
    status: number | undefined,
    url: string | null | undefined,
): boolean {
    if (status !== 401) return false;
    if (typeof url !== 'string' || !isSessionBearingApiPath(url)) return false;
    markSessionExpired();
    return true;
}

/**
 * Test-only reset. The store is deliberately one-way in production, so there
 * is no other way back to the initial state between test cases.
 */
export function __resetSessionExpiryForTests(): void {
    expired = false;
    listeners.clear();
}
