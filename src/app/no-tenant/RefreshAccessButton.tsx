'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { refreshSessionCookie } from '@/lib/auth/refresh-session-cookie';

/**
 * "I was just given access" — rewrite the session cookie, then go to the picker.
 *
 * WHY THIS BUTTON EXISTS (#5246). A membership added while the person is signed
 * in never reaches the Edge gate on its own. The `jwt` callback re-reads the
 * claims, but in the App Router a server read never writes the re-signed cookie
 * back, and the middleware reads ONLY the cookie — so `checkTenantAccess` keeps
 * returning `cross_tenant` for the new workspace's slug and keeps sending the
 * person here. Until this, the only way out was to sign out and back in, with
 * nothing on the page saying so.
 *
 * NextAuth's own session route is the one path that does re-sign the cookie,
 * which is what `refreshSessionCookie` calls — the same thing the MFA page does
 * after a correct code, and for the same reason.
 *
 * It navigates to the picker rather than back to the workspace that was
 * refused: this page is deliberately never told which slug was asked for (a
 * slug in a link is text anybody can choose, and the page must not echo it), so
 * the picker — which reads the database — is the honest destination.
 *
 * It navigates even when the refresh FAILS. `refreshSessionCookie` resolves
 * `false` rather than throwing, and the gate decides from whatever cookie is
 * actually there; a person stuck on this page is better served by a reload that
 * re-evaluates than by an error they cannot act on.
 */
export function RefreshAccessButton() {
    const t = useTranslations('noTenant');
    const router = useRouter();
    const [busy, setBusy] = useState(false);

    return (
        <Button
            // SECONDARY, matching the Sign out button below it, and not because
            // the action is unimportant — it is the one useful thing on this
            // page. `primary-secondary-ratio` holds the repo's absolute primary
            // count at a ceiling whose own history shows the convention: a new
            // primary is "PAID FOR" by demoting one elsewhere, net zero. Buying
            // one for an error page by redesigning an unrelated page is not a
            // trade worth making, and the button reads clearly as the action
            // without it.
            type="button"
            variant="secondary"
            className="w-full"
            id="no-tenant-refresh-access"
            disabled={busy}
            onClick={async () => {
                setBusy(true);
                await refreshSessionCookie();
                // `refresh()` before `push()`: the picker is a server
                // component, and a cached RSC payload would be rendered from
                // the session as it was BEFORE the cookie was rewritten —
                // showing the same stale list that sent the person here.
                router.refresh();
                router.push('/tenants');
            }}
        >
            {busy ? t('refreshingAccess') : t('refreshAccess')}
        </Button>
    );
}
