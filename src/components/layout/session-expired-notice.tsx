'use client';

/**
 * #2222 — the single app-wide notice for a lapsed session.
 *
 * Mounted ONCE in `src/app/providers.tsx`, which is what dedupes it. The
 * alternative — each poller surfacing its own message — puts one notice per
 * poller on screen: a dense page whose rows and connectors each carry their
 * own badge reached ~38 at the time this was written, because every one of
 * them runs its own poll.
 *
 * The figure is kept and the component names are not. They were this
 * product's, and this file is copied verbatim by a downstream one — where
 * the names would be wrong and the count still true.
 *
 * It OFFERS a link to `/login`; it does not redirect. The writers into this
 * store are background pollers — `use-calendar-badge` refreshes every five
 * minutes from `SidebarNav` on every page — so an automatic redirect would
 * yank a user out of a half-finished upload with no way back to what they had
 * typed. Losing work to a nav counter is a worse bug than the one being
 * fixed.
 *
 * The read is `useSyncExternalStore`, not `useEffect` + `useState`: the store
 * is module-scoped precisely so an already-scheduled interval callback can
 * write to it, and that write can land before this component ever mounts.
 */
import { useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';

import { isSessionExpired, subscribe } from '@/lib/auth/session-expiry';

/** Server render always reports "not expired" — there is no client store yet. */
const serverSnapshot = () => false;

export function SessionExpiredNotice() {
    const t = useTranslations('panels.sessionExpired');
    const expired = useSyncExternalStore(
        subscribe,
        isSessionExpired,
        serverSnapshot,
    );

    if (!expired) return null;

    return (
        <div
            role="status"
            aria-live="polite"
            id="session-expired-notice"
            className="fixed inset-x-0 top-0 z-[100] flex flex-wrap items-center justify-center gap-compact border-b border-border-subtle bg-bg-elevated px-default py-compact text-sm text-content-default shadow-sm"
        >
            <span>{t('body')}</span>
            <a
                href="/login"
                className="font-medium text-content-brand underline underline-offset-2"
            >
                {t('action')}
            </a>
        </div>
    );
}
