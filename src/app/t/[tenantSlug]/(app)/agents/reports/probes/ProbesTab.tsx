'use client';

/**
 * THE PROBES TAB on `/agents/reports` (active flavour, step 8b) — what each
 * prober's recent runs of fixed attacker probes made the estate's agents do, as
 * its signed `scanent-probes/1` reports say, and the open findings they raised.
 *
 * READ-ONLY about the runs. Findings are raised and closed by the ingest and
 * live in the findings register. A run's row opens its detail (`?run=`), which
 * the SERVER reads: the full endpoint and what the agent said are there only
 * for a holder of the register key, and the panel says they were withheld from
 * anybody else, never that they are empty.
 *
 * ZERO IS NEVER COMPLETE. No run, a run that reached no target, a stopped run
 * and a prober key holder with no run in the window are each a stated
 * condition; "every probe resisted" is said only by `probeRunState`.
 *
 * The two key cards render only when the server read them for this viewer:
 * the prober register for `admin.agent_registry`, the approver register for an
 * owner (`admin.tenant_lifecycle`).
 */
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { DataTable, createColumns } from '@/components/ui/table';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import { useTenantHref } from '@/lib/tenant-context-provider';
import {
    probeRunState,
    type ApproverKeysView,
    type ProbeFindingView,
    type ProberKeysView,
    type ProbeRunDetailView,
    type ProbeRunInventoryView,
    type ProbeRunSection,
    type ProbeRunView,
} from '@/lib/agentic/probe-run-read-model';

import { ApproverKeysCard } from './ApproverKeysCard';
import { ProberKeysCard } from './ProberKeysCard';
import { ProbeRunSheet, RUN_STATE_VARIANT } from './ProbeRunSheet';

const SEVERITY_VARIANT: Readonly<Record<string, StatusBadgeVariant>> = {
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'info',
};

