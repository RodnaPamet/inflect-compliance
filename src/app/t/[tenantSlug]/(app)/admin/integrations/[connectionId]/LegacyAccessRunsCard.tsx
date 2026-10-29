'use client';

/**
 * Reading a legacy application's accounts and matching them to people, on the
 * application's own connection page.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO ACTIONS, BOTH BACKGROUND JOBS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Read accounts" posts `{ connectionId }` to the pull route and "Match to
 * people" posts `{ snapshotId }` to the reconcile route. Both answer 202 with a
 * job id and nothing else, so this card says the run started and where its
 * result will appear. The result is the run's `IntegrationExecution` row, the
 * one the page's "Check runs" table already lists; the card reads the newest
 * row of each kind from the same rows and shows its status and its NAMED
 * reason. Refresh reloads them. Nothing polls.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NEVER A GENERIC "FAILED"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A refused run records PARTIAL with a reason code in `errorMessage`, and a run
 * that broke records ERROR with a message. A code this card knows gets its
 * sentence; every code is shown as well, so a code added later still reaches
 * the reader by name. An ERROR message is shown as written.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SNAPSHOT IS THE CAMPAIGN'S SNAPSHOT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The standing read returns the same snapshot campaign creation builds from, and
 * "Match to people" sends ITS id, so what this card calls matched is what a
 * campaign will find matched. Statistics only: counts, a status, a date.
 *
 * Both routes, the standing read and the connection list that says whether this
 * is a legacy connection take `admin.manage`. A viewer without it is shown no
 * card and sends no request, as the page's owner card is gated at its mount:
 * every request it could make would be refused, and each refusal writes an
 * AUTHZ_DENIED row for nothing more than a visit.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { formatDateTime } from '@inflect/ui/lib/format-date';
import type { LegacyAccessRefusalReason } from '@prisma/client';

import { usePermissions, useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';
import { apiErrorMessage } from '@/lib/api-error';
import { readPopulationCoverage } from '@/lib/legacy-access/coverage';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { AppIcon } from '@/components/icons/AppIcon';
import type { LegacySnapshotStanding } from '@/app-layer/usecases/legacy-access-standing';
import type { ReconcileRefusal } from '@/app-layer/usecases/legacy-reconcile';

import { useIsLegacyConnection } from './useIsLegacyConnection';

export const PULL_KEY = 'legacy-mcp.pull';
export const RECONCILE_KEY = 'legacy-mcp.reconcile';

/** One `IntegrationExecution` row, as the connection's executions route returns it. */
export interface LegacyExecutionRow {
    id: string;
    automationKey: string;
    status: string;
    errorMessage: string | null;
    executedAt: string;
    completedAt: string | null;
}

/**
 * Every pull refusal, keyed exhaustively on the stored enum, so a reason added
 * to the schema fails to compile here until somebody gives it a sentence in
 * both catalogues.
 */
const PULL_REASONS: Record<LegacyAccessRefusalReason, true> = {
    AUTHENTICATION_FAILED: true,
    SSRF_BLOCKED: true,
    TIMEOUT: true,
    CONTRACT_VIOLATION: true,
    CAP_EXCEEDED: true,
    TORN_SNAPSHOT: true,
    INCOMPLETE_READ: true,
    SCHEMA_DRIFT: true,
    AMBIGUOUS_COLUMN_CASE: true,
    MISSING_ACCOUNT_KEY: true,
    DUPLICATE_ACCOUNT_KEY: true,
    CONTRADICTORY_ROWS: true,
    SECRET_SHAPED_VALUE: true,
    ROW_SCHEMA_INVALID: true,
    MAPPING_MISSING: true,
    MAPPING_UNUSABLE: true,
    INTERNAL_ERROR: true,
    OVERSHARED_DENIED_COLUMN: true,
};

/** Every reconcile refusal, keyed exhaustively for the same reason. */
const MATCH_REASONS: Record<ReconcileRefusal, true> = {
    SNAPSHOT_NOT_FOUND: true,
    SNAPSHOT_NOT_COMPLETE: true,
    NO_FRESH_ROSTER: true,
    EMPTY_SNAPSHOT: true,
};

export const PULL_REASON_CODES = Object.keys(PULL_REASONS) as LegacyAccessRefusalReason[];
export const MATCH_REASON_CODES = Object.keys(MATCH_REASONS) as ReconcileRefusal[];

const RUN_STATUSES = ['RUNNING', 'PASSED', 'NOT_APPLICABLE', 'PARTIAL', 'ERROR'] as const;
type KnownRunStatus = (typeof RUN_STATUSES)[number];
const isKnownRunStatus = (s: string): s is KnownRunStatus =>
    (RUN_STATUSES as readonly string[]).includes(s);

