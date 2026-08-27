'use client';

/**
 * The read surface for the dry-run leaver pass record.
 *
 * WHY A PAGE AND NOT JUST THE ENDPOINT. The write ladder mandates seven days of
 * DRY_RUN before a tenant may be promoted, and its own refusal text says the
 * point is to compare the pass against "what HR and IT actually did". The record
 * half shipped with `GET /admin/identity-leaver-passes`; until this page existed
 * the comparison was reachable only by an authorised HTTP call or a hand-written
 * SQL query, which is not something anyone can be asked to do daily for a week.
 *
 * THREE STATUSES, THREE MEANINGS, AND THE THIRD IS THE POINT. `writeExecutionRow`
 * is the only creator of these rows and it writes exactly three:
 *
 *   PASSED         — the pass ran and its report is complete.
 *   PARTIAL        — the pass ran; the DECISION LIST was cut at
 *                    MAX_REPORTED_DECISIONS. The directory outcomes are fine;
 *                    the artefact is short. (`decisionsTruncated: true`.)
 *   NOT_APPLICABLE — the pass RAN AND REFUSED, and `resultJson.refusal` names
 *                    which refusal.
 *
 * So NOT_APPLICABLE is deliberately NOT labelled "not applicable" here. The whole
 * reason a refusal is recorded at all is that "the pass ran and found nobody to
 * offboard" and "no pass ran" are the two readings an operator must be able to
 * tell apart during the observation window — rendering it as an absence would put
 * back exactly the silence the record was built to break.
 *
 * THE BASIS COLUMN IS NOT DECORATION. Every DRY_RUN decision carries the same
 * fixed reason sentence ("the disable was decided but not performed"), so before
 * it the table could show a hundred identical rows and no reader could tell
 * which of them rested on the cloud-only rule #2144 widened — nor, among the
 * refusals, which account is genuinely unobservable and which has simply not
 * been re-synced since that migration deliberately declined to backfill. Those
 * two call for opposite responses (investigate vs wait), and the basis is the
 * only thing on the row that separates them.
 *
 * `resultJson` is a Json column read back verbatim, so every field is narrowed
 * defensively rather than trusted: a row written by an older build, or by a
 * future one, must degrade to a thinner render, never to a thrown page.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { formatDateTime } from '@/lib/format-date';
import { useTenantHref } from '@/lib/tenant-context-provider';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { DataTable, createColumns } from '@/components/ui/table';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { PageBreadcrumbs } from '@/components/layout/PageBreadcrumbs';
import { BackAffordance } from '@/components/nav/BackAffordance';
import { InlineNotice } from '@/components/ui/inline-notice';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * Why the decision went the way it did, as `DecisionBasis` wrote it.
 *
 * Narrowed loosely on purpose: this is a Json column, so a row written by an
 * older build carries no basis at all and a row from a future one may carry a
 * `rule` this build has no label for. Both must degrade to a thinner cell.
 */
interface DecisionBasisJson {
    rule?: string;
    onPremisesSyncEnabled?: boolean | null;
    observedAt?: string;
}

/** One decision, keyed by `IdentityAccountLink.id` with its reason already scrubbed. */
interface PassDecision {
    linkId: string;
    outcome: string;
    reason?: string;
    basis?: DecisionBasisJson;
}

/** The `resultJson` payload, as written by `writeExecutionRow`. */
interface PassResult {
    mode?: string;
    evidence?: string;
    terminatedWorkers?: number;
    candidates?: number;
    population?: number;
    batchRefused?: string | null;
    counts?: Record<string, number>;
    decisions?: PassDecision[];
    decisionsTruncated?: boolean;
    refusal?: string;
    detail?: string;
}

export interface LeaverPassRow {
    id: string;
    provider: string;
    status: string;
    executedAt: string;
    completedAt: string | null;
    resultJson: unknown;
}

/**
 * Status tone + label key.
 *
 * NOT_APPLICABLE maps to `statusRefused` ("Ran and refused"), not to anything
 * that reads as "nothing happened" — see the module docstring. `info` rather
 * than `neutral` for the same reason: a refusal is a result, and a greyed-out
 * badge would read as a gap in the record.
 */
