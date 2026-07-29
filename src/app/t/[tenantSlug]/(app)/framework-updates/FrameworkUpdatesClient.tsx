'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/layout/PageHeader';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format-date';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';

export interface DeltaRow {
    id: string;
    frameworkKey: string;
    fromVersion: string;
    toVersion: string;
    newGapCount: number;
    flaggedControlCount: number;
    status: string;
    createdAt: string;
    changelog: string | null;
    addedCodes: string[];
    changedCodes: string[];
    removedCodes: string[];
}

const STATUS_VARIANT: Record<string, 'info' | 'success' | 'neutral'> = {
    NEW: 'info',
    REVIEWED: 'success',
    DISMISSED: 'neutral',
};

/**
 * The framework-updates review client: each delta shows the version diff
 * (added / changed / removed requirement codes) + the tenant's personalised
 * impact (new gaps, controls flagged for re-review), with actions to
 * materialise findings, mark reviewed, or dismiss.
 */
export function FrameworkUpdatesClient({
    initialDeltas,
}: {
    tenantSlug: string;
    initialDeltas: DeltaRow[];
}) {
    const t = useTranslations('frameworkUpdates');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [deltas, setDeltas] = useState(initialDeltas);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    async function act(id: string, action: string, body: unknown, onOk: (json: unknown) => void) {
        setBusy(id);
        setError(null);
        setNote(null);
        try {
            const res = await fetch(apiUrl(`/framework-updates/${id}/${action}`), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } })?.error?.message ?? t('actionFailed', { action }));
            onOk(await res.json().catch(() => null));
        } catch (e) {
            setError(e instanceof Error ? e.message : t('actionFailed', { action }));
        } finally {
            setBusy(null);
        }
    }

    const review = (id: string, status: 'REVIEWED' | 'DISMISSED') =>
        act(id, 'review', { status }, () => setDeltas((prev) => prev.map((d) => (d.id === id ? { ...d, status } : d))));

    const materialize = (id: string) =>
        act(id, 'materialize-findings', {}, (json) => {
            const created = (json as { created?: number })?.created ?? 0;
            setNote(t('materialised', { count: created }));
        });

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                breadcrumbs={[{ label: t('crumbDashboard'), href: tenantHref('/dashboard') }, { label: t('crumbTitle') }]}
                title={t('title')}
                description={t('description')}
            />

            {error && <div className={cn(cardVariants({ density: 'compact' }), 'text-sm text-content-error')}>{error}</div>}
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
                                    <StatusBadge variant={STATUS_VARIANT[d.status] ?? 'neutral'}>{d.status}</StatusBadge>
                                    <span className="text-sm font-medium text-content-emphasis">
                                        {d.frameworkKey} v{d.fromVersion} → v{d.toVersion}
                                    </span>
                                    <span className="text-xs text-content-subtle">{formatDateTime(d.createdAt)}</span>
                                </div>
                                {d.status === 'NEW' && (
                                    <div className="flex items-center gap-tight">
                                        <Button variant="ghost" size="sm" disabled={busy === d.id} onClick={() => review(d.id, 'DISMISSED')}>
                                            {t('dismiss')}
                                        </Button>
                                        {d.newGapCount > 0 && (
                                            <Button variant="ghost" size="sm" disabled={busy === d.id} onClick={() => materialize(d.id)}>
                                                {t('createFindings')}
                                            </Button>
                                        )}
                                        <Button variant="secondary" size="sm" disabled={busy === d.id} onClick={() => review(d.id, 'REVIEWED')}>
                                            {t('markReviewed')}
                                        </Button>
                                    </div>
                                )}
                            </div>

                            <p className="text-sm text-content-default">
                                <span className="font-medium">{t('impactLabel')}</span> {t('newGaps', { count: d.newGapCount })}
                                {d.flaggedControlCount > 0 ? t('flaggedTail', { count: d.flaggedControlCount }) : '.'}
                            </p>

                            <div className="grid grid-cols-1 gap-tight text-xs text-content-muted sm:grid-cols-3">
                                <div>
                                    <span className="font-medium text-content-default">{t('added', { count: d.addedCodes.length })}</span>
                                    {d.addedCodes.join(', ') || '—'}
                                </div>
                                <div>
                                    <span className="font-medium text-content-default">{t('changed', { count: d.changedCodes.length })}</span>
                                    {d.changedCodes.join(', ') || '—'}
                                </div>
                                <div>
                                    <span className="font-medium text-content-default">{t('removed', { count: d.removedCodes.length })}</span>
                                    {d.removedCodes.join(', ') || '—'}
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
