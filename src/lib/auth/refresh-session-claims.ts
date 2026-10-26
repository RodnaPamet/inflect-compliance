/**
 * Re-mint the NextAuth JWT cookie so a membership the server JUST granted
 * to this browser's user is in the token BEFORE the browser navigates into
 * that tenant.
 *
 * The Edge tenant-access gate authorises `/t/<slug>/**` from the JWT's
 * `memberships[]` claim with no DB hit, and that claim is minted at
 * sign-in. A user who creates a tenant (`NewTenantForm`) or accepts an
 * invite while signed in (`InviteAcceptButton`) gains the membership in a
 * request the gate never sees; navigating straight in would bounce to
 * /no-tenant.
 *
 * The app deliberately mounts no <SessionProvider> (session is resolved
 * server-side via `auth()`), so `useSession().update()` is unavailable.
 * This POSTs the NextAuth session-update endpoint directly — exactly what
 * `update()` does internally — which re-runs the `jwt` callback with
 * `trigger: 'update'`; see `applyMembershipClaims` in `src/auth.ts`.
 *
 * Client-side only. Best-effort: it never throws, so a failure here means
 * the user may need a manual refresh, never a broken create or accept.
 */
import { getCsrfToken } from 'next-auth/react';

export async function refreshSessionClaims(): Promise<void> {
    try {
        const csrfToken = await getCsrfToken();
        if (!csrfToken) return;
        await fetch('/api/auth/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ csrfToken, data: {} }),
        });
    } catch {
        /* best-effort — the caller's navigation still proceeds */
    }
}
