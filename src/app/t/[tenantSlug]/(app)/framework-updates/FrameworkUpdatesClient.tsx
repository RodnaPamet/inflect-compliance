'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/layout/PageHeader';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import type { FrameworkUpdateView, FrameworkUpdateRequirement } from '@/app-layer/usecases/framework-delta';

/** One delta as the review page shows it (`listTenantFrameworkUpdateViews`). */
export type DeltaRow = FrameworkUpdateView;

type DeltaStatus = DeltaRow['status'];

const STATUS_VARIANT: Record<DeltaStatus, 'info' | 'success' | 'neutral'> = {
    NEW: 'info',
    REVIEWED: 'success',
    DISMISSED: 'neutral',
};

/** The three things a person can do with a delta, each with its own failure sentence. */
type Action = 'review' | 'dismiss' | 'materialize';

/**
 * The framework-updates review client: each delta shows the publisher's
 * changelog, the version diff (requirements added / changed / removed, by
 * code and title) and the tenant's personalised impact (new gaps, and the
 * controls flagged for re-review, by name), with actions to materialise
 * findings, mark reviewed, or dismiss. The actions are offered only to a
 * role that can write, which is what both routes ask (#4736).
 */
export function FrameworkUpdatesClient({
    initialDeltas,
    canWrite,
}: {
    tenantSlug: string;
    initialDeltas: DeltaRow[];
    canWrite: boolean;
}) {
    const t = useTranslations('frameworkUpdates');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [deltas, setDeltas] = useState(initialDeltas);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    /**
     * What a failed action says: the role's refusal, an update that is no
     * longer there, or which action failed. It used to interpolate the URL
     * segment ("Failed to materialize-findings") or show the server's English.
     */
    function failureText(action: Action, status: number | null) {
        if (status === 403) return t('restricted');
        if (status === 404) return t('notFound');
        return t(`failed.${action}`);
    }

    async function act(id: string, action: Action, path: string, body: unknown, onOk: (json: unknown) => void) {
        setBusy(id);
        setError(null);
        setNote(null);
        try {
            const res = await fetch(apiUrl(`/framework-updates/${id}/${path}`), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                setError(failureText(action, res.status));
                return;
            }
            onOk(await res.json().catch(() => null));
        } catch {
            setError(failureText(action, null));
        } finally {
            setBusy(null);
        }
    }

    const review = (id: string, status: 'REVIEWED' | 'DISMISSED') =>
        act(id, status === 'REVIEWED' ? 'review' : 'dismiss', 'review', { status }, () =>
            setDeltas((prev) => prev.map((d) => (d.id === id ? { ...d, status } : d))),
        );

    const materialize = (id: string) =>
        act(id, 'materialize', 'materialize-findings', {}, (json) => {
            const created = (json as { created?: number })?.created ?? 0;
            setNote(t('materialised', { count: created }));
        });

    const requirementList = (frameworkKey: string, items: FrameworkUpdateRequirement[], testId: string) =>
        items.length === 0 ? (
            <span>—</span>
        ) : (
            <ul className="space-y-0.5" data-testid={testId}>
                {items.map((r) => (
                    <li key={r.code}>
                        <Link href={tenantHref(`/frameworks/${encodeURIComponent(frameworkKey)}`)} className="font-mono text-content-default hover:underline">
                            {r.code}
                        </Link>
                        {r.title && <span className="text-content-muted"> — {r.title}</span>}
                    </li>
                ))}
            </ul>
        );

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                breadcrumbs={[{ label: t('crumbDashboard'), href: tenantHref('/dashboard') }, { label: t('crumbTitle') }]}
                title={t('title')}
                description={t('description')}
            />

            {error && <div className={cn(cardVariants({ density: 'compact' }), 'text-sm text-content-error')} id="framework-update-error">{error}</div>}
            {note && <div className={cn(cardVariants({ density: 'compact' }), 'text-sm text-content-success')}>{note}</div>}

            {deltas.length === 0 ? (
                <EmptyState
                    title={t('emptyTitle')}
                    description={t('emptyDescription')}
                />
            ) : (
                <ul className="space-y-default">
                    {deltas.map((d) => (
                        <li key={d.id} id={`delta-${d.id}`} className={cn(cardVariants({ density: 'comfortable' }), 'space-y-default')}>
                            <div className="flex items-center justify-between gap-default">
                                <div className="flex items-center gap-tight">
                                    <StatusBadge variant={STATUS_VARIANT[d.status] ?? 'neutral'}>{t(`status.${d.status}`)}</StatusBadge>
                                    <span className="text-sm font-medium text-content-emphasis">
                                        {t('versionChange', { name: d.frameworkName ?? d.frameworkKey, from: d.fromVersion, to: d.toVersion })}
                                    </span>
                                    <span className="text-xs text-content-subtle">{formatDateTime(d.createdAt)}</span>
                                </div>
                                {d.status === 'NEW' && canWrite && (
                                    <div className="flex items-center gap-tight">
                                        <Button variant="ghost" size="sm" disabled={busy === d.id} onClick={() => review(d.id, 'DISMISSED')} id={`delta-dismiss-${d.id}`}>
                                            {t('dismiss')}
                                        </Button>
                                        {d.newGapCount > 0 && (
                                            <Button variant="ghost" size="sm" disabled={busy === d.id} onClick={() => materialize(d.id)} id={`delta-materialize-${d.id}`}>
                                                {t('createFindings')}
                                            </Button>
                                        )}
                                        <Button variant="secondary" size="sm" disabled={busy === d.id} onClick={() => review(d.id, 'REVIEWED')} id={`delta-review-${d.id}`}>
                                            {t('markReviewed')}
                                        </Button>
                                    </div>
                                )}
                            </div>

                            {d.status === 'NEW' && !canWrite && (
                                <p className="text-xs text-content-subtle" id={`delta-restricted-${d.id}`}>{t('restricted')}</p>
                            )}

                            {/* #4736 — the publisher's note was loaded and never shown. */}
                            {d.changelog && (
                                <p className="text-sm text-content-default whitespace-pre-line" data-testid={`delta-changelog-${d.id}`}>{d.changelog}</p>
                            )}

                            <p className="text-sm text-content-default">
                                <span className="font-medium">{t('impactLabel')}</span> {t('newGaps', { count: d.newGapCount })}
                                {d.flaggedControlCount > 0 ? t('flaggedTail', { count: d.flaggedControlCount }) : '.'}
                            </p>

                            {/* #4736 — which controls were moved to NEEDS_REVIEW, not only how many. */}
                            {d.flaggedControls.length > 0 && (
                                <div className="text-xs space-y-tight">
                                    <span className="font-medium text-content-default">{t('flaggedControls')}</span>
                                    <ul className="flex flex-wrap gap-tight" data-testid={`delta-flagged-${d.id}`}>
                                        {d.flaggedControls.map((c) => (
                                            <li key={c.id}>
                                                <Link href={tenantHref(`/controls/${c.id}`)} className="text-content-default hover:underline">
                                                    {c.code ? `${c.code} — ${c.name}` : c.name}
                                                </Link>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            <div className="grid grid-cols-1 gap-tight text-xs text-content-muted sm:grid-cols-3">
                                <div>
                                    <span className="font-medium text-content-default">{t('added', { count: d.added.length })}</span>
                                    {requirementList(d.frameworkKey, d.added, `delta-added-${d.id}`)}
                                </div>
                                <div>
                                    <span className="font-medium text-content-default">{t('changed', { count: d.changed.length })}</span>
                                    {requirementList(d.frameworkKey, d.changed, `delta-changed-${d.id}`)}
                                </div>
                                <div>
                                    <span className="font-medium text-content-default">{t('removed', { count: d.removed.length })}</span>
                                    {requirementList(d.frameworkKey, d.removed, `delta-removed-${d.id}`)}
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
