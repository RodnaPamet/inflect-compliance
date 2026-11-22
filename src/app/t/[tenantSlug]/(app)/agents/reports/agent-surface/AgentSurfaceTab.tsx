'use client';

/**
 * THE AGENT SURFACE TAB on `/agents/reports` — what static rules found written
 * into the MCP tool definitions each trusted scanner read, as its latest
 * `scanent-agent-rules/1` report and the open findings it raised say.
 *
 * READ-ONLY. The findings are raised and closed by the ingest and live in the
 * findings register; this tab shows them beside the server and tool they are
 * about, and changes nothing. A finding is a suggestion a person confirms: the
 * scanner kept no text of the definition, so the tab shows where the rule
 * fired, never what it read.
 *
 * ZERO IS NEVER COMPLETE. No scan, a read of no tool definition, a read in
 * part and a trusted scanner that has sent no such report are each a stated
 * condition, never an empty state; "no rule fired" is said only of a complete
 * read that held at least one tool (`agentRuleScanState`).
 *
 * Everything arrives as plain data from `getAgentRuleInventory`. The contract's
 * modules require `crypto`, so none of them is imported here.
 */
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { Card } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { DataTable, createColumns } from '@/components/ui/table';
import { Heading } from '@/components/ui/typography';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import {
    agentRuleScanState,
    type AgentRuleFindingView,
    type AgentRuleInventoryView,
    type AgentRuleSection,
} from '@/lib/agentic/agent-rule-read-model';

const STATE_VARIANT: Readonly<Record<ReturnType<typeof agentRuleScanState>, StatusBadgeVariant>> = {
    FINDINGS: 'warning',
    CLEAN: 'success',
    NOTHING_READ: 'error',
    NOT_CONCLUDED: 'warning',
};

const SEVERITY_VARIANT: Readonly<Record<string, StatusBadgeVariant>> = {
    HIGH: 'error',
    MEDIUM: 'warning',
    LOW: 'info',
};

function reasonText(t: ReturnType<typeof useTranslations>, reason: string | null): string {
    return reason ? t(`harness.incompleteReason.${reason}`) : '';
}

