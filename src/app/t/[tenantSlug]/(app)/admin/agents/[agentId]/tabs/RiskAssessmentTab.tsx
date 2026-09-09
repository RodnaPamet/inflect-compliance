'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/error-state';
import { FormField } from '@/components/ui/form-field';
import { useToast } from '@/components/ui/hooks';
import { CircleQuestion } from '@/components/ui/icons/nucleo';
import { InlineEmptyState } from '@/components/ui/inline-empty-state';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Modal } from '@/components/ui/modal';
import { ProgressBar, type ProgressBarVariant } from '@/components/ui/progress-bar';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { SkeletonCard } from '@/components/ui/skeleton';
import { StatusBadge, type StatusBadgeVariant } from '@/components/ui/status-badge';
import { Textarea } from '@/components/ui/textarea';
import { Heading } from '@/components/ui/typography';
import { ApiClientError } from '@/lib/api-client';
import { apiErrorMessage } from '@/lib/api-error';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format-date';
import { useTenantSWR } from '@/lib/hooks/use-tenant-swr';
import { useTenantApiUrl } from '@/lib/tenant-context-provider';

import type { RegistryWritableTabProps } from './types';

/**
 * The agent risk assessment — the questionnaire, its standing tier, and the
 * button that scores it.
 *
 * ## The GET has a side effect, and that shapes this file
 *
 * `getAgentRiskAssessmentState` load-or-CREATES the agent's open DRAFT run, so
 * reading this tab writes a row. Two consequences the component has to respect:
 *
 *   • There is no "start assessment" button, and there should not be one — the
 *     run already exists by the time anything renders.
 *   • The read must NEVER be hoisted into the shell or a prefetch. The shell
 *     mounts this component only while its tab is selected, so the fetch on
 *     mount is exactly one DRAFT per operator who actually opened the tab.
 *     Prefetching it on hover would mint a run for every agent somebody's
 *     cursor crossed.
 *
 * ## Answering is local-first
 *
 * The PUT returns the upserted ANSWER ROW, not a refreshed page state, so there
 * is nothing in the response to render. The edits map is the authority for what
 * is on screen and the revalidation behind it only refreshes the parts the
 * answer moved (the run's status, the standing block). Seeding component state
 * from the payload instead would be wrong twice over: `useTenantSWR`
 * revalidates on window focus, so a seeding effect wipes half-typed notes every
 * time the operator tabs away, and a note that saves on every keystroke turns
 * one considered answer into forty writes.
 */

type AnswerValue = 'NA' | 'NO' | 'PARTIALLY' | 'YES';

/** Order is the ladder the scorer reads: NA leaves the denominator, NO is worst. */
const ANSWER_VALUES: readonly AnswerValue[] = ['YES', 'PARTIALLY', 'NO', 'NA'];

/** `AgentRiskAssessment.staleTriggers` — stable codes, translated by suffix. */
const STALENESS_TRIGGERS = [
    'AUTONOMY_RAISED',
    'TOOL_GRANTED',
    'DATA_SCOPE_WIDENED',
    'REVERSIBILITY_WORSENED',
    'PROVENANCE_WIDENED',
    'MODEL_CHANGED',
] as const;

type StalenessTrigger = (typeof STALENESS_TRIGGERS)[number];

function isKnownTrigger(code: string): code is StalenessTrigger {
    return (STALENESS_TRIGGERS as readonly string[]).includes(code);
}

/**
 * The two triggers a re-score CANNOT answer.
 *
 * `rescoreAgainstStandingAnswers` short-circuits on `axesUnchanged`, and the
 * conjunction it tests is the four SCORER axes — autonomy, data scope,
 * reversibility, provenance. The granted-tool count and the model reference
 * are not among them, so a run made stale by a tool grant or a model swap
 * alone is re-scored by nothing and the cap does not move. The panel has to
 * say which of the two stories it is telling; see `axisMoved`.
 */
const NON_RESCORING_TRIGGERS: readonly string[] = ['TOOL_GRANTED', 'MODEL_CHANGED'];

/**
 * `AgentAssessmentQuestion.criticality` — a String column with a documented
 * three-value vocabulary, not a Postgres enum, so an unrecognised value is
 * reachable and renders as its raw code rather than crashing on a missing key.
 */
const CRITICALITY_VALUES = ['CRITICAL', 'HIGH', 'MEDIUM'] as const;

type Criticality = (typeof CRITICALITY_VALUES)[number];

function isKnownCriticality(value: string): value is Criticality {
    return (CRITICALITY_VALUES as readonly string[]).includes(value);
}