function ProbeSection({ section, onOpenRun }: { section: ProbeRunSection; onOpenRun: (runId: string) => void }) {
    const t = useTranslations('agents');
    const runColumns = useMemo(
        () =>
            createColumns<ProbeRunView>([
                {
                    id: 'started',
                    header: t('reports.probes.colStarted'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="text-xs">{formatDateTime(row.original.startedAt)}</span>,
                },
                {
                    id: 'engagement',
                    header: t('reports.probes.colEngagement'),
                    enableSorting: false,
                    cell: ({ row }) => <span className="font-mono text-xs break-all">{row.original.engagementId}</span>,
                },
                {
                    id: 'state',
                    header: t('reports.probes.colState'),
                    enableSorting: false,
                    cell: ({ row }) => {
                        const state = probeRunState(row.original);
                        return (
                            <StatusBadge variant={RUN_STATE_VARIANT[state]} size="sm" data-testid={`probe-run-state-${row.original.runId}`}>
                                {t(`reports.probes.state.${state}`)}
                            </StatusBadge>
                        );
                    },
                },
                {
                    id: 'counts',
                    header: t('reports.probes.colCounts'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <span className="text-xs" data-testid={`probe-run-counts-${row.original.runId}`}>
                            {t('reports.probes.counts', {
                                acted: row.original.actedCount,
                                disclosed: row.original.disclosedCount,
                                resisted: row.original.resistedCount,
                                inconclusive: row.original.inconclusiveCount,
                            })}
                        </span>
                    ),
                },
                {
                    id: 'targets',
                    header: t('reports.probes.colTargets'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <span className="text-xs">
                            {t('reports.probes.targetsReached', {
                                reached: row.original.targetsReached,
                                total: row.original.targetCount,
                            })}
                        </span>
                    ),
                },
            ]),
        [t],
    );
    const findingColumns = useMemo(
        () =>
            createColumns<ProbeFindingView>([
                {
                    id: 'severity',
                    header: t('reports.probes.colSeverity'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <StatusBadge variant={SEVERITY_VARIANT[row.original.severity] ?? 'neutral'} size="sm">
                            {row.original.severity in SEVERITY_VARIANT
                                ? t(`reports.agentSurface.severity.${row.original.severity}`)
                                : row.original.severity}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'finding',
                    header: t('reports.probes.colFinding'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <div className="text-xs">
                            <p className="text-content-emphasis">{t(`reports.probes.reason.${row.original.verdictReason}`)}</p>
                            <p className="font-mono text-content-subtle">{row.original.probeId}</p>
                        </div>
                    ),
                },
                {
                    id: 'where',
                    header: t('reports.probes.colWhere'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <div className="text-xs" data-testid={`probe-finding-where-${row.original.findingId}`}>
                            <p className="font-mono break-all">{row.original.origin}</p>
                            <p className="text-content-muted">
                                {row.original.tool
                                    ? t('reports.probes.kindWithTool', { kind: t(`reports.probes.kind.${row.original.kind}`), tool: row.original.tool })
                                    : t(`reports.probes.kind.${row.original.kind}`)}
                            </p>
                        </div>
                    ),
                },
            ]),
        [t],
    );

    return (
        <Card data-testid={`probe-section-${section.proberAgentId}`} className="space-y-default">
            <Heading level={2}>{t('reports.probes.sectionHeading', { prober: section.proberName ?? section.proberAgentId })}</Heading>
            <div>
                <Heading level={3}>{t('reports.probes.runsHeading')}</Heading>
                <DataTable
                    data={section.runs as ProbeRunView[]}
                    columns={runColumns}
                    getRowId={(r) => r.runId}
                    onRowClick={(row) => onOpenRun(row.original.runId)}
                    data-testid={`probe-runs-${section.proberAgentId}`}
                />
                {section.runsTruncated && (
                    <InlineNotice variant="info" icon={null} data-testid={`probe-runs-truncated-${section.proberAgentId}`}>
                        {t('reports.probes.runsTruncated', { count: section.runs.length })}
                    </InlineNotice>
                )}
            </div>
            <div>
                <Heading level={3}>{t('reports.probes.findingsHeading')}</Heading>
                {section.findings.length === 0 ? (
                    <p className="text-sm text-content-muted" data-testid={`probe-no-open-${section.proberAgentId}`}>
                        {t('reports.probes.noOpenFindings')}
                    </p>
                ) : (
                    <DataTable
                        data={section.findings as ProbeFindingView[]}
                        columns={findingColumns}
                        getRowId={(r) => r.findingId}
                        data-testid={`probe-findings-${section.proberAgentId}`}
                    />
                )}
                {section.findingsTruncated && (
                    <InlineNotice variant="warning" icon={null} data-testid={`probe-findings-truncated-${section.proberAgentId}`}>
                        {t('reports.probes.findingsTruncated')}
                    </InlineNotice>
                )}
            </div>
        </Card>
    );
}

export function ProbesTab({
    view,
    proberKeys,
    approverKeys,
    detail,
}: {
    view: ProbeRunInventoryView;
    proberKeys: ProberKeysView | null;
    approverKeys: ApproverKeysView | null;
    detail: ProbeRunDetailView | null;
}) {
    const t = useTranslations('agents');
    const router = useRouter();
    const tenantHref = useTenantHref();
    const openRun = (runId: string) => router.push(tenantHref(`/agents/reports?tab=probes&run=${encodeURIComponent(runId)}`));
    const closeRun = () => router.replace(tenantHref('/agents/reports?tab=probes'));

    return (
        <>
            <InlineNotice variant="info" icon={null} data-testid="probes-read-only">
                {t('reports.probes.readOnly')}
            </InlineNotice>
            {view.sections.length === 0 ? (
                <InlineNotice variant="error" title={t('reports.probes.noRunsTitle')} data-testid="probes-no-runs">
                    {t('reports.probes.noRunsBody')}
                </InlineNotice>
            ) : (
                view.sections.map((section) => <ProbeSection key={section.proberAgentId} section={section} onOpenRun={openRun} />)
            )}
            {view.probersNotShown > 0 && (
                <InlineNotice variant="warning" data-testid="probes-probers-not-shown">
                    {t('reports.probes.probersNotShown', { count: view.probersNotShown })}
                </InlineNotice>
            )}
            {view.probersWithoutRun.length > 0 && (
                <InlineNotice variant="warning" data-testid="probes-probers-without-run">
                    {t('reports.probes.probersWithoutRun', {
                        count: view.probersWithoutRun.length,
                        names: view.probersWithoutRun.map((r) => r.name ?? r.agentId).join(', '),
                    })}
                </InlineNotice>
            )}
            {view.runsTruncated && (
                <InlineNotice variant="warning" icon={null} data-testid="probes-runs-truncated">
                    {t('reports.probes.windowTruncated')}
                </InlineNotice>
            )}
            {proberKeys && <ProberKeysCard view={proberKeys} />}
            {approverKeys && <ApproverKeysCard view={approverKeys} />}
            {detail && <ProbeRunSheet detail={detail} onClose={closeRun} />}
        </>
    );
}