function AgentSurfaceSection({ section }: { section: AgentRuleSection }) {
    const t = useTranslations('agents');
    const { scan } = section;
    const state = agentRuleScanState(scan);
    const columns = useMemo(
        () =>
            createColumns<AgentRuleFindingView>([
                {
                    id: 'severity',
                    header: t('reports.agentSurface.colSeverity'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <StatusBadge variant={SEVERITY_VARIANT[row.original.severity] ?? 'neutral'} size="sm">
                            {row.original.severity}
                        </StatusBadge>
                    ),
                },
                {
                    id: 'finding',
                    header: t('reports.agentSurface.colFinding'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <div className="text-xs">
                            <p className="text-content-emphasis">{t(`reports.agentSurface.code.${row.original.code}`)}</p>
                            <p className="font-mono text-content-subtle">{row.original.ruleId}</p>
                        </div>
                    ),
                },
                {
                    id: 'where',
                    header: t('reports.agentSurface.colWhere'),
                    enableSorting: false,
                    cell: ({ row }) => (
                        <div className="text-xs" data-testid={`agent-surface-where-${row.original.findingId}`}>
                            <p className="font-mono break-all">{row.original.subjectRef}</p>
                            <p className="text-content-muted">{t('reports.agentSurface.field', { field: row.original.field })}</p>
                        </div>
                    ),
                },
            ]),
        [t],
    );

    return (
        <Card data-testid={`agent-surface-section-${scan.scanRef}`} className="space-y-default">
            <div className="flex flex-wrap items-center gap-compact">
                <Heading level={2}>
                    {t('reports.agentSurface.sectionHeading', {
                        scanner: section.scannerName ?? section.scannerAgentId,
                        asOf: formatDateTime(scan.asOf),
                    })}
                </Heading>
                <StatusBadge variant={STATE_VARIANT[state]} data-testid={`agent-surface-state-${scan.scanRef}`}>
                    {t(`reports.agentSurface.state.${state}`)}
                </StatusBadge>
            </div>
            <p className="text-sm" data-testid={`agent-surface-summary-${scan.scanRef}`}>
                {t('reports.agentSurface.summary', { subjects: scan.subjects, flagged: scan.flagged, findings: scan.findingCount })}
            </p>
            {state === 'NOTHING_READ' && (
                <InlineNotice variant="error" data-testid={`agent-surface-nothing-read-${scan.scanRef}`}>
                    {t('reports.agentSurface.nothingRead')}
                </InlineNotice>
            )}
            {!scan.complete && (
                <InlineNotice variant="warning" data-testid={`agent-surface-incomplete-${scan.scanRef}`}>
                    {t('reports.agentSurface.incomplete', { reason: reasonText(t, scan.incompleteReason) })}
                </InlineNotice>
            )}
            <div>
                <Heading level={3}>{t('reports.agentSurface.serversHeading')}</Heading>
                {section.servers.length === 0 ? (
                    <p className="text-sm text-content-warning">{t('reports.agentSurface.noServers')}</p>
                ) : (
                    <ul className="space-y-tight text-xs">
                        {section.servers.map((s) => (
                            <li
                                key={s.ref}
                                className={s.status === 'INCOMPLETE' ? 'text-content-warning' : undefined}
                                data-testid={`agent-surface-server-${s.ref}`}
                            >
                                <span className="font-mono break-all">{s.ref}</span>{' '}
                                {s.status === 'COMPLETE'
                                    ? t('reports.agentSurface.serverComplete', { tools: s.tools })
                                    : t('reports.agentSurface.serverIncomplete', { tools: s.tools, reason: reasonText(t, s.reason) })}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <div>
                <Heading level={3}>{t('reports.agentSurface.findingsHeading')}</Heading>
                {section.findings.length === 0 ? (
                    <p className="text-sm text-content-muted" data-testid={`agent-surface-no-open-${scan.scanRef}`}>
                        {t('reports.agentSurface.noOpenFindings')}
                    </p>
                ) : (
                    <DataTable
                        data={section.findings as AgentRuleFindingView[]}
                        columns={columns}
                        getRowId={(r) => r.findingId}
                        data-testid={`agent-surface-findings-${scan.scanRef}`}
                    />
                )}
                {section.findingsTruncated && (
                    <InlineNotice variant="warning" icon={null} data-testid={`agent-surface-findings-truncated-${scan.scanRef}`}>
                        {t('reports.agentSurface.findingsTruncated')}
                    </InlineNotice>
                )}
            </div>
        </Card>
    );
}

export function AgentSurfaceTab({ view }: { view: AgentRuleInventoryView }) {
    const t = useTranslations('agents');
    return (
        <>
            <InlineNotice variant="info" icon={null} data-testid="agent-surface-read-only">
                {t('reports.agentSurface.readOnly')}
            </InlineNotice>
            {view.sections.length === 0 ? (
                <InlineNotice variant="error" title={t('reports.agentSurface.noScansTitle')} data-testid="agent-surface-no-scans">
                    {t('reports.agentSurface.noScansBody')}
                </InlineNotice>
            ) : (
                view.sections.map((section) => <AgentSurfaceSection key={section.scan.scanRef} section={section} />)
            )}
            {view.scannersNotShown > 0 && (
                <InlineNotice variant="warning" data-testid="agent-surface-scanners-not-shown">
                    {t('reports.agentSurface.scannersNotShown', { count: view.scannersNotShown })}
                </InlineNotice>
            )}
            {view.scannersWithoutScan.length > 0 && (
                <InlineNotice variant="warning" data-testid="agent-surface-scanners-without-scan">
                    {t('reports.agentSurface.scannersWithoutScan', {
                        count: view.scannersWithoutScan.length,
                        names: view.scannersWithoutScan.map((r) => r.name ?? r.agentId).join(', '),
                    })}
                </InlineNotice>
            )}
            {view.scansTruncated && (
                <InlineNotice variant="warning" icon={null} data-testid="agent-surface-scans-truncated">
                    {t('reports.agentSurface.scansTruncated')}
                </InlineNotice>
            )}
        </>
    );
}