const STATUS_META: Record<string, { variant: StatusBadgeVariant; key: string }> = {
    PASSED: { variant: 'success', key: 'statusPassed' },
    PARTIAL: { variant: 'warning', key: 'statusPartial' },
    NOT_APPLICABLE: { variant: 'info', key: 'statusRefused' },
};

/**
 * Per-outcome tone.
 *
 * DRY_RUN is `info`, not `success`: nothing was written to a directory, and a
 * green tick against a decision that never happened is the single most
 * misleading thing this page could render.
 */
const OUTCOME_VARIANT: Record<string, StatusBadgeVariant> = {
    DISABLED: 'success',
    DRY_RUN: 'info',
    ALREADY_DISABLED: 'neutral',
    REFUSED_MODE: 'warning',
    REFUSED_TARGET: 'warning',
    REFUSED_PROTECTED: 'warning',
    FAILED: 'error',
    INDETERMINATE: 'error',
};

/**
 * Rule code → the i18n key that says it in words.
 *
 * The report's reader is deciding whether to grant this thing unattended
 * authority over their directory, and `DRY_RUN` alone does not support that
 * decision — every dry-run row carries the same fixed reason sentence, so the
 * table could not say which of them rested on the cloud-only rule #2144
 * widened. The basis is what separates them.
 *
 * A `rule` with no entry here falls back to the raw code rather than to an
 * empty cell: an unrecognised basis is still information, and a blank would
 * read as "no basis was recorded", which is a different fact.
 */
const BASIS_LABEL: Record<string, string> = {
    ON_PREM_DIRECTORY: 'basisOnPremDirectory',
    NOT_ON_PREM_SYNCED: 'basisNotOnPremSynced',
    CLOUD_ONLY_OBSERVED: 'basisCloudOnlyObserved',
    ON_PREM_MASTERED: 'basisOnPremMastered',
    NEVER_OBSERVED: 'basisNeverObserved',
    PROVIDER_CANNOT_OBSERVE: 'basisProviderCannotObserve',
    UNSUPPORTED_DIRECTORY: 'basisUnsupportedDirectory',
};

/**
 * The two REFUSED bases an operator must not confuse.
 *
 * `NEVER_OBSERVED` clears itself overnight — the un-backfilled #2144 migration
 * guarantees a population of them for one sync cycle, and the response is to
 * wait. `PROVIDER_CANNOT_OBSERVE` never clears. Toned apart so the difference
 * survives a scan of seven days of passes: warning is "come back tomorrow",
 * neutral is "there is nothing to come back for".
 */
const BASIS_VARIANT: Record<string, StatusBadgeVariant> = {
    NEVER_OBSERVED: 'warning',
    PROVIDER_CANNOT_OBSERVE: 'neutral',
    ON_PREM_MASTERED: 'warning',
};

/** Narrow the Json column without trusting it. */
function readResult(value: unknown): PassResult {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as PassResult)
        : {};
}

function readBasis(value: unknown): DecisionBasisJson | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const b = value as DecisionBasisJson;
    return typeof b.rule === 'string' ? b : null;
}

function readDecisions(result: PassResult): PassDecision[] {
    return Array.isArray(result.decisions)
        ? result.decisions.filter(
              (d): d is PassDecision =>
                  d !== null &&
                  typeof d === 'object' &&
                  typeof (d as PassDecision).linkId === 'string',
          )
        : [];
}

