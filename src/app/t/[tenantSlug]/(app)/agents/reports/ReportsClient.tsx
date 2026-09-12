'use client';

import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { formatDateTime } from '@/lib/format-date';
import { useTenantHref } from '@/lib/tenant-context-provider';

import { AgentsViewsMenu } from '../AgentsViewsMenu';
import { Metric, type DefinitionView, type MeasureView } from './Metric';

/** One report's envelope, as it crosses the server/client boundary. */
interface EnvelopeView<TBody> {
    reportId: string;
    generatedAt: string;
    window: { days: number; since: string } | null;
    truncated: boolean;
    metrics: Record<string, MeasureView>;
    definitions: DefinitionView[];
    body: TBody;
}

interface InventoryRow {
    agentId: string;
    name: string;
    status: string;
    autonomyLevel: number;
    provenance: string;
    ownerName: string | null;
    riskTier: string | null;
}

export interface PackView {
    generatedAt: string;
    tenantId: string;
    inventory: EnvelopeView<{ agents: InventoryRow[]; legacyPlaceholderPresent: boolean }>;
    asiCoverage: EnvelopeView<unknown>;
    approvals: EnvelopeView<unknown>;
    incidents: EnvelopeView<unknown>;
    thirdParty: EnvelopeView<unknown>;
}

/**
 * A report's figures, each with its definition. One helper rather than five
 * copies: the definitions arrive keyed by id and the metrics by the same id, so
 * the pairing is mechanical — and doing it per report by hand is five chances to
 * pair them differently.
 */
function Metrics({ envelope }: { envelope: EnvelopeView<unknown> }) {
    const byId = new Map(envelope.definitions.map((d) => [d.id, d]));
    return (
        <div className="grid grid-cols-1 gap-default sm:grid-cols-2 lg:grid-cols-3">
            {Object.entries(envelope.metrics).map(([id, measure]) => (
                <Metric key={id} id={id} measure={measure} definition={byId.get(id)} />
            ))}
        </div>
    );
}

/** A report whose read hit its row cap says so, beside the figures it bounded. */
function Truncated({ envelope }: { envelope: EnvelopeView<unknown> }) {
    const t = useTranslations('agents');
    if (!envelope.truncated) return null;
    return (
        <InlineNotice variant="warning" icon={null} data-testid={`truncated-${envelope.reportId}`}>
            {/* "A report over 'the most recent 500' that presents itself as a
                report over everything is a denominator quietly replaced by a
                smaller one." */}
            {t('reports.truncated')}
        </InlineNotice>
    );
}

export function ReportsClient({
    tenantSlug,
    pack,
    enforcing,
    canReviewProposals,
    canInvestigate,
}: {
    tenantSlug: string;
    pack: PackView;
    enforcing: boolean;
    /** `admin.view` — the proposals and runs entries' own gate. */
    canReviewProposals: boolean;
    /** `admin.agent_registry` — this page's gate, so it is true by construction here. */
    canInvestigate: boolean;
}) {
    const t = useTranslations('agents');
    const tenantHref = useTenantHref();
    const agents = pack.inventory.body.agents;

    return (
        <DashboardLayout
            data-testid="agent-reports"
            // `header` is the PageHeader's PROPS, not an element — the shell
            // renders it, so passing JSX here type-errors rather than
            // double-wrapping silently.
            header={{
                back: { smart: true },
                breadcrumbs: [
                    { label: t('crumbDashboard'), href: tenantHref('/dashboard') },
                    { label: t('register.breadcrumb'), href: tenantHref('/agents') },
                    { label: t('reports.crumb') },
                ],
                title: t('reports.title'),
                description: t('reports.description'),
                actions: (
                    <AgentsViewsMenu
                        tenantSlug={tenantSlug}
                        current="reports"
                        canReviewProposals={canReviewProposals}
                        canInvestigate={canInvestigate}
                    />
                ),
            }}
        >
            {/* THE MOST IMPORTANT LINE ON THE PAGE, and it is first.
                Every figure below describes a register that refuses nothing
                unless registration is enforced. An assessor reading the pack
                without that caveat would be misled about what it means, and no
                individual number carries the warning. */}
            {!enforcing && (
                <InlineNotice
                    variant="error"
                    title={t('reports.notEnforcingTitle')}
                    data-testid="reports-not-enforcing"
                >
                    {t('reports.notEnforcingBody')}
                </InlineNotice>
            )}

            {/* THE STAMP. An assessor screenshots this, so it must carry its own
                provenance without a surrounding conversation: which tenant, at
                what moment, over what population. */}
            <Card data-testid="reports-stamp">
                <dl className="grid grid-cols-1 gap-default sm:grid-cols-3 text-sm">
                    <div>
                        <dt className="text-xs uppercase tracking-wide text-content-subtle">
                            {t('reports.stampTenant')}
                        </dt>
                        <dd className="text-content-emphasis">{tenantSlug}</dd>
                    </div>
                    <div>
                        <dt className="text-xs uppercase tracking-wide text-content-subtle">
                            {t('reports.stampGenerated')}
                        </dt>
                        <dd className="text-content-emphasis">{formatDateTime(pack.generatedAt)}</dd>
                    </div>
                    <div>
                        <dt className="text-xs uppercase tracking-wide text-content-subtle">
                            {t('reports.stampPopulation')}
                        </dt>
                        <dd className="text-content-emphasis">
                            {t('reports.stampPopulationValue', { count: agents.length })}
                        </dd>
                    </div>
                </dl>
            </Card>

            <Card>
                <Heading level={2}>{t('reports.inventoryHeading')}</Heading>
                {agents.length === 0 ? (
                    // A TRUE AND USEFUL ANSWER, not an error. "No agents are
                    // registered" is exactly what an assessor asked, answered.
                    <EmptyState
                        title={t('reports.emptyTitle')}
                        description={t('reports.emptyDesc')}
                    />
                ) : (
                    <>
                        <Metrics envelope={pack.inventory} />
                        <Truncated envelope={pack.inventory} />
                        {pack.inventory.body.legacyPlaceholderPresent && (
                            // Reported OUT of every count and named rather than
                            // dropped: an assessor who sees it knows there are
                            // pre-register proposals nobody has attributed yet.
                            <InlineNotice variant="warning" icon={null} data-testid="reports-legacy-placeholder">
                                {t('reports.legacyPlaceholder')}
                            </InlineNotice>
                        )}
                    </>
                )}
            </Card>
        </DashboardLayout>
    );
}