/** `AgentRiskAssessment.status` — same String-enum shape, same treatment. */
const RUN_STATUSES = ['DRAFT', 'IN_PROGRESS', 'COMPLETED'] as const;

type RunStatus = (typeof RUN_STATUSES)[number];

function isKnownRunStatus(value: string): value is RunStatus {
    return (RUN_STATUSES as readonly string[]).includes(value);
}

/** `Date` fields arrive as ISO strings over JSON. */
interface StandingBlock {
    assessmentId: string;
    tier: string | null;
    /**
     * The tier ACTUALLY capping the agent. It can be worse than `tier`: a
     * widening re-scores from the same answers in the transaction that records
     * it and writes the result onto the agent whenever it comes out higher.
     */
    tierInForce: string | null;
    score: number | null;
    completedAt: string | null;
    staleAt: string | null;
    staleTriggers: string[];
    /**
     * `null` is NOT APPLICABLE — the run recorded no basis, so there is nothing
     * to compare the live agent against. Rendering it as "fresh" would claim a
     * comparison that never ran.
     */
    staleness: { stale: boolean; triggers: string[]; detail: string[] } | null;
}

interface AssessmentQuestion {
    id: string;
    domainId: number;
    text: string;
    guidance: string | null;
    criticality: string;
    /** `mappingsJson` — `{ asi: string[], imda: string[] }` in the fixture. */
    mappings: unknown;
    answer: AnswerValue | null;
    note: string | null;
}

interface AssessmentDomain {
    id: number;
    code: string;
    name: string;
    description: string;
}

interface AssessmentState {
    agent: {
        id: string;
        name: string;
        riskTier: string | null;
        riskTierScoredAt: string | null;
    };
    assessmentId: string;
    status: string;
    questionSetVersion: number;
    domains: AssessmentDomain[];
    questions: AssessmentQuestion[];
    standing: StandingBlock | null;
}

/** What the `complete` route hands back. `band` and `floors` are not on the GET. */
interface ScoreResult {
    tier: string;
    score: number;
    band: string;
    floors: string[];
    breakdown: { applicableQuestions: number; unansweredQuestions: number };
    /**
     * The evidence seam's own verdict, ASKED rather than assumed.
     *
     * The server types this `emitted: false` as a literal today, so hardcoding
     * "no artefact was filed" would be true — and would stay on screen, still
     * asserted, on the day 10/10 wires the emission. Widening a literal to
     * `boolean` is not a type error, so `tsc` would never have flagged it.
     * Declared `boolean` here deliberately: the sentence then costs nothing to
     * keep honest. OPTIONAL because the SWR/fetch generics are unchecked
     * assertions, and the render rule below is `=== false` rather than falsy —
     * "the server did not tell us" is not the same as "the server said no",
     * and only the second one licenses printing a claim about the artefact.
     */
    evidence?: { emitted: boolean };
}

type LocalAnswer = { answer: AnswerValue; note: string | null };

/** Higher tier, louder badge. An unknown value is not quietly styled as calm. */
function tierVariant(tier: string | null): StatusBadgeVariant {
    if (tier === 'LOW') return 'success';
    if (tier === 'MODERATE') return 'warning';
    if (tier === 'HIGH' || tier === 'CRITICAL') return 'error';
    return 'neutral';
}

function criticalityVariant(criticality: string): StatusBadgeVariant {
    if (criticality === 'CRITICAL') return 'error';
    if (criticality === 'HIGH') return 'warning';
    return 'info';
}

/** The open run's lifecycle. A run in hand is never `COMPLETED`, but say so anyway. */
function runStatusVariant(status: string): StatusBadgeVariant {
    if (status === 'COMPLETED') return 'success';
    if (status === 'IN_PROGRESS') return 'info';
    return 'neutral';
}

/**
 * Progress tone. THREE states, because the bar can be full and still wrong:
 * every question marked N/A fills it to 100% and is the worst answer set the
 * scorer can be handed. Only a full APPLICABLE set earns the success tone.
 */
function progressVariant(progress: { applicable: number; unanswered: number }): ProgressBarVariant {
    if (progress.applicable === 0) return 'warning';
    if (progress.unanswered === 0) return 'success';
    return 'brand';
}

/**
 * The external taxonomy ids this question projects onto, as one line.
 * `mappingsJson` is `Json` in the schema and the SWR generic is an unchecked
 * assertion, so every branch is guarded rather than trusted.
 */
function mappingLine(mappings: unknown): string {
    if (!mappings || typeof mappings !== 'object') return '';
    const m = mappings as Record<string, unknown>;
    const ids: string[] = [];
    for (const key of ['asi', 'imda']) {
        const list = m[key];
        if (Array.isArray(list)) ids.push(...list.filter((v): v is string => typeof v === 'string'));
    }
    return ids.join(' · ');
}

