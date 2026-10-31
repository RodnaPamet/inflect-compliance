'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/layout/PageHeader';
import { StatusBadge } from '@/components/ui/status-badge';
// The sanctioned heading, not an inline <hN className>: `typography-eradication`
// is a zero ratchet over app code, and level 3 is this scale's
// sub-section/panel step — which is what a card heading is.
import { Heading } from '@/components/ui/typography';
import { cardVariants } from '@/components/ui/card';
import { cn } from '@inflect/ui/lib/cn';
import { apiErrorMessage } from '@/lib/api-error';

/**
 * THE ASKING SURFACE (#3870).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE TOOL CALLS ARE ALWAYS VISIBLE, NOT BEHIND A DISCLOSURE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * M3 asks for this and it is the load-bearing decision on the page. An answer
 * from a model over a compliance workspace is only as good as what it read, and
 * a reader who cannot see that reads prose with no provenance. Putting the
 * calls behind a "details" toggle makes the default state the one without
 * evidence — so they sit beneath the answer, open, every time.
 *
 * An EMPTY list is rendered as its own statement rather than as nothing: a run
 * that consulted no records is the case most likely to be mistaken for an
 * answer, and the surface says so in words.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ANSWER IS TEXT. IT IS NEVER HTML.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Rendered as a JSX child, so React escapes it. There is no
 * `dangerouslySetInnerHTML` on this page and there must never be one: the
 * answer is model prose derived from tenant records, which is the least
 * trustworthy string on the screen. `whitespace-pre-wrap` gives it paragraphs
 * without giving it markup.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * POLLING STOPS ON ANYTHING IT DOES NOT RECOGNISE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `LIVE_STATUSES` is an allowlist of the states worth waiting on, not a list of
 * terminal ones — the same shape `run-concurrency.ts` uses server-side, and for
 * the same reason. A status added to the enum that this file has not been
 * taught STOPS the poll and shows what it has, where a terminal-allowlist would
 * poll forever on it. `EMPTY_CATALOGUE` (#3869) is precisely such a status, and
 * it arrived after this pattern was chosen.
 *
 * The poll is also bounded by a deadline, so a run that never settles — a dead
 * executor — ends in a stated timeout rather than an indefinite spinner.
 */

/** What one call the model made looks like on the wire. */
export interface AskToolCall {
    readonly seq: number;
    readonly tool: string | null;
    readonly outcome: string;
    readonly refusal: string | null;
    readonly guardVerdict: string | null;
}

export interface AskResult {
    readonly runId: string;
    readonly status: string;
    readonly answer: string | null;
    readonly model: string | null;
    readonly costTokens: number;
    readonly catalogueWasEmpty: boolean;
    readonly toolCalls: readonly AskToolCall[];
}

/** Worth waiting on. Anything else — known or not — settles the view. */
const LIVE_STATUSES = new Set(['RUNNING', 'AWAITING_APPROVAL', 'PAUSED']);

const POLL_MS = 1_500;
/**
 * A run that has not settled in roughly two minutes is reported, not awaited.
 *
 * Expressed as an ATTEMPT COUNT rather than a deadline, and that is not a
 * stylistic choice. A deadline means comparing against the wall clock, and
 * `hydration-clock-in-render` refuses a new client component that does —
 * `new Date()` or `Date.now()` in a client component differs between the SSR
 * pass and hydration, which is React error #418: invisible in development,
 * intermittent in production, and with a minified stack that names no
 * component.
 *
 * The comparison here was inside an async callback rather than a render body,
 * so it was not actually that hazard. But that guard is a DOWNWARD ratchet
 * whose own docstring says entries LEAVE its baseline as sites are migrated —
 * so exempting a new file was the wrong answer, and counting attempts needs no
 * clock at all.
 */
const POLL_MAX_ATTEMPTS = Math.ceil(120_000 / POLL_MS);

type Phase = 'idle' | 'running' | 'settled' | 'refused' | 'timedOut';

/** `CODE: detail`, the shape every refusal on this path takes. */
const REFUSAL_SHAPE = /^([A-Za-z][A-Za-z0-9_]*):\s*([\s\S]*)$/;

