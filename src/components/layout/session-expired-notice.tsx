'use client';

/**
 * #2222 — the single app-wide notice for a lapsed session.
 *
 * Mounted ONCE in `src/app/providers.tsx`, which is what dedupes it. The
 * alternative — each poller surfacing its own message — puts ~38 identical
 * notices on a process canvas with 20 edges and 15 linked nodes, because
 * every `ControlLinkBadge` / `RiskLinkBadge` / `AssetLinkBadge` and every
 * `ProcessEdge` runs its own poll.
 *
 * It OFFERS a link to `/login`; it does not redirect. The writers into this
 * store are background pollers — `use-calendar-badge` refreshes every five
 * minutes from `SidebarNav` on every page — so an automatic redirect would
 * yank a user out of a half-finished evidence upload with no way back to what
 * they had typed. Losing work to a nav counter is a worse bug than the one
 * being fixed.
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
                className="font-medium text-brand-default underline underline-offset-2"
            >
                {t('action')}
            </a>
        </div>
    );
}