export function RiskAssessmentTab({
    agentId,
    refreshToken,
    onChanged,
    canManageRegistry,
}: RegistryWritableTabProps) {
    const t = useTranslations('admin');
    const apiUrl = useTenantApiUrl();
    const toast = useToast();

    const path = `/admin/agents/${agentId}/risk-assessment`;
    const { data, error, isLoading, mutate } = useTenantSWR<AssessmentState>(path);

    // The refreshToken -> SWR bridge.
    useEffect(() => {
        void mutate();
    }, [refreshToken, mutate]);

    const [edits, setEdits] = useState<Record<string, LocalAnswer>>({});
    const [savingId, setSavingId] = useState<string | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [scoring, setScoring] = useState(false);
    const [result, setResult] = useState<ScoreResult | null>(null);

    // Saved answers are the baseline; `edits` is only what this session changed.
    const answers = useMemo(() => {
        const merged: Record<string, LocalAnswer> = {};
        for (const q of data?.questions ?? []) {
            if (q.answer) merged[q.id] = { answer: q.answer, note: q.note };
        }
        return { ...merged, ...edits };
    }, [data, edits]);

    const questionsByDomain = useMemo(() => {
        const groups = new Map<number, AssessmentQuestion[]>();
        for (const q of data?.questions ?? []) {
            const list = groups.get(q.domainId) ?? [];
            list.push(q);
            groups.set(q.domainId, list);
        }
        return groups;
    }, [data]);

    /**
     * The same arithmetic `scoreAgentRisk` does, so the warning on the complete
     * button names the number the server is about to count: NA leaves the
     * denominator, and an applicable question with no answer scores as NO.
     */
    const progress = useMemo(() => {
        const questions = data?.questions ?? [];
        let na = 0;
        let answered = 0;
        for (const q of questions) {
            const value = answers[q.id]?.answer;
            if (value === 'NA') na += 1;
            else if (value) answered += 1;
        }
        const applicable = questions.length - na;
        // Answered OR explicitly N/A — "has anybody touched this run at all",
        // which is a different question from "is it complete" and is the one
        // the successor-draft notice below asks.
        const recorded = answered + na;
        return {
            total: questions.length,
            applicable,
            answered,
            recorded,
            unanswered: applicable - answered,
            percent: questions.length ? Math.round((recorded / questions.length) * 100) : 0,
        };
    }, [data, answers]);

    /**
     * Questions whose `domainId` matches no domain row in the payload.
     *
     * Unreachable today — `domainId` is a required FK and the four-row fixture
     * is far under the domain cap — and rendered anyway, because the grouped
     * render walks `data.domains` while `progress` counts every question. A
     * question that fell out of that join would be counted in "3 applicable
     * questions have no answer" with nowhere on the page to answer them, and
     * an operator would read a stuck counter rather than a missing row.
     */
    const ungroupedQuestions = useMemo(() => {
        const domainIds = new Set((data?.domains ?? []).map((d) => d.id));
        return (data?.questions ?? []).filter((q) => !domainIds.has(q.domainId));
    }, [data]);

    const saveAnswer = useCallback(
        async (questionId: string, answer: AnswerValue, note: string | null) => {
            const previous = edits[questionId];
            setSavingId(questionId);
            setFailure(null);
            setEdits((prev) => ({ ...prev, [questionId]: { answer, note } }));
            try {
                const res = await fetch(apiUrl(path), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ questionId, answer, note }),
                });
                if (!res.ok) {
                    // The envelope's `error` is an OBJECT; putting it in state
                    // and rendering it throws React #31 inside the page error
                    // boundary — on the one path nobody exercises.
                    const body = await res.json().catch(() => null);
                    setFailure(apiErrorMessage(body, t('agentDetail.risk.saveError')));
                    setEdits((prev) => {
                        const next = { ...prev };
                        if (previous) next[questionId] = previous;
                        else delete next[questionId];
                        return next;
                    });
                    return;
                }
                // The response is the upserted answer ROW, not the page state.
                // Revalidating is what picks up the DRAFT -> IN_PROGRESS move;
                // the edits map keeps the answer on screen meanwhile.
                await mutate();
            } catch {
                setFailure(t('agentDetail.risk.saveError'));
                setEdits((prev) => {
                    const next = { ...prev };
                    if (previous) next[questionId] = previous;
                    else delete next[questionId];
                    return next;
                });
            } finally {
                setSavingId(null);
            }
        },
        [apiUrl, path, edits, mutate, t],
    );

    const complete = useCallback(async () => {
        setScoring(true);
        setFailure(null);
        try {
            const res = await fetch(apiUrl(`${path}/complete`), { method: 'POST' });
            if (!res.ok) {
                const body = await res.json().catch(() => null);
                setFailure(apiErrorMessage(body, t('agentDetail.risk.completeError')));
                return;
            }
            const scored = (await res.json()) as ScoreResult;
            setResult(scored);
            setConfirming(false);
            // A completed run opens a NEW draft on the next read and, more to
            // the point, has just written a tier onto the agent — which the
            // overview, tools and coverage tabs all render off.
            setEdits({});
            await mutate();
            onChanged?.();
            toast.success(t('agentDetail.risk.completedToast', { tier: scored.tier }));
        } catch {
            setFailure(t('agentDetail.risk.completeError'));
        } finally {
            setScoring(false);
        }
    }, [apiUrl, path, mutate, onChanged, toast, t]);

    if (error) {
        const forbidden = error instanceof ApiClientError && error.status === 403;
        return (
            <ErrorState
                title={
                    forbidden
                        ? t('agentDetail.risk.forbiddenTitle')
                        : t('agentDetail.risk.loadErrorTitle')
                }
                // Never the server's 403 message — it is deliberately the
                // uninformative "Permission denied" and names no key.
                description={
                    forbidden
                        ? t('agentDetail.risk.forbiddenDescription')
                        : t('agentDetail.risk.loadErrorDescription')
                }
                onRetry={forbidden ? undefined : () => void mutate()}
                retryLabel={t('agentDetail.risk.retry')}
            />
        );
    }
    if (isLoading && !data) return <SkeletonCard lines={8} />;
    // No error, not loading, no payload is not a state this route produces.
    // The skeleton is the honest render for it; an empty panel here would say
    // the agent has no questionnaire, which is a claim about a control.
    if (!data) return <SkeletonCard lines={8} />;
    if (data.questions.length === 0) {
        return (
            <InlineEmptyState
                icon={CircleQuestion}
                title={t('agentDetail.risk.noQuestions')}
                description={t('agentDetail.risk.noQuestionsDescription')}
            />
        );
    }

    const standing = data.standing;

    // One row shape, two call sites (the domain groups and the ungrouped
    // fallback). Kept as a plain function rather than a component so the rows
    // in the fallback bucket are the SAME rows, not a second implementation
    // that could drift from the first.
    const renderQuestion = (question: AssessmentQuestion) => (
        <QuestionRow
            key={question.id}
            question={question}
            current={answers[question.id] ?? null}
            saving={savingId === question.id}
            canWrite={canManageRegistry}
            onSave={saveAnswer}
        />
    );

    return (
        <div className="space-y-section">
            {failure && (
                <InlineNotice
                    variant="error"
                    dismissLabel={t('agentDetail.risk.dismiss')}
                    onDismiss={() => setFailure(null)}
                >
                    {failure}
                </InlineNotice>
            )}

            {!canManageRegistry && (
                <InlineNotice variant="info" title={t('agentDetail.risk.readOnlyTitle')}>
                    {t('agentDetail.risk.readOnlyBody')}
                </InlineNotice>
            )}

            {result && (
                <InlineNotice
                    variant="success"
                    title={t('agentDetail.risk.scoredTitle', {
                        tier: result.tier,
                        score: result.score,
                    })}
                    dismissLabel={t('agentDetail.risk.dismiss')}
                    onDismiss={() => setResult(null)}
                >
                    <span className="block">
                        {result.floors.length > 0
                            ? t('agentDetail.risk.scoredFloors', {
                                  band: result.band,
                                  floors: result.floors.join(' · '),
                              })
                            : t('agentDetail.risk.scoredBand', { band: result.band })}
                    </span>
                    {/* Stated rather than left to be inferred: the completion
                        builds an evidence DESCRIPTOR and files nothing, and an
                        operator who assumes otherwise stops looking for the
                        artefact an assessor will ask for.

                        Read off the RESPONSE, not off what is true today. The
                        seam is explicitly 10/10's to wire, and a hardcoded
                        sentence would go on denying an artefact that exists —
                        the exact shape of dishonesty this panel is here to
                        avoid, and one no type check would have caught. */}
                    {result.evidence?.emitted === false && (
                        <span className="block text-xs text-content-muted">
                            {t('agentDetail.risk.scoredNoEvidence')}
                        </span>
                    )}
                </InlineNotice>
            )}

            <StandingTier standing={standing} agentScoredAt={data.agent.riskTierScoredAt} />

            <Card density="compact" className="space-y-compact">
                <div className="flex flex-wrap items-baseline justify-between gap-compact">
                    <div className="flex flex-wrap items-center gap-tight">
                        <Heading level={2}>{t('agentDetail.risk.questionnaireHeading')}</Heading>
                        {/* The open run's own identity. Without it the page has
                            two assessments on it and names only one, and the
                            questionnaire silently borrows the standing block's
                            authority. */}
                        <StatusBadge variant={runStatusVariant(data.status)} size="sm">
                            {isKnownRunStatus(data.status)
                                ? t(
                                      `agentDetail.risk.runStatus.${data.status}` as Parameters<
                                          typeof t
                                      >[0],
                                  )
                                : data.status}
                        </StatusBadge>
                    </div>
                    <span className="text-xs text-content-subtle">
                        {t('agentDetail.risk.questionSetVersion', {
                            version: data.questionSetVersion,
                        })}
                    </span>
                </div>

                {/* A completion does not clear this questionnaire — it opens a
                    NEW one. `openAssessment` is load-or-create and a COMPLETED
                    run is never reopened, so the revalidation after scoring
                    mints a successor DRAFT and the screen becomes "Standing
                    assessment: HIGH, completed today" sitting directly above
                    twenty blanks and a warning that completing now scores them
                    all as No. The honest reading of that, unlabelled, is "my
                    answers were lost" — and the recovery it invites (re-answer,
                    complete again) opens a third run. Say which run is which. */}
                {standing &&
                    standing.assessmentId !== data.assessmentId &&
                    progress.recorded === 0 && (
                        <InlineNotice variant="info" title={t('agentDetail.risk.newRunTitle')}>
                            {t('agentDetail.risk.newRunBody')}
                        </InlineNotice>
                    )}

                <p className="text-sm text-content-muted">
                    {t('agentDetail.risk.completeness', {
                        answered: progress.recorded,
                        total: progress.total,
                    })}
                </p>
                <ProgressBar
                    value={progress.percent}
                    // An all-N/A run is 100% recorded and the WORST answer set
                    // there is: the scorer reads an empty denominator as fully
                    // unmitigated and charges the whole answer weight. A full
                    // bar in the brand tone still reads as "done" directly
                    // above the warning that says otherwise, so it gets the
                    // warning tone rather than an encouraging one.
                    variant={progressVariant(progress)}
                    size="sm"
                    aria-label={t('agentDetail.risk.progressAria')}
                />
                {progress.applicable === 0 ? (
                    // Answering NA to everything is NOT the friendly option: the
                    // scorer reads an empty denominator as fully unmitigated, so
                    // it costs the whole twelve answer points rather than saving
                    // them. Nothing else on this page would tell an operator that.
                    <p className="text-xs text-content-warning">
                        {t('agentDetail.risk.allNotApplicable')}
                    </p>
                ) : progress.unanswered > 0 ? (
                    <p className="text-xs text-content-warning">
                        {t('agentDetail.risk.unansweredCountAsNo', {
                            count: progress.unanswered,
                        })}
                    </p>
                ) : null}
                <div className="flex flex-wrap items-center gap-compact pt-2">
                    {/* `canManageRegistry` is the route key ALONE, and the three
                        usecases behind this panel additionally call
                        `assertCanWrite`, which reads the membership's BASE ROLE
                        rather than the permissions blob. So a custom role with
                        base role READER holding `admin.agent_registry` gets an
                        enabled button here and a refusal inside the transaction.
                        The failure is honest — an error notice, no partial write
                        — but the button should not have rendered. Fixing it
                        properly is one conjunction in `page.tsx`
                        (`&& ctx.permissions.canWrite`, exactly as
                        `canCloseBreaker` already does), which is a frozen
                        single-writer seam; escalated rather than worked around
                        here, because faking it locally would mean this tab
                        deriving a permission the shell is the one place that
                        derives. */}
                    <Button
                        variant="secondary"
                        size="sm"
                        id="agent-risk-complete-btn"
                        disabled={!canManageRegistry || scoring}
                        onClick={() => {
                            setFailure(null);
                            setConfirming(true);
                        }}
                    >
                        {t('agentDetail.risk.completeAction')}
                    </Button>
                    <span className="text-xs text-content-subtle">
                        {t('agentDetail.risk.completeHint')}
                    </span>
                </div>
            </Card>

            {data.domains
                .filter((domain) => (questionsByDomain.get(domain.id) ?? []).length > 0)
                .map((domain) => (
                    <section key={domain.id} className="space-y-default">
                        <div className="space-y-tight">
                            <Heading level={3}>{domain.name}</Heading>
                            <p className="text-xs text-content-muted">{domain.description}</p>
                        </div>
                        <ul className="space-y-compact">
                            {(questionsByDomain.get(domain.id) ?? []).map(renderQuestion)}
                        </ul>
                    </section>
                ))}

            {/* The counter's denominator is every question; the render above
                walks the domains. This bucket is what keeps those two the same
                set — see `ungroupedQuestions`. */}
            {ungroupedQuestions.length > 0 && (
                <section className="space-y-default">
                    <div className="space-y-tight">
                        <Heading level={3}>{t('agentDetail.risk.ungroupedHeading')}</Heading>
                        <p className="text-xs text-content-muted">
                            {t('agentDetail.risk.ungroupedDescription')}
                        </p>
                    </div>
                    <ul className="space-y-compact">{ungroupedQuestions.map(renderQuestion)}</ul>
                </section>
            )}

            {confirming && (
                <Modal
                    showModal
                    setShowModal={(open) => {
                        if (!open && !scoring) setConfirming(false);
                    }}
                    size="md"
                    preventDefaultClose={scoring}
                >
                    <Modal.Header
                        title={t('agentDetail.risk.confirmTitle')}
                        description={t('agentDetail.risk.confirmPrompt')}
                    />
                    <Modal.Body>
                        <div className="space-y-compact">
                            {/* The route has NO completeness precondition — it
                                will score a never-touched agent and write a real
                                tier. This warning is the only thing standing in
                                front of that, so it names the count. */}
                            {progress.applicable === 0 && (
                                <InlineNotice variant="warning">
                                    {t('agentDetail.risk.allNotApplicable')}
                                </InlineNotice>
                            )}
                            {progress.unanswered > 0 && (
                                <InlineNotice variant="warning">
                                    {t('agentDetail.risk.confirmUnanswered', {
                                        count: progress.unanswered,
                                        applicable: progress.applicable,
                                    })}
                                </InlineNotice>
                            )}
                            <p className="text-sm text-content-default">
                                {t('agentDetail.risk.confirmNeverReopened')}
                            </p>
                        </div>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={scoring}
                            onClick={() => setConfirming(false)}
                        >
                            {t('agentDetail.risk.cancel')}
                        </Button>
                        <Button
                            type="button"
                            variant="primary"
                            size="sm"
                            loading={scoring}
                            disabled={scoring}
                            id="agent-risk-complete-confirm"
                            onClick={() => void complete()}
                        >
                            {t('agentDetail.risk.confirmAction')}
                        </Button>
                    </Modal.Footer>
                </Modal>
            )}
        </div>
    );
}