const RUN_VARIANT: Record<KnownRunStatus, StatusBadgeVariant> = {
    RUNNING: 'info',
    PASSED: 'success',
    NOT_APPLICABLE: 'neutral',
    // Not an outage: the run reached a verdict and declined. Same tone the
    // page's Check runs table gives it.
    PARTIAL: 'warning',
    ERROR: 'error',
};

const SNAPSHOT_VARIANT: Record<LegacySnapshotStanding['status'], StatusBadgeVariant> = {
    COMPLETE: 'success',
    PARTIAL: 'warning',
    PENDING: 'info',
};

/** Newest row of one kind. `executedAt` is ISO, so it sorts as a string. */
function latestOf(rows: readonly LegacyExecutionRow[], key: string): LegacyExecutionRow | null {
    return rows
        .filter((r) => r.automationKey === key)
        .sort((a, b) => b.executedAt.localeCompare(a.executedAt))[0] ?? null;
}

type Notice = { variant: 'info' | 'error'; text: string };

export interface LegacyAccessRunsCardProps {
    connectionId: string;
    /** The connection's executions, as the page loaded them for Check runs. */
    runs: readonly LegacyExecutionRow[];
    runsLoading: boolean;
    runsError: boolean;
    /** Reloads the page's executions. Called by Refresh and after a start. */
    onReloadRuns: () => Promise<void> | void;
}

