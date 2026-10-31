'use client';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { Button } from '@/components/ui/button';
import { AppIcon } from '@/components/icons/AppIcon';
import { useOptimisticUpdate } from '@/components/ui/hooks';
import { PageHeader } from '@/components/layout/PageHeader';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';
import { MARK_NOTIFICATION_READ_REQUEST } from '@/lib/notifications/mark-read';
import { resolveNotificationHref } from '@/lib/notifications/notification-href';

type Notification = {
    id: string;
    type: string;
    /** The heading the bell shows; this page used to drop it (#4643). */
    title: string;
    message: string;
    /** Where the notification points, resolved like the bell's. */
    linkUrl: string | null;
    createdAt: string;
    read: boolean;
};

export default function NotificationsPage() {
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    // The workspace, from the route — as the bell reads it — so a stored
    // link that predates the `/t/<slug>` prefix resolves against this one.
    const params = useParams();
    const tenantSlug = typeof params?.tenantSlug === 'string' ? params.tenantSlug : null;
    const t = useTranslations('notifications');
    const [notifications, setNotifications] = useState<Notification[]>([]);
    // Loading, loaded and failed are three facts, and the page used to show the
    // empty list for all of them: "No notifications" while it loaded, and the
    // same sentence when the load failed (#4643).
    const [loaded, setLoaded] = useState(false);
    const [failed, setFailed] = useState(false);

    // Without the `.catch` a network rejection left the list at its `[]`
    // initial value, which renders as "no notifications" — a wrong answer
    // presented as a confident one. An empty list and an unreachable server
    // are different facts and the page now says which.
    useEffect(() => {
        let live = true;
        fetch(apiUrl('/notifications'))
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            // Reset on the success path, not in the effect body — see the same
            // note on the mapping page.
            .then((d) => {
                if (!live) return;
                // An error body is an object, not a list; only a list is one.
                if (!Array.isArray(d)) { setFailed(true); return; }
                setNotifications(d as Notification[]);
                setFailed(false);
                setLoaded(true);
            })
            .catch(() => { if (live) setFailed(true); });
        return () => { live = false; };
    }, [apiUrl]);

    // Epic 60 — mark-read now overlays the read=true state immediately
    // and rolls back if the request fails. The previous implementation
    // awaited the network round-trip before updating the UI, so every
    // click felt ~100-300ms laggy; the overlay is now local-instant.
    // On error, `rolledBackValue` is the prior list which we re-commit
    // so the "unread" styling comes back.
    const { value: optimisticList, update } = useOptimisticUpdate<Notification[]>(
        notifications,
        {
            onError: (_err, rolledBack) => {
                // Revert: caller state never advanced because our commit
                // fn below doesn't call setNotifications on success; the
                // overlay drop + this setState together restore reality.
                setNotifications(rolledBack);
            },
        },
    );

    const markRead = async (id: string) => {
        try {
            await update(
                (prev) => prev.map(n => n.id === id ? { ...n, read: true } : n),
                async () => {
                    const res = await fetch(apiUrl(`/notifications/${id}`), MARK_NOTIFICATION_READ_REQUEST);
                    if (!res.ok) throw new Error('Mark-read failed');
                    // Commit to canonical state on success — clears the
                    // optimistic overlay since the new reference matches.
                    setNotifications(prev =>
                        prev.map(n => (n.id === id ? { ...n, read: true } : n)),
                    );
                },
            );
        } catch {
            // Swallow — onError already rolled the local list back.
        }
    };

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                breadcrumbs={[
                    { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('title') },
                ]}
                title={t('title')}
                description={t('description')}
            />
            <div className="space-y-tight">
                {failed ? (
                    <div role="alert" className={cn(cardVariants({ density: 'spacious' }), 'text-center text-content-error')}>{t('loadError')}</div>
                ) : !loaded ? (
                    <div className={cn(cardVariants({ density: 'spacious' }), 'text-center text-content-subtle')}>{t('loading')}</div>
                ) : optimisticList.length === 0 ? (
                    <div className={cn(cardVariants({ density: 'spacious' }), 'text-center text-content-subtle')}>{t('noNotifications')}</div>
                ) : (
                    optimisticList.map(n => (
                        <div key={n.id} data-testid={`inbox-notification-${n.id}`} className={cn(cardVariants({ density: 'compact' }), 'flex items-start gap-compact', !n.read ? 'border-l-2 border-[var(--brand-default)]' : 'opacity-60')}>
                            <span className="text-lg"><AppIcon name={n.type === 'EVIDENCE' ? 'evidence' : n.type === 'FINDING' ? 'bug' : 'bell'} size={18} /></span>
                            <div className="flex-1">
                                <p className="text-sm font-medium text-content-emphasis">{n.title}</p>
                                <p className="text-sm text-content-default">{n.message}</p>
                                <p className="text-xs text-content-subtle mt-1">{formatDateTime(n.createdAt)}</p>
                            </div>
                            {n.linkUrl && (
                                // Resolved the way the bell resolves it, so an
                                // old link without the workspace prefix opens in
                                // this workspace. Opening it marks it read, as a
                                // click in the bell does.
                                <Link
                                    href={resolveNotificationHref(n.linkUrl, tenantSlug)}
                                    onClick={() => { if (!n.read) void markRead(n.id); }}
                                    className="text-xs font-medium text-content-link hover:underline"
                                >
                                    {t('open')}
                                </Link>
                            )}
                            {!n.read && <Button variant="ghost" size="sm" className="text-xs" onClick={() => markRead(n.id)}>{t('markRead')}</Button>}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