/**
 * The completed run behind the agent's cap, and whether it still describes the
 * agent. Three states, and the third is the one worth spelling out: a `null`
 * verdict means the comparison could not be made, which is not freshness.
 */
function StandingTier({
    standing,
    agentScoredAt,
}: {
    standing: StandingBlock | null;
    agentScoredAt: string | null;
}) {
    const t = useTranslations('admin');

    if (!standing) {
        return (
            <InlineNotice variant="warning" title={t('agentDetail.risk.neverScoredTitle')}>
                {t('agentDetail.risk.neverScoredBody')}
            </InlineNotice>
        );
    }

    const staleness = standing.staleness;
    const triggers = staleness?.triggers?.length ? staleness.triggers : standing.staleTriggers;

    /**
     * Did anything the SCORER reads actually move?
     *
     * This decides which of two incompatible claims the stale notice is allowed
     * to make, and the difference is not cosmetic. "The tier is not left behind
     * — a widening is re-scored from these same answers" is TRUE for the four
     * axis triggers and FALSE for the other two: `rescoreAgainstStandingAnswers`
     * returns early when the four axes match the stored basis, and neither
     * `toolCount` nor `modelRef` is in that conjunction. So on a tool grant or a
     * model swap nothing is recomputed and the cap does not tighten — and an
     * operator who reads "the cap already narrowed, this is only a prompt to
     * re-answer" defers the re-answer against a control that is not in force.
     *
     * Read off the LIVE verdict, never the stored `staleTriggers`: the stored
     * list is what was true when the run was marked stale, and the question
     * here is what is true of the agent in front of the operator now.
     */
    const axisMoved = (staleness?.triggers ?? []).some(
        (code) => !NON_RESCORING_TRIGGERS.includes(code),
    );

    /**
     * The stale body, branched on `axisMoved` and on whether the run carries a
     * `staleAt`. Assembled here rather than as a nested ternary in the JSX so
     * the four cases are readable side by side — this is the one string on the
     * panel that can state a control is in force when it is not.
     */
    let staleMessage: string;
    if (axisMoved) {
        staleMessage = standing.staleAt
            ? t('agentDetail.risk.staleSinceBody', { when: formatDateTime(standing.staleAt) })
            : t('agentDetail.risk.staleBody');
    } else {
        staleMessage = standing.staleAt
            ? t('agentDetail.risk.staleNoRescoreSinceBody', {
                  when: formatDateTime(standing.staleAt),
              })
            : t('agentDetail.risk.staleNoRescoreBody');
    }

    const facts = [
        { label: t('agentDetail.risk.factScoredTier'), value: standing.tier },
        { label: t('agentDetail.risk.factTierInForce'), value: standing.tierInForce },
    ];

    return (
        <Card density="compact" className="space-y-compact">
            <Heading level={2}>{t('agentDetail.risk.standingHeading')}</Heading>

            <dl className="flex flex-wrap gap-default">
                {facts.map((fact) => (
                    <div key={fact.label} className="space-y-tight">
                        <dt className="text-xs uppercase tracking-wide text-content-subtle">
                            {fact.label}
                        </dt>
                        <dd>
                            <StatusBadge variant={tierVariant(fact.value)} size="sm">
                                {fact.value ?? t('agentDetail.unscored')}
                            </StatusBadge>
                        </dd>
                    </div>
                ))}
                <div className="space-y-tight">
                    <dt className="text-xs uppercase tracking-wide text-content-subtle">
                        {t('agentDetail.risk.factScore')}
                    </dt>
                    <dd className="text-sm tabular-nums text-content-emphasis">
                        {standing.score ?? '—'}
                    </dd>
                </div>
                <div className="space-y-tight">
                    <dt className="text-xs uppercase tracking-wide text-content-subtle">
                        {t('agentDetail.risk.factCompleted')}
                    </dt>
                    <dd className="text-sm text-content-emphasis">
                        {standing.completedAt ? formatDateTime(standing.completedAt) : '—'}
                    </dd>
                </div>
                <div className="space-y-tight">
                    <dt className="text-xs uppercase tracking-wide text-content-subtle">
                        {t('agentDetail.risk.factTierWrittenAt')}
                    </dt>
                    <dd className="text-sm text-content-emphasis">
                        {agentScoredAt ? formatDateTime(agentScoredAt) : '—'}
                    </dd>
                </div>
            </dl>

            {/* The tier in force only ever moves upward: a widening re-scores
                from these same answers and writes the worse result onto the
                agent. Saying so is the difference between "the page disagrees
                with itself" and "the cap tightened without a fresh review". */}
            {standing.tier && standing.tierInForce && standing.tier !== standing.tierInForce && (
                <InlineNotice variant="info">
                    {t('agentDetail.risk.tierInForceDiffers', {
                        scored: standing.tier,
                        inForce: standing.tierInForce,
                    })}
                </InlineNotice>
            )}

            {staleness === null ? (
                <InlineNotice variant="info" title={t('agentDetail.risk.stalenessUnknownTitle')}>
                    {t('agentDetail.risk.stalenessUnknownBody')}
                </InlineNotice>
            ) : !staleness.stale ? (
                <InlineNotice variant="success" title={t('agentDetail.risk.freshTitle')}>
                    {t('agentDetail.risk.freshBody')}
                </InlineNotice>
            ) : (
                <InlineNotice variant="warning" title={t('agentDetail.risk.staleTitle')}>
                    <span className="block">{staleMessage}</span>
                    {/* Only worth saying when nothing re-scored: it is the
                        answer to "then what IS holding the line?", and the
                        answer is that `grantAgentTool` refuses a tool above the
                        standing cap at the moment of the grant. On the axis
                        path the re-score is that answer already. */}
                    {!axisMoved && staleness.triggers.includes('TOOL_GRANTED') && (
                        <span className="mt-1 block">
                            {t('agentDetail.risk.staleToolCapNote')}
                        </span>
                    )}
                    <span className="mt-1 flex flex-wrap gap-tight">
                        {triggers.map((code) => (
                            <StatusBadge key={code} variant="warning" size="sm">
                                {isKnownTrigger(code)
                                    ? t(
                                          `agentDetail.risk.trigger.${code}` as Parameters<
                                              typeof t
                                          >[0],
                                      )
                                    : code}
                            </StatusBadge>
                        ))}
                    </span>
                    {/* Authored by the comparison itself — "autonomyLevel 3 → 5".
                        Rendered verbatim so the page cannot drift from what the
                        verdict actually says. */}
                    {staleness.detail.length > 0 && (
                        <span className="mt-1 block font-mono text-xs text-content-muted">
                            {staleness.detail.join(' · ')}
                        </span>
                    )}
                </InlineNotice>
            )}
        </Card>
    );
}

