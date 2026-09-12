'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { formatDateTime } from '@/lib/format-date';
import { useTenantHref } from '@/lib/tenant-context-provider';

import { AgentsViewsMenu } from '../AgentsViewsMenu';
import { ExportPackButton } from './ExportPackButton';
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

interface AsiAgentRow {
    agentId: string;
    name: string;
    status: string;
    covered: string[];
    partiallyCovered: string[];
    reviewNeeded: string[];
    uncovered: string[];
    notApplicable: string[];
}

interface KillHistoryRow {
    id: string;
    scope: 'AGENT' | 'TENANT';
    agentName: string | null;
    reason: string;
    engagedAt: string;
    liftedAt: string | null;
    durationMinutes: number;
    stillInForce: boolean;
}

interface ThirdPartyAgentRow {
    agentId: string;
    name: string;
    vendorId: string | null;
    vendorName: string | null;
    vendorUnresolved: boolean;
    latestCompletedAssessment: { id: string; decidedAt: string; riskRating: string | null } | null;
    openAssessments: number;
}

export interface PackView {
    generatedAt: string;
    tenantId: string;
    inventory: EnvelopeView<{ agents: InventoryRow[]; legacyPlaceholderPresent: boolean }>;
    asiCoverage: EnvelopeView<{
        frameworkInstalled: boolean;
        framework: { key: string; name: string } | null;
        agents: AsiAgentRow[];
    }>;
    approvals: EnvelopeView<{ unobservable: readonly string[] }>;
    incidents: EnvelopeView<{ kills: KillHistoryRow[]; drills: unknown[] }>;
    thirdParty: EnvelopeView<{ agents: ThirdPartyAgentRow[] }>;
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
    canExport,
}: {
    tenantSlug: string;
    pack: PackView;
    enforcing: boolean;
    /** `admin.view` — the proposals and runs entries' own gate. */
    canReviewProposals: boolean;
    /** `admin.agent_registry` — this page's gate, so it is true by construction here. */
    canInvestigate: boolean;
    /**
     * `evidence.edit`. NOT true by construction: the register key and the
     * evidence key are separate grants, so an assessor-facing reader can hold
     * this page and still be unable to file what it renders. The button is
     * hidden rather than shown-and-refused — an action that always 403s is a
     * defect report waiting to be filed against a working permission model.
     */
    canExport: boolean;
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
                    <div className="flex items-center gap-3">
                        {canExport && <ExportPackButton />}
                        <AgentsViewsMenu
                            tenantSlug={tenantSlug}
                            current="reports"
                            canReviewProposals={canReviewProposals}
                            canInvestigate={canInvestigate}
                        />
                    </div>
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
            {/* ── REPORT 2 — ASI COVERAGE ─────────────────────────────── */}
            <Card>
                <Heading level={2}>{t('reports.asiHeading')}</Heading>

                {/* TWO UNRELATED NUMBERS IN THIS PRODUCT SHARE THIS NAME, and an
                    auditor handed the wrong one is the failure this warning
                    exists to prevent. A CI ratchet measures the PRODUCT's own
                    code controls; this measures THIS TENANT's control library
                    against its registered agents. Labelled, not left to
                    context. */}
                <InlineNotice variant="info" icon={null} data-testid="reports-asi-which-number">
                    {t('reports.asiWhichNumber')}
                </InlineNotice>

                {!pack.asiCoverage.body.frameworkInstalled ? (
                    <InlineNotice variant="warning" data-testid="reports-asi-no-framework">
                        {t('reports.asiNoFramework')}
                    </InlineNotice>
                ) : (
                    <>
                        <Metrics envelope={pack.asiCoverage} />
                        <Truncated envelope={pack.asiCoverage} />
                        <ul className="space-y-compact" data-testid="reports-asi-agents">
                            {pack.asiCoverage.body.agents.map((a) => (
                                <li key={a.agentId} data-testid={`asi-agent-${a.agentId}`}>
                                    <span className="text-content-emphasis">{a.name}</span>
                                    {/* THE UNCOVERED LIST, EXPLICITLY. A
                                        percentage hides WHICH risk is open, and
                                        which risk is open is the only thing
                                        being asked. */}
                                    <p className="text-sm">
                                        {a.uncovered.length === 0 ? (
                                            <span className="text-content-success">
                                                {t('reports.asiAllCovered')}
                                            </span>
                                        ) : (
                                            <span className="text-content-error" data-testid={`asi-uncovered-${a.agentId}`}>
                                                {t('reports.asiUncovered', {
                                                    codes: a.uncovered.join(', '),
                                                })}
                                            </span>
                                        )}
                                    </p>
                                    {a.reviewNeeded.length > 0 && (
                                        // A third state, kept distinct from both:
                                        // claimed but unverified is not covered
                                        // and is not open.
                                        <p
                                            className="text-sm text-content-warning"
                                            data-testid={`asi-review-needed-${a.agentId}`}
                                        >
                                            {t('reports.asiReviewNeeded', {
                                                codes: a.reviewNeeded.join(', '),
                                            })}
                                        </p>
                                    )}
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </Card>

            {/* ── REPORT 3 — APPROVAL QUALITY ─────────────────────────── */}
            <Card>
                <Heading level={2}>{t('reports.approvalsHeading')}</Heading>
                {/* "the one most likely to be uncomfortable — render it plainly
                    rather than softening it." So the figures are first and
                    unqualified, and the link to the detail follows them. */}
                <Metrics envelope={pack.approvals} />
                <Truncated envelope={pack.approvals} />
                {pack.approvals.body.unobservable.length > 0 && (
                    // WHAT THIS REPORT CANNOT ANSWER, stated. A pack that
                    // rendered only its positive figures would read as complete.
                    <InlineNotice variant="warning" icon={null} data-testid="reports-approvals-unobservable">
                        {t('reports.approvalsUnobservable', {
                            items: pack.approvals.body.unobservable.join(', '),
                        })}
                    </InlineNotice>
                )}
                <Link className="text-sm underline" href={tenantHref('/agents/review-quality')}>
                    {t('reports.approvalsDetailLink')}
                </Link>
            </Card>

            {/* ── REPORT 4 — INCIDENTS AND THE STOP CONTROL ───────────── */}
            <Card>
                <Heading level={2}>{t('reports.incidentsHeading')}</Heading>
                <Metrics envelope={pack.incidents} />
                <Truncated envelope={pack.incidents} />
                <ul className="space-y-tight text-sm" data-testid="reports-kills">
                    {pack.incidents.body.kills.map((k) => (
                        <li key={k.id} data-testid={`kill-${k.id}`}>
                            <span className="text-content-emphasis">
                                {k.scope === 'TENANT'
                                    ? t('reports.killScopeTenant')
                                    : (k.agentName ?? k.scope)}
                            </span>
                            {' — '}
                            {/* ACTOR AND REASON, which is exactly what gets
                                asked and what the pack could not answer before
                                2/4 rendered the history. */}
                            {t('reports.killLine', {
                                at: formatDateTime(k.engagedAt),
                                reason: k.reason,
                            })}
                            {k.stillInForce && (
                                <span className="ml-1 text-content-error">
                                    {t('reports.killStillInForce')}
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            </Card>

            {/* ── REPORT 5 — THIRD-PARTY ASSURANCE ────────────────────── */}
            <Card>
                <Heading level={2}>{t('reports.thirdPartyHeading')}</Heading>
                <Metrics envelope={pack.thirdParty} />
                <Truncated envelope={pack.thirdParty} />
                <ul className="space-y-tight text-sm" data-testid="reports-third-party">
                    {pack.thirdParty.body.agents.map((a) => (
                        <li key={a.agentId} data-testid={`third-party-${a.agentId}`}>
                            <span className="text-content-emphasis">{a.name}</span>
                            {' — '}
                            {a.vendorUnresolved || !a.vendorId ? (
                                // A third-party agent whose supplier cannot be
                                // resolved is the worst row here: somebody
                                // else's code with no assurance attached to it.
                                <span className="text-content-error">
                                    {t('reports.thirdPartyNoVendor')}
                                </span>
                            ) : (
                                <>
                                    <Link className="underline" href={tenantHref(`/vendors/${a.vendorId}`)}>
                                        {a.vendorName ?? a.vendorId}
                                    </Link>
                                    {' — '}
                                    {a.latestCompletedAssessment ? (
                                        <span>
                                            {t('reports.thirdPartyAssessed', {
                                                at: formatDateTime(a.latestCompletedAssessment.decidedAt),
                                            })}
                                        </span>
                                    ) : (
                                        <span className="text-content-warning">
                                            {t('reports.thirdPartyUnassessed')}
                                        </span>
                                    )}
                                </>
                            )}
                        </li>
                    ))}
                </ul>
            </Card>
        </DashboardLayout>
    );
}
