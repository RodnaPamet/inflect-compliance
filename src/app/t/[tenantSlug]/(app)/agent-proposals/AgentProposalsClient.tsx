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

export interface ProposalRow {
    id: string;
    kind: string;
    status: string;
    payloadJson: string;
    rationale: string | null;
    proposedViaKeyId: string | null;
    createdAt: string;
}

/**
 * The review-queue client. Renders each PENDING agent proposal with its
 * proposed content (full, untruncated — AISVS C9.2.2) + the agent's rationale,
 * and Approve / Reject actions. Approve runs the real create-usecase server-
 * side; the agent never commits.
 */
export function AgentProposalsClient({
    initialProposals,
}: {
    tenantSlug: string;
    initialProposals: ProposalRow[];
}) {
    const t = useTranslations('agents');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const [proposals, setProposals] = useState(initialProposals);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    async function act(id: string, action: 'approve' | 'reject') {
        setBusy(id);
        setError(null);
        const fallback = t(`proposals.${action}Failed`);
        try {
            const res = await fetch(apiUrl(`/agent-proposals/${id}/${action}`), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error?.message ?? fallback);
            }
            setProposals((prev) => prev.filter((p) => p.id !== id));
        } catch (e) {
            setError(e instanceof Error ? e.message : fallback);
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="space-y-section animate-fadeIn">
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('crumbAdmin'), href: tenantHref('/admin') },
                    { label: t('crumbMcp'), href: tenantHref('/admin/mcp') },
                    { label: t('proposals.crumb') },
                ]}
                title={t('proposals.title')}
                description={t('proposals.description')}
            />

            {error && (
                <div className={cn(cardVariants({ density: 'compact' }), 'text-sm text-content-error')}>
                    {error}
                </div>
            )}

            {proposals.length === 0 ? (
                <EmptyState
                    title={t('proposals.emptyTitle')}
                    description={t('proposals.emptyDesc')}
                />
            ) : (
                <ul className="space-y-default">
                    {proposals.map((p) => {
                        let payload: unknown;
                        try {
                            payload = JSON.parse(p.payloadJson);
                        } catch {
                            payload = p.payloadJson;
                        }
                        return (
                            <li
                                key={p.id}
                                id={`proposal-${p.id}`}
                                className={cn(cardVariants({ density: 'comfortable' }), 'space-y-default')}
                            >
                                <div className="flex items-center justify-between gap-default">
                                    <div className="flex items-center gap-tight">
                                        <StatusBadge variant="info">{p.kind}</StatusBadge>
                                        <span className="text-xs text-content-subtle">
                                            {t('proposals.proposedAt', { date: formatDateTime(p.createdAt) })}
                                            {p.proposedViaKeyId
                                                ? t('proposals.keySuffix', { key: p.proposedViaKeyId.slice(0, 8) })
                                                : ''}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-tight">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={busy === p.id}
                                            onClick={() => act(p.id, 'reject')}
                                        >
                                            {t('proposals.reject')}
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            size="sm"
                                            disabled={busy === p.id}
                                            onClick={() => act(p.id, 'approve')}
                                        >
                                            {t('proposals.approve')}
                                        </Button>
                                    </div>
                                </div>

                                {p.rationale && (
                                    <p className="text-sm text-content-muted">
                                        <span className="font-medium text-content-default">{t('proposals.rationale')}</span>
                                        {p.rationale}
                                    </p>
                                )}

                                <pre className="overflow-x-auto rounded border border-border-subtle bg-bg-subtle p-3 text-xs text-content-default">
                                    {JSON.stringify(payload, null, 2)}
                                </pre>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
