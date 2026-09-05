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
import type { ProposalDiff } from '@/lib/agentic/proposal-diff';

import { ProposalDiffPanel } from './ProposalDiffPanel';

export interface ProposalRow {
    id: string;
    kind: string;
    /** CREATE or UPDATE — decides which rendering the diff panel produces. */
    operation: string;
    status: string;
    /** The record an UPDATE would change; null for a CREATE. */
    targetEntityId: string | null;
    rationale: string | null;
    proposedViaKeyId: string | null;
    createdAt: string;
    /**
     * The diff, computed SERVER-SIDE against the target's state at page render.
     *
     * The raw `payloadJson` is deliberately no longer sent to the client. It was
     * the whole of the old review surface — a `<pre>` of the payload — and that
     * is exactly the opaque blob this page exists to stop a reviewer approving.
     * Shipping it alongside the diff would leave the failure one `JSON.stringify`
     * away from returning.
     */
    diff: ProposalDiff;
}

/**
 * The review-queue client.
 *
 * Each proposal renders its DIFF, and the approve control lives INSIDE that
 * diff panel (see `ProposalDiffPanel` for why it is a child rather than a
 * sibling). Reject stays in the card header: refusing a proposal you cannot
 * read is always safe, and is the only action available when the diff could not
 * be computed.
 *
 * Approving an UPDATE sends back the `baseDigest` of the diff that was
 * rendered. The server recomputes it and refuses the approval if the record has
 * moved since — so "a human approved this delta" stays a checkable claim rather
 * than a checkbox.
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

    async function act(p: ProposalRow, action: 'approve' | 'reject') {
        setBusy(p.id);
        setError(null);
        const fallback = t(`proposals.${action}Failed`);
        try {
            const res = await fetch(apiUrl(`/agent-proposals/${p.id}/${action}`), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                // The fingerprint of the base this reviewer actually read. Sent
                // only on approve, and only when the diff produced one (an
                // UPDATE). The server treats its ABSENCE on an update as a
                // refusal, so there is nothing to gain by omitting it.
                body: JSON.stringify(
                    action === 'approve' && p.diff.baseDigest
                        ? { baseDigest: p.diff.baseDigest }
                        : {},
                ),
            });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                throw new Error(body?.error?.message ?? fallback);
            }
            setProposals((prev) => prev.filter((row) => row.id !== p.id));
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
                <div
                    data-testid="proposal-action-error"
                    className={cn(cardVariants({ density: 'compact' }), 'text-sm text-content-error')}
                >
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
                    {proposals.map((p) => (
                        <li
                            key={p.id}
                            id={`proposal-${p.id}`}
                            className={cn(cardVariants({ density: 'comfortable' }), 'space-y-default')}
                        >
                            <div className="flex items-center justify-between gap-default">
                                <div className="flex items-center gap-tight">
                                    <StatusBadge variant="info">{p.kind}</StatusBadge>
                                    <StatusBadge
                                        variant={p.operation === 'UPDATE' ? 'warning' : 'neutral'}
                                    >
                                        {p.operation === 'UPDATE'
                                            ? t('proposals.diff.operationUpdate')
                                            : t('proposals.diff.operationCreate')}
                                    </StatusBadge>
                                    <span className="text-xs text-content-subtle">
                                        {t('proposals.proposedAt', {
                                            date: formatDateTime(p.createdAt),
                                        })}
                                        {p.proposedViaKeyId
                                            ? t('proposals.keySuffix', {
                                                key: p.proposedViaKeyId.slice(0, 8),
                                            })
                                            : ''}
                                    </span>
                                </div>
                                {/*
                                  Reject only. The approve control is NOT here —
                                  it is rendered by the diff panel below, in the
                                  branch that has already rendered a diff body.
                                */}
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    data-testid={`proposal-reject-${p.id}`}
                                    disabled={busy === p.id}
                                    onClick={() => act(p, 'reject')}
                                >
                                    {t('proposals.reject')}
                                </Button>
                            </div>

                            {p.targetEntityId && (
                                <p
                                    data-testid={`proposal-target-${p.id}`}
                                    className="text-xs text-content-subtle"
                                >
                                    {t('proposals.diff.targetLabel', { id: p.targetEntityId })}
                                </p>
                            )}

                            {p.rationale && (
                                <p
                                    data-testid={`proposal-rationale-${p.id}`}
                                    className="text-sm text-content-muted"
                                >
                                    <span className="font-medium text-content-default">
                                        {t('proposals.rationale')}
                                    </span>
                                    {p.rationale}
                                </p>
                            )}

                            <ProposalDiffPanel
                                proposalId={p.id}
                                diff={p.diff}
                                approveAction={
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        data-testid={`proposal-approve-${p.id}`}
                                        disabled={busy === p.id}
                                        onClick={() => act(p, 'approve')}
                                    >
                                        {t('proposals.approve')}
                                    </Button>
                                }
                            />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
