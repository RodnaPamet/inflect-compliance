'use client';

/**
 * AI system detail — shows the EU AI Act classification basis, the linked
 * AI-Act / ISO 42001 obligations, and (for HIGH-risk systems) buttons to
 * generate DRAFT conformity artifacts. Generation is propose-not-commit: it
 * queues a proposal for human review; nothing is auto-published.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { PageHeader } from '@/components/layout/PageHeader';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { StatusBadge } from '@/components/ui/status-badge';
import { Button } from '@/components/ui/button';
import { EntityPrevNextNav } from '@/components/ui/entity-prev-next-nav';
import { useEntityListIds } from '@/lib/hooks/use-entity-list-ids';
import { CACHE_KEYS } from '@/lib/swr-keys';
import { TIER_VARIANT } from '../AiSystemsClient';

export interface AiSystemDetail {
    id: string;
    name: string;
    provider: string | null;
    deploymentRole: string;
    riskTier: string;
    status: string;
    purpose: string | null;
    useContext: string | null;
    classificationClauseId: string | null;
    classificationRationale: string | null;
    requirementLinks: Array<{
        id: string;
        requirement: {
            id: string;
            code: string;
            title: string;
            framework: { key: string; name: string };
        };
    }>;
}

interface Props {
    system: AiSystemDetail;
    tenantSlug: string;
    canWrite: boolean;
}

const DOC_TYPES = [
    { id: 'ANNEX_IV_TECHNICAL_DOCUMENTATION', label: 'Technical Documentation (Annex IV)' },
    { id: 'ART_9_RISK_MANAGEMENT', label: 'Risk Management record (Art. 9)' },
    { id: 'ANNEX_V_DECLARATION_OF_CONFORMITY', label: 'Declaration of Conformity (Annex V)' },
] as const;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-0.5 border-b border-border-subtle py-2 last:border-0 sm:flex-row sm:items-baseline sm:justify-between">
            <span className="text-xs uppercase tracking-wide text-content-subtle">{label}</span>
            <span className="text-sm text-content-default sm:text-right">{children}</span>
        </div>
    );
}

export function AiSystemDetailClient({ system, tenantSlug, canWrite }: Props) {
    const tx = useTranslations('risks');
    // #107 READ side. Null `listKey`, so this is published-order-or-nothing:
    // the registry at /risks/ai-systems renders server-side, so its rows never
    // land in an SWR cache entry and a fallback read would fire a fresh
    // `GET /ai-systems` on EVERY detail load — a round-trip per page view to
    // serve arrows for a list the deep-linking user never saw. Hiding the
    // arrows is the documented semantic for that case.
    const systemIds = useEntityListIds(null, { orderKey: CACHE_KEYS.aiSystems.list() });

    // Rendered through PageHeader's `titleAdornment` slot, which paints it as a
    // SIBLING of the <h1>. Folding it into `title` instead would put two
    // <button aria-label="Previous …"> inside the heading, and the accname
    // spec concatenates a descendant control's label into the heading's own
    // accessible name. There is no `aiSystem` phrase in the stepper catalog
    // yet, so `labelSingular` resolves to the generic record wording.
    const stepper = (
        <EntityPrevNextNav
            ids={systemIds}
            currentId={system.id}
            hrefFor={(id) => `/t/${tenantSlug}/risks/ai-systems/${id}`}
            labelSingular="aiSystem"
        />
    );

    const [busy, setBusy] = useState<string | null>(null);
    const [queued, setQueued] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);

    const generate = async (docType: string) => {
        setError(null);
        setBusy(docType);
        try {
            const res = await fetch(`/api/t/${tenantSlug}/ai-systems/${system.id}/conformity`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ docType }),
            });
            if (!res.ok) {
                const body = (await res.json().catch(() => null)) as { error?: string } | null;
                throw new Error(body?.error ?? tx('aiSystems.detail.errorFallback'));
            }
            setQueued((q) => [...q, docType]);
        } catch (e) {
            setError(e instanceof Error ? e.message : tx('aiSystems.detail.errorFallback'));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="space-y-section">
            <PageHeader
                back={{ smart: true }}
                breadcrumbs={[
                    { label: tx('breadcrumbDashboard'), href: `/t/${tenantSlug}/dashboard` },
                    { label: tx('aiSystems.risksCrumb'), href: `/t/${tenantSlug}/risks` },
                    { label: tx('aiSystems.title'), href: `/t/${tenantSlug}/risks/ai-systems` },
                    { label: system.name },
                ]}
                title={system.name}
                titleAdornment={stepper}
                description={tx('aiSystems.detail.metaLine', { tier: system.riskTier, clause: system.classificationClauseId ?? tx('aiSystems.detail.unclassified'), role: system.deploymentRole === 'PROVIDER' ? tx('aiSystems.provider') : tx('aiSystems.deployer') })}
                actions={
                    <StatusBadge variant={TIER_VARIANT[system.riskTier] ?? 'neutral'}>
                        {system.riskTier}
                    </StatusBadge>
                }
            />

            <Card>
                <Heading level={2} className="mb-2 text-sm font-semibold text-content-emphasis">{tx('aiSystems.detail.classificationHeading')}</Heading>
                <Row label={tx('aiSystems.colRiskTier')}>
                    <StatusBadge variant={TIER_VARIANT[system.riskTier] ?? 'neutral'}>{system.riskTier}</StatusBadge>
                </Row>
                <Row label={tx('aiSystems.detail.rowDrivingClause')}>{system.classificationClauseId ?? '—'}</Row>
                <Row label={tx('aiSystems.colBasis')}>{system.classificationRationale ?? '—'}</Row>
                <Row label={tx('aiSystems.provider')}>{system.provider ?? '—'}</Row>
                <Row label={tx('aiSystems.detail.rowPurpose')}>{system.purpose ?? '—'}</Row>
                <Row label={tx('aiSystems.new.useContextLabel')}>{system.useContext ?? '—'}</Row>
            </Card>

            <Card>
                <Heading level={2} className="mb-2 text-sm font-semibold text-content-emphasis">
                    {tx('aiSystems.detail.linkedObligations', { count: system.requirementLinks.length })}
                </Heading>
                {system.requirementLinks.length === 0 ? (
                    <p className="text-sm text-content-muted">{tx('aiSystems.detail.obligationsEmpty')}</p>
                ) : (
                    <ul className="space-y-tight">
                        {system.requirementLinks.map((l) => (
                            <li key={l.id} className="flex items-start gap-tight text-sm">
                                <StatusBadge variant="info" size="sm">
                                    {l.requirement.framework.key} {l.requirement.code}
                                </StatusBadge>
                                <span className="text-content-default">{l.requirement.title}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            {system.riskTier === 'HIGH' && (
                <Card>
                    <Heading level={2} className="mb-1 text-sm font-semibold text-content-emphasis">{tx('aiSystems.detail.conformityHeading')}</Heading>
                    <p className="mb-3 text-xs text-content-subtle">
                        {tx('aiSystems.detail.conformityHelp')}
                    </p>
                    {error && (
                        <div className="mb-3 rounded-lg border border-border-error bg-bg-error px-3 py-2 text-sm text-content-error" role="alert">
                            {error}
                        </div>
                    )}
                    <div className="flex flex-col gap-tight sm:flex-row sm:flex-wrap">
                        {DOC_TYPES.map((d) => (
                            <Button
                                key={d.id}
                                variant="secondary"
                                size="sm"
                                disabled={!canWrite || busy === d.id || queued.includes(d.id)}
                                onClick={() => generate(d.id)}
                            >
                                {busy === d.id ? tx('aiSystems.detail.generating') : queued.includes(d.id) ? tx('aiSystems.detail.queued') : d.label}
                            </Button>
                        ))}
                    </div>
                    {queued.length > 0 && (
                        <p className="mt-3 text-sm text-content-muted">
                            {queued.length > 1
                                ? tx('aiSystems.detail.draftsQueuedPlural')
                                : tx('aiSystems.detail.draftsQueuedSingular')}
                            <Link href={`/t/${tenantSlug}/agent-proposals`} className="text-content-link underline">
                                {tx('aiSystems.detail.approvalQueue')}
                            </Link>
                            .
                        </p>
                    )}
                </Card>
            )}
        </div>
    );
}