export function LegacyAccessRunsCard({
    connectionId,
    runs,
    runsLoading,
    runsError,
    onReloadRuns,
}: LegacyAccessRunsCardProps) {
    const t = useTranslations('admin.integrations.legacyRuns');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const canManage = usePermissions().admin.manage;
    // No list request without the key it takes (see the module docblock).
    const applies = useIsLegacyConnection(connectionId, canManage);
    // Shown only to a viewer holding admin.manage, on a connection known to be
    // a legacy one or one the list could not classify (`null`).
    const shown = canManage && applies !== undefined && applies !== false;

    const [standing, setStanding] = useState<LegacySnapshotStanding | null>(null);
    const [standingLoading, setStandingLoading] = useState(true);
    const [standingError, setStandingError] = useState<string | null>(null);
    const [starting, setStarting] = useState<'read' | 'match' | null>(null);
    const [notice, setNotice] = useState<Notice | null>(null);

    const loadStanding = useCallback(async () => {
        setStandingError(null);
        try {
            const res = await fetch(
                apiUrl(`/admin/legacy-access/snapshot?connectionId=${encodeURIComponent(connectionId)}`)
            );
            const body: unknown = await res.json().catch(() => null);
            if (!res.ok) throw new Error(apiErrorMessage(body, String(res.status)));
            setStanding((body as { snapshot?: LegacySnapshotStanding | null } | null)?.snapshot ?? null);
        } catch (e) {
            setStandingError(e instanceof Error ? e.message : String(e));
        } finally {
            setStandingLoading(false);
        }
    }, [apiUrl, connectionId]);

    useEffect(() => {
        if (!shown) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        void loadStanding();
    }, [shown, loadStanding]);

    const refresh = useCallback(async () => {
        await Promise.all([loadStanding(), onReloadRuns()]);
    }, [loadStanding, onReloadRuns]);

    // The snapshot "Match to people" sends: the one the standing read named,
    // which is the one a campaign will be built from.
    const snapshotId = standing?.id ?? null;

    const start = useCallback(
        async (kind: 'read' | 'match') => {
            setStarting(kind);
            setNotice(null);
            try {
                const res = await fetch(
                    apiUrl(kind === 'read' ? '/admin/legacy-access/pull' : '/admin/legacy-access/reconcile'),
                    {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(
                            kind === 'read' ? { connectionId } : { snapshotId }
                        ),
                    }
                );
                const body: unknown = await res.json().catch(() => null);
                if (!res.ok) throw new Error(apiErrorMessage(body, String(res.status)));
                const jobId = (body as { jobId?: string | null } | null)?.jobId ?? '—';
                setNotice({
                    variant: 'info',
                    text: t(kind === 'read' ? 'readStarted' : 'matchStarted', { jobId }),
                });
                await refresh();
            } catch (e) {
                setNotice({
                    variant: 'error',
                    text: t('startFailed', { reason: e instanceof Error ? e.message : String(e) }),
                });
            } finally {
                setStarting(null);
            }
        },
        [apiUrl, connectionId, snapshotId, t, refresh]
    );

    if (!shown) return null;

    const lastRead = latestOf(runs, PULL_KEY);
    const lastMatch = latestOf(runs, RECONCILE_KEY);

    // Why "Match to people" cannot be pressed, if it cannot. The server refuses
    // the same cases on its own; this saves somebody starting a run that is
    // certain to record a refusal, and says what to do instead.
    const matchBlockedBy: string | null = standingLoading || standingError !== null
        ? t('matchNeedsStanding')
        : !standing
            ? t('matchNeedsRead')
            : standing.status !== 'COMPLETE'
                ? t('matchNeedsComplete')
                : standing.rowCount === 0
                    ? t('matchNeedsAccounts')
                    : null;

    return (
        <Card className="space-y-default" id="legacy-access-runs">
            <Heading level={2}>{t('title')}</Heading>
            <p className="text-content-muted">{t('description')}</p>

            {notice ? <InlineNotice variant={notice.variant}>{notice.text}</InlineNotice> : null}

            <section className="space-y-compact" data-testid="legacy-snapshot-standing">
                <Heading level={3}>{t('standingTitle')}</Heading>
                {standingLoading ? (
                    <p className="text-sm text-content-subtle">{t('standingLoading')}</p>
                ) : standingError !== null ? (
                    <InlineNotice variant="error">
                        {t('standingLoadFailed', { reason: standingError })}
                    </InlineNotice>
                ) : !standing ? (
                    <p className="text-sm text-content-muted">{t('neverRead')}</p>
                ) : (
                    <SnapshotStanding
                        standing={standing}
                        queueHref={tenantHref(`/admin/integrations/${connectionId}/reconciliation`)}
                    />
                )}
            </section>

            <div className="grid gap-default md:grid-cols-2">
                <section className="space-y-compact" data-testid="legacy-read-action">
                    <Button
                        variant="secondary"
                        id="legacy-read-accounts-btn"
                        onClick={() => void start('read')}
                        loading={starting === 'read'}
                        disabled={starting !== null}
                    >
                        {t('readButton')}
                    </Button>
                    <RunLine
                        label={t('lastRead')}
                        run={lastRead}
                        loading={runsLoading}
                        error={runsError}
                        statusKey="pullRun"
                        reasonKey="pullReason"
                        knownReasons={PULL_REASON_CODES}
                    />
                </section>
                <section className="space-y-compact" data-testid="legacy-match-action">
                    <Button
                        variant="secondary"
                        id="legacy-match-people-btn"
                        onClick={() => void start('match')}
                        loading={starting === 'match'}
                        disabled={starting !== null}
                        disabledTooltip={matchBlockedBy ?? undefined}
                    >
                        {t('matchButton')}
                    </Button>
                    {matchBlockedBy && !standingLoading ? (
                        <p className="text-sm text-content-muted" data-testid="legacy-match-blocked">
                            {matchBlockedBy}
                        </p>
                    ) : null}
                    <RunLine
                        label={t('lastMatch')}
                        run={lastMatch}
                        loading={runsLoading}
                        error={runsError}
                        statusKey="matchRun"
                        reasonKey="matchReason"
                        knownReasons={MATCH_REASON_CODES}
                        note={
                            lastMatch?.status === 'PASSED'
                            && standing
                            && standing.reconciliation?.executionId !== lastMatch.id
                                ? t('matchedEarlierRead')
                                : null
                        }
                    />
                </section>
            </div>

            <Button
                variant="ghost"
                icon={<AppIcon name="refresh" size={16} />}
                onClick={() => void refresh()}
                disabled={starting !== null}
                id="legacy-runs-refresh-btn"
            >
                {t('refresh')}
            </Button>
        </Card>
    );
}