export function LeaverPassesClient() {
    const t = useTranslations('admin');
    const tenantHref = useTenantHref();
    const { data, error, isLoading } = useTenantSWR<{ passes: LeaverPassRow[] }>(
        '/admin/identity-leaver-passes',
    );
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const rows = useMemo(() => data?.passes ?? [], [data]);
    // Derived, not stored: a selection that no longer exists after a
    // revalidation falls back to the most recent pass rather than blanking the
    // detail panel, and the page is useful on first paint without a click.
    const selected = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
    const selectedResult = selected ? readResult(selected.resultJson) : {};
    const selectedDecisions = readDecisions(selectedResult);
    const selectedTruncated = selectedResult.decisionsTruncated === true;

    const passCols = createColumns<LeaverPassRow>([
        {
            accessorKey: 'provider',
            header: t('integrations.colProvider'),
            cell: ({ getValue }) => <StatusBadge variant="info">{String(getValue())}</StatusBadge>,
        },
        {
            id: 'status',
            accessorKey: 'status',
            header: t('integrations.colStatus'),
            cell: ({ row }) => {
                const meta = STATUS_META[row.original.status];
                return (
                    <StatusBadge variant={meta?.variant ?? 'neutral'}>
                        {meta ? t(`leaverPasses.${meta.key}`) : row.original.status}
                    </StatusBadge>
                );
            },
        },
        {
            id: 'refusal',
            header: t('leaverPasses.colRefusal'),
            cell: ({ row }) => {
                const refusal = readResult(row.original.resultJson).refusal;
                return refusal ? (
                    <span className="font-mono text-content-muted">{refusal}</span>
                ) : (
                    <span className="text-content-subtle">—</span>
                );
            },
        },
        {
            id: 'decisions',
            header: t('leaverPasses.colDecisions'),
            cell: ({ row }) => {
                const result = readResult(row.original.resultJson);
                const count = readDecisions(result).length;
                // The truncation marker rides the LIST row, not only the detail
                // panel: a short list that never says it is short is the failure
                // `decisionsTruncated` exists to prevent, and an operator
                // scanning seven days of passes must see it without clicking.
                return (
                    <span className="inline-flex items-center gap-tight">
                        <span className="tabular-nums">{count}</span>
                        {result.decisionsTruncated === true && (
                            <StatusBadge variant="warning" size="sm">
                                {t('leaverPasses.truncatedShort')}
                            </StatusBadge>
                        )}
                    </span>
                );
            },
        },
        {
            id: 'ran',
            accessorKey: 'executedAt',
            header: t('leaverPasses.colRan'),
            cell: ({ row }) => (
                <span className="text-content-muted tabular-nums">
                    {formatDateTime(row.original.completedAt ?? row.original.executedAt)}
                </span>
            ),
        },
    ]);

    const decisionCols = createColumns<PassDecision>([
        {
            accessorKey: 'linkId',
            header: t('leaverPasses.colLink'),
            cell: ({ getValue }) => <span className="font-mono">{String(getValue())}</span>,
        },
        {
            id: 'outcome',
            accessorKey: 'outcome',
            header: t('leaverPasses.colOutcome'),
            cell: ({ row }) => (
                <StatusBadge variant={OUTCOME_VARIANT[row.original.outcome] ?? 'neutral'}>
                    {row.original.outcome}
                </StatusBadge>
            ),
        },
        {
            id: 'basis',
            header: t('leaverPasses.colBasis'),
            cell: ({ row }) => {
                const basis = readBasis(row.original.basis);
                // An older row genuinely recorded no basis. Say so with the same
                // em-dash the other optional cells use, rather than inventing
                // one from the outcome — a guess here would be indistinguishable
                // on screen from a determination the pass actually made.
                if (!basis?.rule) return <span className="text-content-subtle">—</span>;
                const key = BASIS_LABEL[basis.rule];
                return (
                    <span className="inline-flex flex-wrap items-center gap-tight">
                        <StatusBadge variant={BASIS_VARIANT[basis.rule] ?? 'info'} size="sm">
                            {key ? t(`leaverPasses.${key}`) : basis.rule}
                        </StatusBadge>
                        {basis.observedAt && (
                            <span className="text-content-muted tabular-nums">
                                {t('leaverPasses.basisObserved', {
                                    when: formatDateTime(basis.observedAt),
                                })}
                            </span>
                        )}
                    </span>
                );
            },
        },
        {
            id: 'reason',
            accessorKey: 'reason',
            header: t('leaverPasses.colReason'),
            cell: ({ row }) => (
                <span className="text-content-muted">{row.original.reason ?? '—'}</span>
            ),
        },
    ]);

    const facts: { label: string; value: string }[] = selected
        ? [
              { label: t('leaverPasses.factMode'), value: selectedResult.mode ?? '—' },
              { label: t('leaverPasses.factEvidence'), value: selectedResult.evidence ?? '—' },
              {
                  label: t('leaverPasses.factTerminated'),
                  value: String(selectedResult.terminatedWorkers ?? 0),
              },
              {
                  label: t('leaverPasses.factCandidates'),
                  value: String(selectedResult.candidates ?? 0),
              },
              {
                  label: t('leaverPasses.factPopulation'),
                  value: String(selectedResult.population ?? 0),
              },
          ]
        : [];

    return (
        <div className="space-y-section">
            <BackAffordance />
            <PageBreadcrumbs
                items={[
                    { label: t('integrations.title'), href: tenantHref('/admin/integrations') },
                    { label: t('leaverPasses.breadcrumb') },
                ]}
            />
            <Heading level={1}>{t('leaverPasses.title')}</Heading>
            <p className="max-w-3xl text-sm text-content-muted">{t('leaverPasses.intro')}</p>

            <Card className="space-y-default p-6">
                <Heading level={2}>{t('leaverPasses.passesHeading')}</Heading>
                {error ? (
                    <InlineNotice variant="error">{t('leaverPasses.loadError')}</InlineNotice>
                ) : isLoading ? (
                    <p className="text-sm text-content-subtle">{t('integrations.fetching')}</p>
                ) : rows.length === 0 ? (
                    <EmptyState
                        variant="no-records"
                        size="sm"
                        title={t('leaverPasses.empty')}
                        description={t('leaverPasses.emptyDescription')}
                    />
                ) : (
                    <DataTable
                        data={rows}
                        columns={passCols}
                        getRowId={(r) => r.id}
                        selectionEnabled={false}
                        onRowClick={(row) => setSelectedId(row.original.id)}
                        emptyState={t('leaverPasses.empty')}
                        data-testid="leaver-passes-table"
                    />
                )}
            </Card>

            {selected && (
                <Card className="space-y-default p-6" id="leaver-pass-detail">
                    <Heading level={2}>
                        {t('leaverPasses.detailHeading', {
                            provider: selected.provider,
                            ran: formatDateTime(selected.completedAt ?? selected.executedAt),
                        })}
                    </Heading>

                    <dl className="flex flex-wrap gap-default">
                        {facts.map((f) => (
                            <div key={f.label} className="space-y-tight">
                                <dt className="text-xs uppercase tracking-wide text-content-subtle">
                                    {f.label}
                                </dt>
                                <dd className="text-sm tabular-nums text-content-emphasis">
                                    {f.value}
                                </dd>
                            </div>
                        ))}
                    </dl>

                    {selectedResult.refusal && (
                        // The `detail` sentence is authored by the pass itself and
                        // is the human meaning of the code beside it — rendered
                        // verbatim rather than re-worded here, so the page cannot
                        // drift from what the refusal actually says.
                        <InlineNotice variant="info" title={t('leaverPasses.refusalHeading')}>
                            <span className="font-mono text-xs">{selectedResult.refusal}</span>
                            {selectedResult.detail ? ` — ${selectedResult.detail}` : ''}
                        </InlineNotice>
                    )}

                    {selectedResult.batchRefused && (
                        <InlineNotice
                            variant="warning"
                            title={t('leaverPasses.batchRefusedHeading')}
                        >
                            {selectedResult.batchRefused}
                        </InlineNotice>
                    )}

                    {selectedTruncated && (
                        <InlineNotice variant="warning">
                            {t('leaverPasses.truncated', { shown: selectedDecisions.length })}
                        </InlineNotice>
                    )}

                    <Heading level={3}>{t('leaverPasses.decisionsHeading')}</Heading>
                    {selectedDecisions.length === 0 ? (
                        <p className="text-sm text-content-muted">{t('leaverPasses.noDecisions')}</p>
                    ) : (
                        <DataTable
                            data={selectedDecisions}
                            columns={decisionCols}
                            getRowId={(d) => d.linkId}
                            selectionEnabled={false}
                            emptyState={t('leaverPasses.noDecisions')}
                            data-testid="leaver-pass-decisions-table"
                        />
                    )}
                </Card>
            )}
        </div>
    );
}