/** One question: the answer control, and a note that saves on blur. */
function QuestionRow({
    question,
    current,
    saving,
    canWrite,
    onSave,
}: {
    question: AssessmentQuestion;
    current: LocalAnswer | null;
    saving: boolean;
    canWrite: boolean;
    onSave: (questionId: string, answer: AnswerValue, note: string | null) => void;
}) {
    const t = useTranslations('admin');
    const mappings = mappingLine(question.mappings);
    // The radiogroup's accessible name. Without it a screen reader meets
    // twenty consecutive unlabelled groups of Yes/Partially/No/N-A and the
    // question — the only thing that distinguishes them — is in a sibling.
    const questionTextId = `agent-risk-question-${question.id}-text`;

    return (
        <li
            id={`agent-risk-question-${question.id}`}
            className={cn(
                'rounded-lg border border-border-subtle p-3 space-y-tight',
                saving && 'opacity-60',
            )}
        >
            <div className="flex flex-wrap items-start gap-tight">
                <StatusBadge variant={criticalityVariant(question.criticality)} size="sm">
                    {isKnownCriticality(question.criticality)
                        ? t(
                              `agentDetail.risk.criticality.${question.criticality}` as Parameters<
                                  typeof t
                              >[0],
                          )
                        : question.criticality}
                </StatusBadge>
                <span
                    id={questionTextId}
                    className="min-w-[14rem] flex-1 text-sm text-content-emphasis"
                >
                    {question.text}
                </span>
            </div>
            {question.guidance && (
                <p className="text-xs text-content-muted">{question.guidance}</p>
            )}
            {mappings && <p className="font-mono text-xs text-content-subtle">{mappings}</p>}

            <RadioGroup
                className="flex flex-wrap gap-default"
                aria-labelledby={questionTextId}
                value={current?.answer ?? ''}
                // NOT gated on `saving`, deliberately. A note edit commits on
                // blur, and the blur that commits it is the SAME gesture as the
                // click on a radio: mousedown focuses the radio's <button>, the
                // textarea blurs, the save runs, `saving` flushes at the end of
                // that discrete event, the group re-renders disabled — and the
                // click never dispatches on a disabled button. The answer change
                // is dropped with no feedback, on a page whose entire job is
                // recording answers. The row's `opacity-60` is the in-flight
                // signal instead, and the PUT is an idempotent upsert, so a
                // second click landing on top of the first is safe.
                disabled={!canWrite}
                onValueChange={(value) =>
                    onSave(question.id, value as AnswerValue, current?.note ?? null)
                }
            >
                {ANSWER_VALUES.map((value) => (
                    <label
                        key={value}
                        className="flex cursor-pointer items-center gap-tight text-sm text-content-default"
                    >
                        <RadioGroupItem value={value} size="sm" />
                        {t(`agentDetail.risk.answer.${value}` as Parameters<typeof t>[0])}
                    </label>
                ))}
            </RadioGroup>

            {canWrite && current && (
                <QuestionNote
                    questionId={question.id}
                    answer={current.answer}
                    saved={current.note ?? ''}
                    saving={saving}
                    onSave={onSave}
                />
            )}
            {!canWrite && current?.note && (
                <p className="text-xs text-content-muted">{current.note}</p>
            )}
        </li>
    );
}

/**
 * The rationale behind one answer.
 *
 * Local state, committed on blur. Saving per keystroke would be a write and a
 * revalidation per character on a column the Epic B middleware encrypts; the
 * answer above it saves immediately because a radio click IS the commit.
 */
function QuestionNote({
    questionId,
    answer,
    saved,
    saving,
    onSave,
}: {
    questionId: string;
    answer: AnswerValue;
    saved: string;
    saving: boolean;
    onSave: (questionId: string, answer: AnswerValue, note: string | null) => void;
}) {
    const t = useTranslations('admin');
    const [open, setOpen] = useState(saved.trim() !== '');
    const [draft, setDraft] = useState(saved);

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                className="text-xs text-content-muted underline hover:text-content-default"
            >
                {t('agentDetail.risk.addNote')}
            </button>
        );
    }

    return (
        <FormField label={t('agentDetail.risk.noteLabel')}>
            <Textarea
                id={`agent-risk-note-${questionId}`}
                rows={2}
                maxLength={4000}
                value={draft}
                disabled={saving}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={() => {
                    if (draft !== saved) onSave(questionId, answer, draft.trim() || null);
                }}
            />
        </FormField>
    );
}