function SnapshotStanding({
    standing,
    queueHref,
}: {
    standing: LegacySnapshotStanding;
    queueHref: string;
}) {
    const t = useTranslations('admin.integrations.legacyRuns');
    const coverage = readPopulationCoverage(standing.populationCoverage);
    const rec = standing.reconciliation;
    const count = (outcome: string) => rec?.byOutcome[outcome] ?? 0;

    return (
        <div className="space-y-compact text-sm">
            <div className="flex flex-wrap items-center gap-tight">
                <StatusBadge variant={SNAPSHOT_VARIANT[standing.status] ?? 'neutral'}>
                    {t(`snapshot${standing.status}`)}
                </StatusBadge>
                <span className="text-content-muted">
                    {t('readAt', { date: formatDateTime(standing.completedAt ?? standing.pulledAt) })}
                </span>
                <span className="tabular-nums">{t('accounts', { count: standing.rowCount })}</span>
                <StatusBadge variant={coverage === 'VERIFIED' ? 'success' : 'neutral'}>
                    {t(`coverage${coverage}`)}
                </StatusBadge>
            </div>
            {coverage === 'UNKNOWN' ? (
                <p className="text-content-muted">{t('coverageUNKNOWNHelp')}</p>
            ) : null}
            {standing.status === 'PARTIAL' ? (
                <ReasonText
                    code={standing.refusalReason}
                    detail={standing.refusalDetail}
                    reasonKey="pullReason"
                    knownReasons={PULL_REASON_CODES}
                />
            ) : null}
            {standing.status === 'PARTIAL' && standing.rowsReceived > 0 ? (
                <p className="text-content-muted">{t('rowsReceived', { count: standing.rowsReceived })}</p>
            ) : null}
            {rec ? (
                <div className="space-y-compact" data-testid="legacy-snapshot-matched">
                    <p>
                        {t('matchedAt', { date: formatDateTime(rec.completedAt) })}
                        {' · '}
                        <span className="tabular-nums">
                            {t('matchCounts', {
                                resolved: rec.resolved,
                                linked: count('LINKED'),
                                suggested: count('SUGGESTED'),
                                ambiguous: count('AMBIGUOUS'),
                                unmatched: count('UNMATCHED'),
                                nonPerson: count('NON_PERSON'),
                            })}
                        </span>
                    </p>
                    <a className="text-content-info underline underline-offset-2" href={queueHref}>
                        {t('openQueue')}
                    </a>
                </div>
            ) : (
                <p className="text-content-muted">{t('notMatched')}</p>
            )}
        </div>
    );
}

function RunLine({
    label,
    run,
    loading,
    error,
    statusKey,
    reasonKey,
    knownReasons,
    note = null,
}: {
    label: string;
    run: LegacyExecutionRow | null;
    loading: boolean;
    error: boolean;
    statusKey: 'pullRun' | 'matchRun';
    reasonKey: 'pullReason' | 'matchReason';
    knownReasons: readonly string[];
    note?: string | null;
}) {
    const t = useTranslations('admin.integrations.legacyRuns');

    let body: ReactNode;
    if (loading) {
        body = <span className="text-content-subtle">{t('runsLoading')}</span>;
    } else if (error) {
        body = <span className="text-content-error">{t('runsLoadFailed')}</span>;
    } else if (!run) {
        body = <span className="text-content-muted">{t('notRunYet')}</span>;
    } else {
        const known = isKnownRunStatus(run.status);
        body = (
            <div className="space-y-compact">
                <div className="flex flex-wrap items-center gap-tight">
                    <StatusBadge variant={known ? RUN_VARIANT[run.status as KnownRunStatus] : 'neutral'}>
                        {known ? t(`${statusKey}.${run.status}`) : run.status}
                    </StatusBadge>
                    <span className="text-content-muted">
                        {formatDateTime(run.completedAt ?? run.executedAt)}
                    </span>
                </div>
                {run.status === 'PARTIAL' ? (
                    <ReasonText
                        code={run.errorMessage}
                        detail={null}
                        reasonKey={reasonKey}
                        knownReasons={knownReasons}
                    />
                ) : run.status === 'ERROR' && run.errorMessage ? (
                    <p className="text-content-muted">{run.errorMessage}</p>
                ) : run.status === 'NOT_APPLICABLE' && statusKey === 'pullRun' ? (
                    <p className="text-content-muted">{t('pullNoAccounts')}</p>
                ) : null}
                {note ? <p className="text-content-muted">{note}</p> : null}
            </div>
        );
    }

    return (
        <div className="space-y-compact text-sm">
            <p className="font-medium">{label}</p>
            {body}
        </div>
    );
}

/**
 * A refusal, by name. The sentence when the code is one this build knows, and
 * the code itself in every case, so nothing is reduced to "failed".
 */
function ReasonText({
    code,
    detail,
    reasonKey,
    knownReasons,
}: {
    code: string | null;
    detail: string | null;
    reasonKey: 'pullReason' | 'matchReason';
    knownReasons: readonly string[];
}) {
    const t = useTranslations('admin.integrations.legacyRuns');
    if (!code) return <p className="text-content-muted">{t('reasonNotRecorded')}</p>;
    return (
        <div className="space-y-compact">
            <p>
                {knownReasons.includes(code) ? `${t(`${reasonKey}.${code}`)} ` : null}
                <code className="font-mono text-content-muted">{code}</code>
            </p>
            {detail ? <p className="text-content-muted">{detail}</p> : null}
        </div>
    );
}
