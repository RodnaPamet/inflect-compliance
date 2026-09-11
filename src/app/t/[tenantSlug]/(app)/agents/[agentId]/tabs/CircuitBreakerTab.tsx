'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { ChartActivity2 } from '@/components/ui/icons/nucleo';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Modal } from '@/components/ui/modal';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Heading } from '@/components/ui/typography';
import { ApiClientError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/api-error';
import { formatDateTime } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { KillSwitchTimeline } from './KillSwitchTimeline';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import type { CircuitBreakerTabProps } from './types';

/**
 * The behavioural circuit breaker, on the agent it stops (OWASP ASI08).
 *
 * ## `breaker: null` IS NOT `CLOSED`, and that is the whole reason this panel
 * ## does not begin with a badge and a colour
 *
 * The row is created the first time the agent is judged, so a null means NOTHING
 * HAS EVER WATCHED THIS AGENT. Rendering that as CLOSED would be the
 * reassurance-shaped failure the subsystem is arranged against: an operator
 * reading a green badge concludes a containment control is live when no
 * observation exists behind it. `posture()` below therefore resolves SIX
 * states, not two, and only one of them is green.
 *
 * The same honesty applies one rung in: a breaker row whose baseline is short
 * is CLOSED and judging nothing. `NO_BASELINE` is a verdict — the detector
 * refusing to look — and the panel says so rather than reporting the refusal as
 * an all-clear. That is what the `baseline` block on the payload is for, and
 * why it is rendered whatever the state.
 *
 * And one rung in from THAT: a breaker an administrator has just closed is
 * CLOSED, un-streaked, and still carrying `lastVerdict: 'TRIP'`, because
 * `closeAgentCircuitBreaker` deliberately does not rewrite the verdict fields.
 * Nothing has re-judged the agent — the detector runs on its next active window
 * — so `closedAfterTrip` exists to stop the close this very panel performs from
 * flipping the badge green a second later while the fact row below it still
 * reads "Last verdict: Tripped".
 *
 * ## Nothing here recovers on its own
 *
 * There is no half-open probe, no timeout and no auto-close anywhere in the
 * implementation — an agent that has gone rogue could simply wait one out. So
 * the copy never says "until", "retries" or "temporarily": an open breaker
 * stays open until a named human closes it, and every sentence on this surface
 * has to leave an operator with that expectation.
 *
 * ## The two close reasons are not two spellings of "OK"
 *
 * `ACCEPTED_NEW_BASELINE` advances the epoch and DISCARDS the agent's history;
 * `RESOLVED` keeps it. Offering them as two enum-labelled radios would put a
 * one-click, unrecoverable history wipe next to an ordinary restore, so each
 * carries the consequence in its own words, neither is pre-selected, and the
 * discarding one additionally warns with the count it is about to drop.
 *
 * ## The window history is a LIST, not the DataTable primitive
 *
 * It is a bounded telemetry strip inside a detail tab — at most `WINDOW_PAGE`
 * (48) rows, never paged, never filtered, never sorted. DataTable is the
 * list-PAGE primitive, and three separate guards (filter-toolbar /
 * columns-dropdown / list-page-shell coverage) each read a mounted one as a
 * promise of a toolbar, a column gear and a viewport-clamped shell — none of
 * which belongs on a tab. Hand-rolling the raw HTML table element is the other
 * obvious answer and is also wrong: `epic52-datatable-ratchet` caps raw table
 * markup in tenant app pages at the LIVE count, with no headroom, so adding
 * one turns the suite red for every lane. A `<ul>` of rows on the semantic
 * tokens is what is left, and it is the honest shape anyway — this is evidence
 * to read down, not records to operate on.
 *
 * A warning for whoever next edits these comments: all four of those guards
 * match raw FILE TEXT and strip no comments, so writing either primitive's name
 * with its opening angle bracket in prose re-trips them from a docstring.
 */

/** `Date` columns arrive as ISO strings over JSON. */
interface BreakerRow {
    state: string;
    lastVerdict: string | null;
    lastVerdictAt: string | null;
    /** `YYYY-MM-DDTHH`, the detector's own bucket key — never a formatted date. */
    lastEvaluatedWindow: string | null;
    anomalousStreak: number;
    streakSignals: string[];
    trippedAt: string | null;
    trippedWindow: string | null;
    trippedSignals: string[];
    baselineEpoch: string;
    closedAt: string | null;
    closedByUserId: string | null;
    closeReason: string | null;
}

interface WindowRow {
    windowStart: string;
    readCalls: number;
    proposeCalls: number;
    orchestrateCalls: number;
    toolNames: string[];
    anomalous: boolean;
    verdict: string | null;
}

interface BaselineBlock {
    windows: number;
    observations: number;
    requiredWindows: number;
    requiredObservations: number;
    lookbackWindows: number;
}

interface BreakerPayload {
    agentId: string;
    agentName: string;
    riskTier: string | null;
    /** NULL means never observed. See the header — it is not `CLOSED`. */
    breaker: BreakerRow | null;
    windows: WindowRow[];
    /**
     * The hour still filling, from the server's clock. The newest ledger row
     * may be it, and that row is NOT in the baseline figures — see
     * `countedStanding`. Read from the payload rather than computed here: a
     * client clock that disagreed with the server's by a second would label the
     * wrong row.
     */
    currentWindowStart: string;
    /**
     * The complete window awaiting a verdict, which is the SUBJECT of the next
     * judgement and so is not part of the baseline it will be judged against.
     * `null` once this hour's verdict has landed — the row has joined the
     * baseline by then and the server says so rather than making this client
     * re-derive it from a latch pointer.
     */
    pendingVerdictWindowStart: string | null;
    baseline: BaselineBlock;
    windowsToTrip: number;
    /** The vocabulary, from the server that owns it. Never re-typed here. */
    closeReasons: string[];
}

/**
 * What an operator is actually looking at, which the stored `state` alone
 * cannot say. `learning`, `closedAfterTrip` and `watching` are ALL CLOSED and
 * mean three different things about whether anything is being judged.
 */
type Posture =
    | 'unobserved'
    | 'open'
    | 'armed'
    | 'closedAfterTrip'
    | 'learning'
    | 'watching';

function posture(breaker: BreakerRow | null): Posture {
    if (!breaker) return 'unobserved';
    if (breaker.state === 'OPEN') return 'open';
    if (breaker.anomalousStreak > 0) return 'armed';
    // CLOSED + `lastVerdict: 'TRIP'` has exactly one cause. `applyVerdict`
    // writes that verdict only in the branch that also latches the row OPEN
    // (circuit-breaker-store.ts), and `closeAgentCircuitBreaker` clears the
    // streak while leaving the verdict fields alone — so this is a breaker a
    // human closed, with no verdict since. Green here would be the panel
    // congratulating the operator on the click they just made.
    if (breaker.lastVerdict === 'TRIP') return 'closedAfterTrip';
    // The DETECTOR's own answer about whether it has a baseline, not this
    // panel's arithmetic. The count now covers the detector's whole look-back,
    // but judgement is LAZY — it happens on the agent's next active window, not
    // on a schedule — so an agent can have accumulated a sufficient history
    // hours before anything re-reads it. Deriving the split from the count
    // would announce a verdict the detector has not reached.
    if (breaker.lastVerdict === null || breaker.lastVerdict === 'NO_BASELINE') {
        return 'learning';
    }
    return 'watching';
}

/**
 * Only `watching` is green.
 *
 * The rule the four non-green tones follow: `warning` means NOTHING IS BEING
 * JUDGED RIGHT NOW and somebody has to account for that — no record at all, a
 * streak part-way to a trip, or a trip closed by hand with no verdict since.
 * `info` is the one benign not-judging state: a new agent still accumulating
 * history, which needs no decision from anybody.
 */
const POSTURE_TONE: Record<Posture, StatusBadgeVariant> = {
    unobserved: 'warning',
    open: 'error',
    armed: 'warning',
    closedAfterTrip: 'warning',
    learning: 'info',
    watching: 'success',
};

const POSTURE_NOTICE: Record<Posture, 'error' | 'warning' | 'info' | 'success'> = {
    unobserved: 'warning',
    open: 'error',
    armed: 'warning',
    closedAfterTrip: 'warning',
    learning: 'info',
    watching: 'success',
};

export function CircuitBreakerTab({
    agentId,
    refreshToken,
    onChanged,
    canCloseBreaker,
}: CircuitBreakerTabProps) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();

    const { data, error, isLoading, mutate } = useTenantSWR<BreakerPayload>(
        `/admin/agents/${agentId}/circuit-breaker`,
    );

    // The refreshToken -> SWR bridge.
    useEffect(() => {
        void mutate();
    }, [refreshToken, mutate]);

    const [closing, setClosing] = useState(false);
    // Deliberately un-defaulted. The first entry in the server's vocabulary is
    // the one that discards history, so a pre-selected radio would make an
    // unrecoverable choice reachable by a single click on the confirm button.
    const [reason, setReason] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);

    const breaker = data?.breaker ?? null;
    const baseline = data?.baseline;
    /**
     * Whether the baseline clears both thresholds. These are now the detector's
     * own figures — its look-back, its exclusions — so this is what it will
     * find when it next judges, not a floor under it. It still drives only the
     * Observability card's summary sentence: `posture()` reads the stored
     * verdict instead, because judgement is lazy and this arithmetic runs on
     * every render.
     */
    const baselineClearsThresholds =
        baseline !== undefined &&
        baseline.windows >= baseline.requiredWindows &&
        baseline.observations >= baseline.requiredObservations;
    const state = posture(breaker);

    const verdictLabel = useCallback(
        (code: string | null): string => {
            switch (code) {
                case 'STEADY':
                    return t('agentDetail.breaker.verdictSteady');
                case 'ARMED':
                    return t('agentDetail.breaker.verdictArmed');
                case 'TRIP':
                    return t('agentDetail.breaker.verdictTrip');
                case 'NO_BASELINE':
                    return t('agentDetail.breaker.verdictNoBaseline');
                case null:
                    return t('agentDetail.breaker.verdictPending');
                // A code this build has no label for is shown verbatim rather
                // than swallowed: the detector's vocabulary can grow, and a
                // silent fallback would report a new verdict as an old one.
                default:
                    return code;
            }
        },
        [t],
    );

    const signalLabel = useCallback(
        (code: string): string => {
            switch (code) {
                case 'PROPOSAL_RATE':
                    return t('agentDetail.breaker.signalProposalRate');
                case 'REJECTION_RATE':
                    return t('agentDetail.breaker.signalRejectionRate');
                case 'TOOL_MIX':
                    return t('agentDetail.breaker.signalToolMix');
                default:
                    return code;
            }
        },
        [t],
    );

    /** Read by `countedKey` for the pre-epoch split in the window list. */
    const baselineEpoch = breaker?.baselineEpoch ?? null;

    const openCloseDialog = useCallback(() => {
        setReason(null);
        setFailure(null);
        setClosing(true);
    }, []);

    const dismissDialog = useCallback(() => {
        if (busy) return;
        setClosing(false);
        setReason(null);
        setFailure(null);
    }, [busy]);

    const submitClose = useCallback(async () => {
        if (!reason) return;
        setBusy(true);
        setFailure(null);
        try {
            const res = await fetch(apiUrl(`/admin/agents/${agentId}/circuit-breaker`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason }),
            });
            if (!res.ok) {
                // Parsed once. `body.error` is an OBJECT, and putting one into
                // React state renders it as a child and throws into the page
                // error boundary — on the path nobody exercises.
                const body = await res.json().catch(() => null);
                // 404 and 400 are deliberately NOT idempotent successes: "there
                // is nothing to close" and "somebody else already closed it" are
                // different facts from "you closed it", and neither may put a
                // name and a reason into the audit trail. Both revalidate, so
                // the panel below the message is the current truth.
                if (res.status === 404) {
                    setFailure(t('agentDetail.breaker.closeErrorMissing'));
                    await mutate();
                    return;
                }
                // 400 is TWO different facts wearing one status. `badRequest`
                // from the usecase ("this breaker is not open") arrives as
                // BAD_REQUEST; a body the `.strict()` schema rejects arrives as
                // VALIDATION_ERROR. The not-open copy asserts something about
                // the AUDIT TRAIL — that nothing was recorded against your name
                // — so it may only be shown when the server actually said that.
                // The reachable path to the other one is this panel's own
                // policy of offering unrecognised `closeReasons` codes.
                if (res.status === 400 && errorCode(body) === 'BAD_REQUEST') {
                    setFailure(t('agentDetail.breaker.closeErrorNotOpen'));
                    await mutate();
                    return;
                }
                if (res.status === 403) {
                    // The route's message is deliberately uninformative and
                    // never names the key, so it is not what an operator reads.
                    setFailure(t('agentDetail.breaker.closeErrorForbidden'));
                    return;
                }
                setFailure(apiErrorMessage(body, t('agentDetail.breaker.closeErrorGeneric')));
                return;
            }
            await mutate();
            onChanged?.();
            setClosing(false);
            setReason(null);
            toast.success(t('agentDetail.breaker.closedToast'));
        } catch {
            setFailure(t('agentDetail.breaker.closeErrorGeneric'));
        } finally {
            setBusy(false);
        }
    }, [apiUrl, agentId, reason, mutate, onChanged, toast, t]);

    if (error) {
        const status = error instanceof ApiClientError ? error.status : 0;
        return (
            <ErrorState
                title={
                    status === 403
                        ? t('agentDetail.breaker.loadForbiddenTitle')
                        : status === 404
                          ? t('agentDetail.breaker.loadMissingTitle')
                          : t('agentDetail.breaker.loadErrorTitle')
                }
                description={
                    status === 403
                        ? t('agentDetail.breaker.loadForbiddenBody')
                        : status === 404
                          ? t('agentDetail.breaker.loadMissingBody')
                          : t('agentDetail.breaker.loadErrorBody')
                }
                onRetry={status === 403 ? undefined : () => void mutate()}
                retryLabel={t('agentDetail.breaker.retry')}
                data-testid="agent-breaker-error"
            />
        );
    }

    if (isLoading && !data) {
        return <SkeletonCard lines={6} />;
    }

    if (!data || !baseline) {
        return (
            <InlineEmptyState
                icon={ChartActivity2}
                title={t('agentDetail.breaker.noBreakerData')}
                description={t('agentDetail.breaker.noBreakerDataDescription')}
            />
        );
    }

    const rebaselines = reason === 'ACCEPTED_NEW_BASELINE';

    return (
        <div className="space-y-section" id="agent-circuit-breaker">
            <Card density="compact" className="space-y-default">
                <div className="flex flex-wrap items-center gap-default">
                    <Heading level={2}>{t('agentDetail.breaker.stateHeading')}</Heading>
                    <StatusBadge variant={POSTURE_TONE[state]}>
                        {t(`agentDetail.breaker.badge.${state}`)}
                    </StatusBadge>
                </div>

                <InlineNotice
                    variant={POSTURE_NOTICE[state]}
                    title={t(`agentDetail.breaker.postureTitle.${state}`)}
                >
                    {t(`agentDetail.breaker.postureBody.${state}`, {
                        windows: baseline.requiredWindows,
                        observations: baseline.requiredObservations,
                        required: data.windowsToTrip,
                    })}
                </InlineNotice>

                {breaker && (
                    <dl className="flex flex-wrap gap-default">
                        <Fact
                            label={t('agentDetail.breaker.factLastVerdict')}
                            value={verdictLabel(breaker.lastVerdict)}
                        />
                        <Fact
                            label={t('agentDetail.breaker.factLastVerdictAt')}
                            value={formatDateTime(
                                breaker.lastVerdictAt,
                                t('agentDetail.breaker.never'),
                            )}
                        />
                        <Fact
                            label={t('agentDetail.breaker.factLastWindow')}
                            value={
                                breaker.lastEvaluatedWindow ?? t('agentDetail.breaker.never')
                            }
                            mono
                        />
                        <Fact
                            label={t('agentDetail.breaker.factStreak')}
                            value={t('agentDetail.breaker.streakCount', {
                                streak: breaker.anomalousStreak,
                                required: data.windowsToTrip,
                            })}
                        />
                        <Fact
                            label={t('agentDetail.breaker.factBaselineEpoch')}
                            value={formatDateTime(breaker.baselineEpoch)}
                        />
                        {breaker.closedAt !== null && (
                            <Fact
                                label={t('agentDetail.breaker.factClosedAt')}
                                value={formatDateTime(breaker.closedAt)}
                            />
                        )}
                        {breaker.closeReason !== null && (
                            <Fact
                                label={t('agentDetail.breaker.factCloseReason')}
                                value={closeReasonLabel(breaker.closeReason, t)}
                            />
                        )}
                        {breaker.closedByUserId !== null && (
                            // The raw id, because that is what the record holds
                            // and a blank would read as "nobody closed it".
                            <Fact
                                label={t('agentDetail.breaker.factClosedBy')}
                                value={breaker.closedByUserId}
                                mono
                            />
                        )}
                    </dl>
                )}

                {breaker && breaker.anomalousStreak > 0 && (
                    <div className="space-y-tight">
                        <p className="text-sm text-content-default">
                            {t('agentDetail.breaker.streakExplain', {
                                required: data.windowsToTrip,
                            })}
                        </p>
                        {breaker.streakSignals.length > 0 && (
                            <div className="flex flex-wrap items-center gap-tight">
                                <span className="text-xs uppercase tracking-wide text-content-subtle">
                                    {t('agentDetail.breaker.streakSignalsLabel')}
                                </span>
                                {breaker.streakSignals.map((s) => (
                                    <StatusBadge key={s} variant="warning" size="sm">
                                        {signalLabel(s)}
                                    </StatusBadge>
                                ))}
                            </div>
                        )}
                    </div>
                )}

                {breaker && breaker.state === 'OPEN' && (
                    <div className="space-y-compact border-t border-border-subtle pt-4">
                        <Heading level={3}>{t('agentDetail.breaker.trippedHeading')}</Heading>
                        <dl className="flex flex-wrap gap-default">
                            <Fact
                                label={t('agentDetail.breaker.factTrippedAt')}
                                value={formatDateTime(breaker.trippedAt)}
                            />
                            <Fact
                                label={t('agentDetail.breaker.factTrippedWindow')}
                                value={breaker.trippedWindow ?? '—'}
                                mono
                            />
                        </dl>
                        {breaker.trippedSignals.length > 0 ? (
                            <div className="flex flex-wrap items-center gap-tight">
                                <span className="text-xs uppercase tracking-wide text-content-subtle">
                                    {t('agentDetail.breaker.factTrippedSignals')}
                                </span>
                                {breaker.trippedSignals.map((s) => (
                                    <StatusBadge key={s} variant="error" size="sm">
                                        {signalLabel(s)}
                                    </StatusBadge>
                                ))}
                            </div>
                        ) : (
                            <p className="text-sm text-content-muted">
                                {t('agentDetail.breaker.trippedSignalsUnrecorded')}
                            </p>
                        )}
                        {canCloseBreaker ? (
                            <Button
                                variant="secondary"
                                size="sm"
                                id="agent-breaker-close-btn"
                                onClick={openCloseDialog}
                            >
                                {t('agentDetail.breaker.closeAction')}
                            </Button>
                        ) : (
                            // Stated rather than hidden: the control exists and
                            // is not this principal's to use. `canCloseBreaker`
                            // is the register key AND the role-tier admin check,
                            // so holding the key alone is a real and confusing
                            // way to land here.
                            <p className="text-sm text-content-muted">
                                {t('agentDetail.breaker.closeRestricted')}
                            </p>
                        )}
                    </div>
                )}
            </Card>

            <Card density="compact" className="space-y-default">
                <Heading level={2}>{t('agentDetail.breaker.baselineHeading')}</Heading>
                {/* The look-back, not the page. The figures are counted over
                    the same windows the detector reads — `BASELINE_WINDOW_LIMIT`
                    since the epoch, with the anomalous ones, the hour still
                    filling and the window awaiting its verdict excluded, in
                    that order — so the copy no longer hedges them as a floor.
                    That hedge was there because the count came off the 48-row
                    page below and saturated there. `lookbackWindows` is the
                    server's constant, never `data.windows.length`: the ledger
                    page is how many rows this table shows and says nothing
                    about how far back the detector looked. */}
                <p className="text-sm text-content-muted">
                    {t('agentDetail.breaker.baselineExplainCounted', {
                        count: baseline.lookbackWindows,
                    })}
                </p>
                <dl className="flex flex-wrap gap-default">
                    <Fact
                        label={t('agentDetail.breaker.baselineWindows')}
                        value={progressValue(
                            baseline.windows,
                            baseline.requiredWindows,
                            t,
                        )}
                    />
                    <Fact
                        label={t('agentDetail.breaker.baselineObservations')}
                        value={progressValue(
                            baseline.observations,
                            baseline.requiredObservations,
                            t,
                        )}
                    />
                    <Fact
                        label={t('agentDetail.breaker.baselineLookback')}
                        value={t('agentDetail.breaker.baselineLookbackValue', {
                            count: baseline.lookbackWindows,
                        })}
                    />
                    <Fact
                        label={t('agentDetail.breaker.baselineTrip')}
                        value={t('agentDetail.breaker.baselineTripValue', {
                            required: data.windowsToTrip,
                        })}
                    />
                </dl>
                {/* States the detector's position now, because the figures are
                    its own — the population `evaluateWindow` would read this
                    instant, judged row excluded. Still the arithmetic and not
                    the verdict: judgement is LAZY, so both sentences say what
                    the history supports and point at the posture card above for
                    what the detector last actually decided. Without that
                    pointer a sufficient count sits beside a "not judging
                    anything yet" badge with nothing explaining the pair. */}
                <p className="text-sm text-content-default">
                    {baselineClearsThresholds
                        ? t('agentDetail.breaker.baselineCountedEnough')
                        : t('agentDetail.breaker.baselineCountedShort')}
                </p>
            </Card>

            <Card density="compact" className="space-y-default">
                <Heading level={2}>{t('agentDetail.breaker.windowsHeading')}</Heading>
                {data.windows.length === 0 ? (
                    <InlineEmptyState
                        icon={ChartActivity2}
                        title={t('agentDetail.breaker.noWindows')}
                        description={t('agentDetail.breaker.noWindowsDescription')}
                    />
                ) : (
                    <>
                        <p className="text-sm text-content-muted">
                            {t('agentDetail.breaker.windowsCaption', {
                                count: data.windows.length,
                            })}
                        </p>
                        {/* `id` AND `data-testid` carry the same value the
                            retired table primitive used to emit on both — its
                            `data-testid` prop is that primitive's id setter, so
                            keeping the pair keeps `#agent-breaker-windows-table`
                            addressable for E2E and testid-first rendered tests
                            alike. */}
                        <ul
                            id="agent-breaker-windows-table"
                            data-testid="agent-breaker-windows-table"
                            className="divide-y divide-border-subtle border-t border-border-subtle"
                        >
                            {data.windows.map((w) => (
                                <li
                                    key={w.windowStart}
                                    className="flex flex-wrap items-center gap-compact py-tight text-sm"
                                >
                                    <span className="whitespace-nowrap font-mono tabular-nums text-content-emphasis">
                                        {formatDateTime(w.windowStart)}
                                    </span>
                                    <StatusBadge
                                        variant={verdictTone(w.verdict)}
                                        size="sm"
                                    >
                                        {verdictLabel(w.verdict)}
                                    </StatusBadge>
                                    {w.anomalous && (
                                        // Quiet text rather than a second pill.
                                        // Two badges on one row make the eye
                                        // choose between two alarms, and this
                                        // one is a qualifier on the verdict
                                        // beside it rather than a rival to it.
                                        <span className="text-content-warning">
                                            {t('agentDetail.breaker.anomalousBadge')}
                                        </span>
                                    )}
                                    {/* Which rows the DETECTOR is allowed to
                                        learn from, which is not every row on
                                        screen. An anomalous window is excluded
                                        so the strongest signal cannot
                                        extinguish itself, and a window before
                                        the epoch was discarded by an operator
                                        accepting a change — the visible,
                                        after-the-fact consequence of
                                        ACCEPTED_NEW_BASELINE. */}
                                    <span className="ml-auto whitespace-nowrap text-content-muted">
                                        {countedLabel(
                                            countedStanding(w, baselineEpoch, {
                                                currentWindowStart:
                                                    data.currentWindowStart,
                                                pendingVerdictWindowStart:
                                                    data.pendingVerdictWindowStart,
                                            }),
                                            t,
                                        )}
                                    </span>
                                    <span className="basis-full text-content-muted">
                                        {t('agentDetail.breaker.windowCalls', {
                                            read: w.readCalls,
                                            propose: w.proposeCalls,
                                            orchestrate: w.orchestrateCalls,
                                        })}
                                        {' · '}
                                        {/* Evidence, never a trip condition —
                                            so it is shown plainly rather than
                                            flagged, and in full rather than
                                            truncated: the tool names are what
                                            makes a trip legible afterwards. */}
                                        {w.toolNames.length === 0
                                            ? t('agentDetail.breaker.windowNoTools')
                                            : t('agentDetail.breaker.windowTools', {
                                                  tools: w.toolNames.join(', '),
                                              })}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            </Card>

            {closing && (
                <Modal
                    showModal
                    setShowModal={(v) => {
                        if (!v) dismissDialog();
                    }}
                    size="md"
                    preventDefaultClose={busy}
                >
                    <Modal.Header
                        title={t('agentDetail.breaker.closeTitle')}
                        description={t('agentDetail.breaker.closePrompt')}
                    />
                    <Modal.Body>
                        {failure && <InlineNotice variant="error">{failure}</InlineNotice>}
                        <FormField label={t('agentDetail.breaker.reasonLabel')} required>
                            <RadioGroup
                                value={reason ?? ''}
                                onValueChange={setReason}
                                disabled={busy}
                            >
                                {/* Rendered from the server's own vocabulary, so
                                    a reason added or retired there cannot leave
                                    this list offering a code the route refuses. */}
                                {data.closeReasons.map((code) => (
                                    <label
                                        key={code}
                                        htmlFor={`agent-breaker-reason-${code}`}
                                        className={
                                            reason === code
                                                ? 'flex cursor-pointer gap-compact rounded-md border border-border-emphasis bg-bg-subtle p-3'
                                                : 'flex cursor-pointer gap-compact rounded-md border border-border-subtle p-3'
                                        }
                                    >
                                        <RadioGroupItem
                                            value={code}
                                            size="sm"
                                            id={`agent-breaker-reason-${code}`}
                                            className="mt-0.5"
                                        />
                                        <span className="space-y-tight">
                                            <span className="block text-sm font-medium text-content-emphasis">
                                                {closeReasonTitle(code, t)}
                                            </span>
                                            <span className="block text-xs text-content-muted">
                                                {closeReasonBody(code, t, baseline)}
                                            </span>
                                        </span>
                                    </label>
                                ))}
                            </RadioGroup>
                        </FormField>
                        {rebaselines && (
                            // The second statement of the same fact, and it earns
                            // its place: this is the only irreversible thing on
                            // the surface, and it is reached by picking the more
                            // comfortable-sounding of two options.
                            <InlineNotice
                                variant="warning"
                                title={t('agentDetail.breaker.rebaselineWarningTitle')}
                            >
                                {t('agentDetail.breaker.rebaselineWarning', {
                                    count: baseline.windows,
                                    windows: baseline.requiredWindows,
                                    observations: baseline.requiredObservations,
                                })}
                            </InlineNotice>
                        )}
                    </Modal.Body>
                    <Modal.Footer>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={dismissDialog}
                            disabled={busy}
                        >
                            {t('agentDetail.breaker.cancel')}
                        </Button>
                        {/* The variant follows the CONSEQUENCE, not the dialog:
                            discarding an agent's history is destructive and wears
                            the destructive tone, while a plain restore does not. */}
                        <Button
                            type="button"
                            variant={rebaselines ? 'destructive' : 'primary'}
                            size="sm"
                            loading={busy}
                            disabled={busy || reason === null}
                            id="agent-breaker-close-confirm"
                            onClick={() => void submitClose()}
                        >
                            {rebaselines
                                ? t('agentDetail.breaker.confirmAccepted')
                                : t('agentDetail.breaker.confirmResolved')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            )}

            {/* The kill-switch history (#2450). It lives HERE because
                `AgentKillSwitchAction`'s own docstring says so — that control
                answers "is anything stopping this agent right now", and the
                incident timeline belongs beside the breaker's, where somebody
                reconstructing an incident is already looking. */}
            <Card>
                <KillSwitchTimeline agentId={agentId} canRead={canCloseBreaker} />
            </Card>
        </div>
    );
}

/**
 * One key/value pair. Hand-rolled `<dl>` rather than `<MetadataBar>`, which has
 * zero call sites repo-wide — the shape here matches `LeaverPassesClient` and
 * `EvidenceDetailSheet`.
 */
function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
    return (
        <div className="space-y-tight">
            <dt className="text-xs uppercase tracking-wide text-content-subtle">{label}</dt>
            <dd
                className={
                    mono
                        ? 'font-mono text-sm text-content-emphasis'
                        : 'text-sm tabular-nums text-content-emphasis'
                }
            >
                {value}
            </dd>
        </div>
    );
}

type Translate = ReturnType<typeof useTranslations>;

/**
 * The verdict's own tone. `neutral` covers both a window nothing has judged yet
 * and a `NO_BASELINE` refusal — neither is a finding, and giving the detector's
 * refusal to look a colour would render it as a result.
 */
function verdictTone(code: string | null): StatusBadgeVariant {
    if (code === 'TRIP') return 'error';
    if (code === 'ARMED') return 'warning';
    if (code === 'STEADY') return 'success';
    return 'neutral';
}

/** Where one ledger row stands in the baseline the figures above report. */
type CountedStanding = 'filling' | 'anomalous' | 'preEpoch' | 'awaitingVerdict' | 'counted';

/**
 * Which of those five a row is, as a discriminant rather than an i18n key.
 *
 * Split from the rendering deliberately. `tests/guards/i18n-keys-resolve.test.ts`
 * scans LITERAL `t('…')` calls, and its own header names non-literal lookups as
 * the hole a rendered test has to cover instead; a `t(countedKey(row))` that
 * returned the key put all five operator-facing labels in that hole, where a
 * key that never merged renders its own dotted path in the ledger with every
 * i18n check green. `countedLabel` spells the five out, so the guard sees them.
 */
function countedStanding(
    row: WindowRow,
    baselineEpoch: string | null,
    boundaries: { currentWindowStart: string; pendingVerdictWindowStart: string | null },
): CountedStanding {
    // Checked FIRST, and it is the reason this argument exists: the hour still
    // filling is in the ledger but not in the figures above, and labelling it
    // "Counted" would leave an operator adding up one more counted row than the
    // panel reports. A partial hour is never anomalous — nothing has judged it
    // — so the order below could not surface this state on its own. The
    // compare is lexicographic for the reason given below: both sides are
    // ISO-8601 out of the same JSON encoder.
    if (row.windowStart >= boundaries.currentWindowStart) return 'filling';
    if (row.anomalous) return 'anomalous';
    // Two ISO-8601 strings produced by the same JSON encoder, so the
    // lexicographic compare IS the chronological one. Parsing both to `Date`
    // would buy nothing and add a timezone to reason about.
    if (baselineEpoch !== null && row.windowStart < baselineEpoch) {
        return 'preEpoch';
    }
    // Last, because the three above are STANDING exclusions and this one is
    // transient. The newest complete window is the subject of the next verdict,
    // and no window is part of the baseline it is judged against
    // (`rows.slice(1)` in `evaluateWindow`) — it joins the baseline the moment
    // that verdict lands, which is when the server stops naming it. Unreachable
    // for a pre-epoch row by construction: the server's look-back is bounded
    // below by the epoch, so the row it names is never one of those.
    if (row.windowStart === boundaries.pendingVerdictWindowStart) return 'awaitingVerdict';
    return 'counted';
}

/**
 * The five labels, as five literal keys. See `countedStanding` — the literals
 * are the point, and the exhaustive switch is what makes adding a sixth
 * standing without a label a type error rather than a blank cell.
 */
function countedLabel(standing: CountedStanding, t: Translate): string {
    switch (standing) {
        case 'filling':
            return t('agentDetail.breaker.countedPending');
        case 'anomalous':
            return t('agentDetail.breaker.countedAnomalous');
        case 'preEpoch':
            return t('agentDetail.breaker.countedPreEpoch');
        case 'awaitingVerdict':
            return t('agentDetail.breaker.countedAwaitingVerdict');
        case 'counted':
            return t('agentDetail.breaker.countedYes');
    }
}

/**
 * A count against its threshold — and deliberately NOT as a progress pair once
 * the threshold is met. `have` now runs to the whole look-back (168 windows)
 * while `required` is 12, so "168 of 12" would present itself as a progress
 * reading long after it had stopped being one.
 */
function progressValue(have: number, required: number, t: Translate): string {
    return have >= required
        ? t('agentDetail.breaker.baselineMet', { have, required })
        : t('agentDetail.breaker.baselineProgress', { have, required });
}

/**
 * The API envelope's machine-readable code (`toApiErrorResponse` in
 * `src/lib/errors/types.ts`). It is the only thing separating the usecase's
 * `badRequest` from a schema rejection, both of which arrive as 400.
 */
function errorCode(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const inner = (body as { error?: unknown }).error;
    if (!inner || typeof inner !== 'object') return null;
    const code = (inner as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
}

/** Short form, for the record of a close that already happened. */
function closeReasonLabel(code: string, t: Translate): string {
    if (code === 'ACCEPTED_NEW_BASELINE') return t('agentDetail.breaker.reasonAcceptedShort');
    if (code === 'RESOLVED') return t('agentDetail.breaker.reasonResolvedShort');
    return code;
}

function closeReasonTitle(code: string, t: Translate): string {
    if (code === 'ACCEPTED_NEW_BASELINE') return t('agentDetail.breaker.reasonAcceptedTitle');
    if (code === 'RESOLVED') return t('agentDetail.breaker.reasonResolvedTitle');
    return code;
}

/**
 * A reason this build has no copy for is offered with a warning rather than a
 * blank: the vocabulary is the server's, and a silently unexplained option is
 * how an operator picks the destructive one by elimination.
 */
function closeReasonBody(code: string, t: Translate, baseline: BaselineBlock): string {
    if (code === 'ACCEPTED_NEW_BASELINE') {
        return t('agentDetail.breaker.reasonAcceptedBody', {
            windows: baseline.requiredWindows,
            observations: baseline.requiredObservations,
        });
    }
    if (code === 'RESOLVED') return t('agentDetail.breaker.reasonResolvedBody');
    return t('agentDetail.breaker.reasonUnknownBody');
}
