'use client';

/**
 * The read surface for the leaver pass record.
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
// The ORDERING, from the module that owns it — never a copy, and never `!==`.
// `write-ladder` carries no server imports, so a client component can hold it.
import { LADDER, isAboveClamp, type IdentityWriteMode } from '@/lib/identity/write-ladder';

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
    OBSERVATION_STALE: 'basisObservationStale',
    PROVIDER_CANNOT_OBSERVE: 'basisProviderCannotObserve',
    UNSUPPORTED_DIRECTORY: 'basisUnsupportedDirectory',
};

/**
 * Narrow the Json column without trusting it — and derive the one refusal code
 * the server did not always record.
 *
 * Rows written before a batch refusal was recorded as a refusal carry only the
 * breaker's SENTENCE in `batchRefused`, with no `refusal` key. Deriving it here
 * rather than in the cell keeps the two surfaces that read this row agreeing:
 * the list column and the detail notice would otherwise describe the same row
 * differently.
 *
 * Deliberately does NOT touch the status badge. A legacy row reading
 * "Ran — complete" beside BATCH_REFUSED is correct and is the point — the
 * renderer must not overrule a stored audit record, and the mismatch is the
 * visible trace of when the defect was fixed.
 */
function readResult(value: unknown): PassResult {
    const raw =
        value !== null && typeof value === 'object' && !Array.isArray(value)
            ? (value as PassResult)
            : {};
    return raw.refusal || !raw.batchRefused ? raw : { ...raw, refusal: 'BATCH_REFUSED' };
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

/**
 * What the write-policy route returns, as much of it as this page reads.
 *
 * Every field optional on purpose — same posture as `PassResult`. A sibling
 * endpoint's shape is something we consume, not something we can hold still,
 * and this page must degrade rather than blank if it changes.
 */
interface LadderSummary {
    directions?: { leaver?: { mode?: IdentityWriteMode; dryRunSince?: string | null } };
    honoured?: { leaver?: { maxMode?: IdentityWriteMode } };
}

/** Most recent 05:00 UTC at or before `now` — the leaver dispatch cron. */
function lastDueAt(now: Date): Date {
    const due = new Date(now);
    due.setUTCHours(5, 0, 0, 0);
    if (due > now) due.setUTCDate(due.getUTCDate() - 1);
    return due;
}

export function LeaverPassesClient() {
    const t = useTranslations('admin');
    const tenantHref = useTenantHref();
    const { data, error, isLoading } = useTenantSWR<{ passes: LeaverPassRow[] }>(
        '/admin/identity-leaver-passes',
    );
    // The report must NEVER gate on this call — `error` and `isLoading` are
    // deliberately dropped. A sibling endpoint returning 500 must not blank a
    // page whose own data loaded fine; the empty state simply falls back to the
    // copy that names no cause.
    const { data: ladder } = useTenantSWR<LadderSummary>('/admin/identity-write-policy');
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const mode = ladder?.directions?.leaver?.mode;
    const clamp = ladder?.honoured?.leaver?.maxMode;
    const dryRunSince = ladder?.directions?.leaver?.dryRunSince;
    // Mirrors the PASS's own gate, which is ORDINAL (`isAboveClamp`) — the same
    // function the pass calls, not a second encoding of it. It was `mode !== clamp`,
    // which agrees with the pass only while the clamp is the second rung: once the
    // clamp moved to AUTOMATIC (#2187) a DRY_RUN tenant — every tenant in the
    // observation window — was declared mismatched and told to WIDEN two rungs to
    // unattended directory writes.
    //
    // The fault arm is a SEPARATE and narrower story than the sentence above
    // originally claimed, and the correction matters because it is still
    // partly true. `overdue` derives from `dryRunSince`, and
    // `setIdentityWriteMode` nulls that on EVERY move out of DRY_RUN
    // (`identity-write-policy.ts`, `const since = next === 'DRY_RUN' ? now : null`).
    // So the arm is reachable only at DRY_RUN — not "for everybody under the
    // top rung", and not at the top rung either, where `dryRunSince` is
    // equally null. Fixing the comparison restores it for the observation
    // window, which is where the live tenant sits and where #2175 would have
    // been caught. It does NOT restore it for PROPOSE or AUTOMATIC — the rungs
    // that actually hold disable authority — because those have no stored
    // start point to be overdue against.
    //
    // The real fix is to derive due-ness from the newest pass's `executedAt`
    // rather than from `dryRunSince`, which needs a signal this component does
    // not have in the empty case. Left deliberately: a comment that overstates
    // the repair is the same defect class as the one being repaired.
    //
    // Both sides must be RUNGS THIS BUILD KNOWS before anything is ordered against
    // them: `isAboveClamp` sorts an unrecognised value to -1 and so reads it as
    // "below", which would have the page pick an arm confidently from a comparison
    // it cannot actually make. An unknown rung is unknown — the degradation arm
    // says so.
    const orderable =
        mode !== undefined &&
        clamp !== undefined &&
        LADDER.includes(mode) &&
        LADDER.includes(clamp);
    const clampMismatch = orderable && mode !== 'DISABLED' && isAboveClamp(mode, clamp);
    // A tenant that switched on at 05:01 has not missed anything yet. Without
    // this the fault copy fires for up to 23h59m on the one day someone is
    // actually watching.
    const overdue = !!dryRunSince && new Date(dryRunSince) < lastDueAt(new Date());

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
            // TEXT, NOT A BADGE, and that is a decision rather than an omission.
            // The outcome beside it is this row's ONE loud signal; a second pill
            // next to it reads as a competing alarm and neither wins the eye.
            // The basis is a qualifier ON that verdict — "would disable, BECAUSE
            // the directory answered" — so it belongs in the row's quiet
            // register. The labels carry the whole distinction on their own:
            // "awaiting the next sync" and "reports no on-premises state" are
            // not two shades of one word.
            cell: ({ row }) => {
                const basis = readBasis(row.original.basis);
                // An older row genuinely recorded no basis. Say so with the same
                // em-dash the other optional cells use, rather than inventing
                // one from the outcome — a guess here would be indistinguishable
                // on screen from a determination the pass actually made.
                if (!basis?.rule) return <span className="text-content-subtle">—</span>;
                const key = BASIS_LABEL[basis.rule];
                return (
                    <span className="inline-flex flex-wrap items-center gap-tight text-content-muted">
                        {/* Its own element, not concatenated with the date: the
                            rule is the fact a reader scans for, and a label
                            fused to a timestamp is neither scannable nor
                            addressable by a test. */}
                        <span>{key ? t(`leaverPasses.${key}`) : basis.rule}</span>
                        {basis.observedAt && (
                            <span className="tabular-nums">
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
            {mode && (
                <p id="leaver-pass-mode" className="max-w-3xl text-sm text-content-muted">
                    {t('leaverPasses.currentMode', {
                        mode: t(`writeLadder.mode.${mode}`),
                        clamp: clamp ? t(`writeLadder.mode.${clamp}`) : '—',
                    })}
                </p>
            )}

            <Card className="space-y-default p-6">
                <Heading level={2}>{t('leaverPasses.passesHeading')}</Heading>
                {error ? (
                    <InlineNotice variant="error">{t('leaverPasses.loadError')}</InlineNotice>
                ) : isLoading ? (
                    <p className="text-sm text-content-subtle">{t('integrations.fetching')}</p>
                ) : rows.length === 0 ? (
                    // FIVE ARMS, because an empty page had one sentence and at
                    // least three causes — nobody switched it on, it is set
                    // above the clamp so every pass refuses without recording,
                    // or the worker is dead. Those want completely different
                    // responses and looked identical.
                    //
                    // Compared against `clamp`, never a hardcoded 'DRY_RUN':
                    // after a clamp raise a PROPOSE tenant whose passes DO run
                    // would match no arm and fall back to the very sentence this
                    // exists to replace.
                    (() => {
                        const ladderLink = {
                            label: t('writeLadder.linkLabel'),
                            href: tenantHref('/admin/identity-write-policy'),
                        };
                        if (mode === 'DISABLED') {
                            return (
                                <EmptyState
                                    variant="no-records"
                                    size="sm"
                                    title={t('leaverPasses.emptyDisabled')}
                                    description={t('leaverPasses.emptyDisabledDescription')}
                                    secondaryAction={ladderLink}
                                />
                            );
                        }
                        if (clampMismatch) {
                            return (
                                <EmptyState
                                    variant="missing-prereqs"
                                    size="sm"
                                    title={t('leaverPasses.emptyClampMismatch')}
                                    description={t('leaverPasses.emptyClampMismatchDescription', {
                                        mode: t(`writeLadder.mode.${mode}`),
                                        clamp: clamp ? t(`writeLadder.mode.${clamp}`) : '—',
                                    })}
                                    secondaryAction={ladderLink}
                                />
                            );
                        }
                        if (orderable && overdue) {
                            // The only arm that says something is WRONG. A pass
                            // was due and would have recorded a row even if it
                            // refused, so silence here is not a configuration
                            // fact.
                            //
                            // Reached on AT-OR-BELOW the clamp, not on equality:
                            // the two arms above have already taken DISABLED and
                            // above-the-clamp, so anything still here is a tenant
                            // whose passes DO run. Under `mode === clamp` this
                            // alarm — the one that would have caught a dispatcher
                            // enqueueing nothing for months (#2175) — was silent
                            // for every tenant below the clamp.
                            return (
                                <EmptyState
                                    variant="missing-prereqs"
                                    size="sm"
                                    title={t('leaverPasses.emptyOverdue')}
                                    description={t('leaverPasses.emptyOverdueDescription')}
                                    secondaryAction={ladderLink}
                                />
                            );
                        }
                        if (orderable) {
                            // At or below the clamp and not yet due: the passes
                            // will run, there just has not been one.
                            return (
                                <EmptyState
                                    variant="no-records"
                                    size="sm"
                                    title={t('leaverPasses.emptyAwaitingFirstPass')}
                                    description={t('leaverPasses.emptyAwaitingFirstPassDescription')}
                                />
                            );
                        }
                        // Degradation arm: the ladder call failed or has not
                        // resolved. Today's copy, which names no cause — correct
                        // when we do not know one.
                        return (
                            <EmptyState
                                variant="no-records"
                                size="sm"
                                title={t('leaverPasses.empty')}
                                description={t('leaverPasses.emptyDescription')}
                            />
                        );
                    })()
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