export function AskClient({ tenantSlug, maxChars }: { tenantSlug: string; maxChars: number }) {
    const t = useTranslations('agents.ask');
    // Run, step and guard vocabularies are the Agent runs page's, so a status
    // reads the same in both places (#4532, #4629).
    const tRuns = useTranslations('agents.runs');
    const [question, setQuestion] = useState('');
    const [phase, setPhase] = useState<Phase>('idle');
    const [result, setResult] = useState<AskResult | null>(null);
    const [refusal, setRefusal] = useState<string | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    /**
     * The LATEST `poll`, so the recursive tick does not capture the first one.
     *
     * `poll` schedules itself, which means referencing it inside its own
     * `useCallback` — and that captures the function as it was when the
     * closure was created. Its dependencies do not change during a run today,
     * so the stale closure is harmless NOW; that is a safety argument resting
     * on a fact nothing enforces, and the React Compiler's rule says so in as
     * many words: "prevents the earlier access from updating when this value
     * changes over time".
     *
     * A ref kept current in an effect removes the capture entirely rather than
     * arguing about when it would matter.
     */
    const pollRef = useRef<((runId: string, attempt: number) => Promise<void>) | null>(null);
    /** The run being waited on, so "Check again" can resume it after a timeout. */
    const [runId, setRunId] = useState<string | null>(null);

    /** A label from the runs vocabulary, or the code itself when it has none. */
    const runsLabel = useCallback(
        (group: string, code: string): string => {
            const key = `${group}.${code}`;
            return tRuns.has(key as Parameters<typeof tRuns.has>[0]) ? tRuns(key as Parameters<typeof tRuns>[0]) : code;
        },
        [tRuns],
    );

    /**
     * What a refusal says to the asker. The server's refusals are
     * `CODE: detail`, written for an operator — one names an environment
     * variable, another an agent id. A code this page knows is said in words
     * (#4629); for any other, the detail is shown without its code.
     */
    const refusalText = useCallback(
        (body: unknown): string => {
            const message = apiErrorMessage(body, t('refusedUnknown'));
            const m = REFUSAL_SHAPE.exec(message);
            if (!m) return message;
            const key = `refusal.${m[1]}`;
            if (t.has(key as Parameters<typeof t.has>[0])) return t(key as Parameters<typeof t>[0]);
            return m[2].trim() || t('refusedUnknown');
        },
        [t],
    );

    // Cleared on unmount so a pending poll cannot set state on a gone
    // component — and so navigating away actually stops the requests.
    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        [],
    );

    const tooLong = question.length > maxChars;
    const empty = question.trim() === '';

    const poll = useCallback(
        async (runId: string, attempt: number) => {
            const res = await fetch(`/api/t/${tenantSlug}/agents/questions/${runId}`);
            if (!res.ok) {
                const body: unknown = await res.json().catch(() => null);
                setRefusal(refusalText(body));
                setPhase('refused');
                return;
            }
            const next = (await res.json()) as AskResult;
            setResult(next);

            if (!LIVE_STATUSES.has(next.status)) {
                setPhase('settled');
                return;
            }
            if (attempt >= POLL_MAX_ATTEMPTS) {
                // The run is still live and we have stopped waiting. Said as a
                // timeout rather than left spinning: a spinner that never ends
                // is indistinguishable from a page that is broken. It used to
                // send the asker to the agent register, which an Editor or
                // Reader cannot open; the run id is kept instead, so "Check
                // again" resumes the same run (#4629).
                setPhase('timedOut');
                return;
            }
            timer.current = setTimeout(() => void pollRef.current?.(runId, attempt + 1), POLL_MS);
        },
        [tenantSlug, refusalText],
    );

    // In an effect, not during render: assigning a ref while rendering is its
    // own rule violation, and this is exactly what effects are for.
    useEffect(() => {
        pollRef.current = poll;
    }, [poll]);

    const submit = useCallback(async () => {
        setPhase('running');
        setResult(null);
        setRefusal(null);
        setRunId(null);
        const res = await fetch(`/api/t/${tenantSlug}/agents/questions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ question }),
        });
        if (!res.ok) {
            // THE NAMED REASON, shown as given. The server's refusals carry a
            // code and a sentence — "designate an agent", "lift the kill
            // switch", "ask a shorter question" — and flattening them into one
            // "something went wrong" is what makes a support request necessary.
            const body: unknown = await res.json().catch(() => null);
            setRefusal(refusalText(body));
            setPhase('refused');
            return;
        }
        const started = (await res.json()) as { runId: string };
        setRunId(started.runId);
        await poll(started.runId, 1);
    }, [tenantSlug, question, poll, refusalText]);

    /** Resume waiting on the run a timeout stopped watching. */
    const checkAgain = useCallback(async () => {
        if (!runId) return;
        setPhase('running');
        await poll(runId, 1);
    }, [runId, poll]);

    return (
        <div className="space-y-section">
            <PageHeader title={t('title')} description={t('description')} />

            <div className={cn(cardVariants(), 'space-y-default')}>
                <Textarea
                    id="agent-question"
                    aria-label={t('inputLabel')}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder={t('placeholder')}
                    rows={3}
                    disabled={phase === 'running'}
                    invalid={tooLong}
                    // The cap MIRRORED, not re-decided. The server enforces it
                    // and refuses over-length with a named code; this only
                    // saves the asker a round trip.
                    error={tooLong ? t('tooLong', { max: maxChars }) : undefined}
                    description={t('counter', { count: question.length, max: maxChars })}
                />
                {/*
                  * SECONDARY, and the reason is the ratchet's own rule rather
                  * than a judgement about this control. `primary-secondary-ratio`
                  * caps the absolute primary count and its history states the
                  * bargain in as many words: "the next primary still pays with a
                  * demotion". Raising the ceiling is not a sanctioned move, and
                  * reaching into an unrelated surface to demote somebody else's
                  * button to buy a slot here would be worse.
                  *
                  * The cost is small HERE specifically: primary emphasis exists
                  * to disambiguate among several actions, and this page has
                  * exactly one control. It is not competing with anything.
                  */}
                <Button
                    variant="secondary"
                    onClick={() => void submit()}
                    disabled={phase === 'running' || tooLong || empty}
                >
                    {phase === 'running' ? t('asking') : t('ask')}
                </Button>
            </div>

            {phase === 'refused' && refusal !== null && (
                <div className={cn(cardVariants())} role="alert">
                    <StatusBadge variant="error">{t('refusedBadge')}</StatusBadge>
                    {/* TEXT, like the answer. A refusal carries a server string. */}
                    <p className="mt-2 whitespace-pre-wrap text-sm text-content-default">{refusal}</p>
                </div>
            )}

            {/* For the whole wait, not only until the first status check: the
                first poll fills `result` with the RUNNING run, and gating on
                `result === null` left nothing on screen for up to two minutes
                but a disabled button (#4629). */}
            {phase === 'running' && (
                <EmptyState title={t('runningTitle')} description={t('runningDescription')} />
            )}

            {phase === 'timedOut' && (
                <div className={cn(cardVariants(), 'space-y-default')} role="status" data-testid="agent-ask-timed-out">
                    <p className="text-sm text-content-default">{t('timedOut')}</p>
                    <Button variant="secondary" size="sm" onClick={() => void checkAgain()}>
                        {t('checkAgain')}
                    </Button>
                </div>
            )}

            {phase === 'settled' && result !== null && (
                <div className="space-y-section">
                    {result.catalogueWasEmpty ? (
                        // NOT an answer. The run finished having consulted
                        // nothing, so whatever prose it produced is based on no
                        // data — rendering it as the answer would be the exact
                        // mistake #3869 exists to stop.
                        <EmptyState
                            title={t('emptyCatalogueTitle')}
                            description={t('emptyCatalogueDescription')}
                        />
                    ) : result.answer === null ? (
                        <EmptyState title={t('noAnswerTitle')} description={t('noAnswerDescription')} />
                    ) : (
                        <div className={cn(cardVariants())}>
                            <Heading level={3}>{t('answerHeading')}</Heading>
                            <p
                                id="agent-answer"
                                className="mt-2 whitespace-pre-wrap text-sm text-content-default"
                            >
                                {result.answer}
                            </p>
                        </div>
                    )}

                    <div className={cn(cardVariants(), 'space-y-default')}>
                        <Heading level={3}>{t('callsHeading')}</Heading>
                        {result.toolCalls.length === 0 ? (
                            // Stated, never blank. "Nothing was consulted" is a
                            // finding about the answer, not an absence of UI.
                            <p className="text-sm text-content-muted">{t('noCalls')}</p>
                        ) : (
                            <ol id="agent-tool-calls" className="space-y-tight">
                                {result.toolCalls.map((c) => (
                                    <li key={c.seq} className="flex flex-wrap items-center gap-tight text-sm">
                                        <span className="font-mono text-content-muted">{c.seq}</span>
                                        <span className="text-content-default">{c.tool ?? t('unnamedTool')}</span>
                                        <StatusBadge variant={c.outcome === 'DONE' ? 'success' : 'error'}>
                                            {runsLabel('detail.stepStatus', c.outcome)}
                                        </StatusBadge>
                                        {/* The refusal CODE the server chose to
                                            disclose — never an exception
                                            message, which it strips. */}
                                        {c.refusal !== null && (
                                            <span className="font-mono text-xs text-content-muted">{c.refusal}</span>
                                        )}
                                        {/* Every step records a verdict, CLEAN by
                                            default; only one the AI Guard
                                            raised is worth a warning. */}
                                        {c.guardVerdict !== null && c.guardVerdict !== 'CLEAN' && (
                                            <StatusBadge variant="warning">{runsLabel('detail.guard', c.guardVerdict)}</StatusBadge>
                                        )}
                                    </li>
                                ))}
                            </ol>
                        )}
                    </div>

                    <dl className="flex flex-wrap gap-section text-sm">
                        <div>
                            <dt className="text-content-muted">{t('model')}</dt>
                            {/* Null when nothing ran. Shown as such rather than
                                as the agent's declared model, which would state
                                a fact that did not happen. */}
                            <dd className="font-mono text-content-default">{result.model ?? t('noModel')}</dd>
                        </div>
                        <div>
                            <dt className="text-content-muted">{t('tokens')}</dt>
                            <dd className="font-mono tabular-nums text-content-default">{result.costTokens}</dd>
                        </div>
                        <div>
                            <dt className="text-content-muted">{t('status')}</dt>
                            <dd className="text-content-default">{runsLabel('status', result.status)}</dd>
                        </div>
                    </dl>
                </div>
            )}
        </div>
    );
}
