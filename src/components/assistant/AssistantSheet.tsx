'use client';

/**
 * The conversation window (#3838, #3846-#3850).
 *
 * ═══ WHY `Sheet` AND NOT A HAND-ROLLED PANEL ═══
 *
 * Epic 54 forbids hand-rolling a `fixed inset-0 bg-black/...` overlay, and
 * `Sheet` is the documented answer for "inspect without losing context" —
 * which is the whole point here. The assistant must be able to answer "which
 * of THESE has no evidence" about the list already on screen, so the page
 * behind it has to stay rendered and stay where it was.
 *
 * It is a Vaul drawer: a right-side panel on desktop and a BOTTOM drawer on
 * mobile, which is the right motion from a bottom-right launcher.
 *
 * ═══ WHAT THIS COMPONENT REFUSES TO DO ═══
 *
 * It does not drive the UI (#3846). No navigation on the user's behalf, no
 * form filling, no clicking. Links are rendered for the user to follow. That
 * boundary is not only a UX stance — it is what keeps the assistant out of
 * the write path, and it is why a link here is an `<a>` the user activates
 * rather than a `router.push` the assistant performs.
 *
 * ═══ A CONVERSATION, NOT ONE TURN (#5054) ═══
 *
 * Each question stays on screen with its answer, and the next question carries
 * the earlier finished turns (windowed by `selectHistoryWindow`) so "now make
 * it a map" has something to refer to. The input is multi-line: a pasted
 * process keeps its line breaks, Enter sends and Shift+Enter starts a line.
 * Nothing the person types is ever cut; over the stated limit, Send is refused
 * with a sentence and the text stays where it is.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
// Nucleo, the canonical family. The tool-row icons are gone rather than
// substituted: Nucleo has no scissors or file-warning, and the rows already
// SAY "unavailable" and "partial result" — an icon beside that text was
// decoration carrying no information the label did not.
import { ArrowRight, TriangleWarning } from '@inflect/ui/components/ui/icons/nucleo';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { EmptyState } from '@/components/ui/empty-state';
import { Textarea } from '@/components/ui/textarea';
import { useEnterSubmit } from '@/components/ui/hooks';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';

import { isKnownAssistantRoute } from '@/app-layer/ai/assistant/nav-routes';
import { pathTokensIn } from '@/app-layer/ai/assistant/guidance';
// The CLIENT-SAFE limits module: it imports nothing, so the number the counter
// shows is the number the server schema enforces, with no server code shipped.
import { ASSISTANT_QUESTION_MAX_CHARS, selectHistoryWindow } from '@/app-layer/ai/assistant/limits';

import { useAssistantPageContext } from './assistant-page-context';
import {
    historyTurnOf,
    isHistoryEligible,
    useAssistantStream,
    type AssistantTurn,
} from './use-assistant-stream';

interface AssistantSheetProps {
    open: boolean;
    onClose: () => void;
    titleId: string;
}

/** The counter appears from here on, so a long paste is seen approaching the limit. */
const COUNTER_FROM = Math.floor(ASSISTANT_QUESTION_MAX_CHARS * 0.8);

/** The input grows with its text up to this height (`max-h-48`), then scrolls. */
const INPUT_MAX_HEIGHT_PX = 192;

export function AssistantSheet({ open, onClose, titleId }: AssistantSheetProps) {
    const t = useTranslations('assistant');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const pageContext = useAssistantPageContext();
    const { turns, busy, ask, cancel, reset } = useAssistantStream(apiUrl('assistant/stream'));
    const [question, setQuestion] = useState('');
    const formRef = useRef<HTMLFormElement>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const liveTurnRef = useRef<HTMLLIElement>(null);
    const inputId = useId();
    const hintId = useId();

    // What is sent is the TRIMMED text, so that is what is counted. Nothing is
    // ever cut: over the limit, the text stays in the box and Send is refused
    // with a sentence (#5054). That is also why the textarea has no
    // `maxLength`, which would silently truncate a paste.
    const length = question.trim().length;
    const tooLong = length > ASSISTANT_QUESTION_MAX_CHARS;
    const nearLimit = length >= COUNTER_FROM;

    // A touch keyboard has no Shift+Enter, so there Enter must stay a new line
    // and the Ask button sends. Read after mount (SSR has no pointer), and kept
    // current if the pointer changes, e.g. a tablet docked to a keyboard.
    const coarsePointer = useCoarsePointer();

    // The earlier turns that go with the next question, and how many no longer
    // fit. Computed from the transcript, so what is sent is what is on screen.
    const historyWindow = useMemo(
        () => selectHistoryWindow(turns.filter(isHistoryEligible).map(historyTurnOf)),
        [turns],
    );

    // Enter sends; Shift+Enter is left to the browser, which inserts the new
    // line; an open IME composition never sends. All three are the shared
    // hook's, which is why it is used rather than a keydown handler here.
    // `stopPropagation` keeps the Enter from the sheet and the shortcut registry.
    // Off on a touch keyboard, where Enter is the only way to start a line.
    const { handleKeyDown } = useEnterSubmit({
        formRef,
        modifier: 'always',
        stopPropagation: true,
        enabled: !coarsePointer,
    });

    const submit = useCallback(
        (e: React.FormEvent) => {
            e.preventDefault();
            const q = question.trim();
            if (q === '' || tooLong || busy) return;
            void ask({ question: q, pageContext, history: historyWindow.turns });
            // The question now lives in the transcript, so the box is cleared
            // for the follow-up.
            setQuestion('');
        },
        [ask, question, pageContext, historyWindow, tooLong, busy],
    );

    // Grow with the text, then scroll. Measured on every change of the text,
    // when the box MOUNTS (the drawer unmounts its content on close, so a
    // reopened sheet holding a long draft gets a fresh textarea), and when the
    // window is resized, since a narrower box wraps to more lines.
    const setInputRef = useCallback((el: HTMLTextAreaElement | null) => {
        inputRef.current = el;
        fitToContent(el);
    }, []);
    useLayoutEffect(() => {
        fitToContent(inputRef.current);
    }, [question]);
    useEffect(() => {
        const onResize = () => fitToContent(inputRef.current);
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // Keep the newest turn in view as the conversation grows.
    useEffect(() => {
        liveTurnRef.current?.scrollIntoView?.({ block: 'end' });
    }, [turns.length]);

    // When a turn ends, the input is usable again: put the cursor back in it,
    // but only if focus was LOST (the disabled box or the unmounted Stop button
    // dropped it). Somebody who moved to a link in an earlier answer while
    // this one streamed is left where they are.
    const wasBusy = useRef(false);
    useEffect(() => {
        if (wasBusy.current && !busy && focusWasLost(formRef.current)) inputRef.current?.focus();
        wasBusy.current = busy;
    }, [busy]);

    // "New conversation" unmounts itself (it shows only while there are
    // turns), so focus goes to the input rather than to nowhere.
    const startNewConversation = useCallback(() => {
        reset();
        inputRef.current?.focus();
    }, [reset]);

    return (
        <Sheet
            open={open}
            onOpenChange={(next) => {
                if (!next) {
                    // Closing mid-turn stops the stream. Leaving it running
                    // would keep spending tokens on an answer nobody will see.
                    // The conversation itself is kept for when it reopens.
                    cancel();
                    onClose();
                }
            }}
            // Escape and click-outside are Vaul's, which is one of the reasons
            // not to hand-roll this (#3839).
            title={t('title')}
            description={t('description')}
            data-testid="assistant-sheet"
        >
            <Sheet.Header>
                <Sheet.Title id={titleId}>{t('title')}</Sheet.Title>
                <Sheet.Description>{t('description')}</Sheet.Description>
            </Sheet.Header>

            <Sheet.Body>
                {turns.length === 0 ? (
                    <EmptyState
                        title={t('emptyTitle')}
                        description={t('emptyDescription')}
                        data-testid="assistant-empty"
                    />
                ) : (
                    <ol aria-label={t('conversationLabel')} className="flex flex-col gap-section">
                        {turns.map((turn, i) => (
                            <li
                                key={turn.id}
                                ref={i === turns.length - 1 ? liveTurnRef : undefined}
                                data-testid="assistant-turn"
                            >
                                <AssistantTurnView turn={turn} tenantHref={tenantHref} />
                            </li>
                        ))}
                    </ol>
                )}
            </Sheet.Body>

            <Sheet.Footer>
                <form ref={formRef} className="flex w-full flex-col gap-tight" onSubmit={submit}>
                    {/* Epic 55's Textarea, labelled for screen readers only, as
                        the single-line input was. Its `error` slot is a live
                        role="alert", so the over-limit sentence is announced,
                        and it is CONSTANT while the question stays over the
                        limit: a sentence carrying the running count would be
                        read out again on every keystroke. The count lives in
                        the hint below, which is not live. */}
                    <Textarea
                        ref={setInputRef}
                        id={inputId}
                        aria-label={t('questionLabel')}
                        aria-describedby={hintId}
                        data-testid="assistant-input"
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={t('questionPlaceholder')}
                        enterKeyHint={coarsePointer ? 'enter' : 'send'}
                        rows={2}
                        disabled={busy}
                        className="max-h-48 resize-none overflow-y-auto"
                        error={tooLong ? t('questionTooLong', { max: ASSISTANT_QUESTION_MAX_CHARS }) : undefined}
                    />
                    <p id={hintId} className="text-xs text-content-muted" data-testid="assistant-input-hint">
                        {nearLimit
                            ? t('questionCounter', { count: length, max: ASSISTANT_QUESTION_MAX_CHARS })
                            : coarsePointer
                              ? t('questionHintTouch')
                              : t('questionHint')}
                    </p>
                    <div className="flex items-center justify-end gap-tight">
                        {historyWindow.dropped > 0 ? (
                            <p
                                className="mr-auto text-xs text-content-muted"
                                data-testid="assistant-history-trimmed"
                            >
                                {t('historyTrimmed')}
                            </p>
                        ) : null}
                        {turns.length > 0 && !busy ? (
                            <Button type="button" variant="secondary" onClick={startNewConversation}>
                                {t('newConversation')}
                            </Button>
                        ) : null}
                        {busy ? (
                            <Button type="button" variant="secondary" onClick={cancel}>
                                {t('cancel')}
                            </Button>
                        ) : (
                            <Button type="submit" variant="primary" disabled={length === 0 || tooLong}>
                                {t('send')}
                            </Button>
                        )}
                    </div>
                </form>
            </Sheet.Footer>
        </Sheet>
    );
}

/**
 * Size the box to its text, up to {@link INPUT_MAX_HEIGHT_PX}, then scroll.
 * Measured from `auto` so it also shrinks when text is deleted. A zero
 * `scrollHeight` means there is no layout (a test environment), and the box
 * keeps its `rows`.
 */
function fitToContent(el: HTMLTextAreaElement | null): void {
    if (el === null) return;
    el.style.height = 'auto';
    if (el.scrollHeight === 0) {
        el.style.height = '';
        return;
    }
    const borders = el.offsetHeight - el.clientHeight;
    el.style.height = `${Math.min(el.scrollHeight + borders, INPUT_MAX_HEIGHT_PX)}px`;
}

/**
 * Focus is nowhere a person put it: on nothing, on the page body, on a wrapper
 * around the form (the drawer moves focus to its own container when the
 * focused Stop button is removed), or still inside the form itself.
 */
function focusWasLost(form: HTMLFormElement | null): boolean {
    const active = document.activeElement;
    if (active === null || form === null) return true;
    return active.contains(form) || form.contains(active);
}

const COARSE_POINTER = '(pointer: coarse)';

function subscribeCoarsePointer(onChange: () => void): () => void {
    if (typeof window.matchMedia !== 'function') return () => undefined;
    const query = window.matchMedia(COARSE_POINTER);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
}

/** Is the primary pointer a finger? False on the server, and where `matchMedia` is missing. */
function useCoarsePointer(): boolean {
    return useSyncExternalStore(
        subscribeCoarsePointer,
        () => typeof window.matchMedia === 'function' && window.matchMedia(COARSE_POINTER).matches,
        () => false,
    );
}

/** One question and everything that came back for it. */
function AssistantTurnView({
    turn,
    tenantHref,
}: {
    turn: AssistantTurn;
    tenantHref: (path: string) => string;
}) {
    const t = useTranslations('assistant');
    const state = turn.state;
    const live = state.phase !== 'idle' && state.phase !== 'done';

    return (
        <div className="flex flex-col gap-default">
            {/* ── THE QUESTION, AS TYPED (#5054) ──
                React text with `whitespace-pre-wrap`, so a pasted process
                keeps its line breaks and markup in it is shown, not run. */}
            <div
                className="rounded-md border border-border-subtle bg-bg-subtle p-3"
                data-testid="assistant-question"
            >
                <p className="sr-only">{t('youAsked')}</p>
                <p className="whitespace-pre-wrap break-words text-sm text-content-emphasis">
                    {turn.question}
                </p>
            </div>

            {/* ── WHAT IT IS DOING (#3848) ──
                A silent pause reads as a hang, so the phase is always on
                screen while the turn is live, and a tool call is NAMED rather
                than reduced to a spinner. */}
            {live ? (
                <p className="text-sm text-content-muted" aria-live="polite" data-testid="assistant-phase">
                    {state.callingTool !== null
                        ? t('phaseCalling', { tool: state.callingTool })
                        : state.phase === 'answering'
                          ? t('phaseAnswering')
                          : t('phaseThinking')}
                </p>
            ) : null}

            {state.calls.length > 0 ? (
                <ul className="flex flex-col gap-1 text-xs text-content-subtle" data-testid="assistant-calls">
                    {state.calls.map((call, i) => (
                        <li key={`${call.name}-${i}`} className="flex items-center gap-1.5">
                            <span>
                                {!call.ok
                                    ? t('toolFailed', { tool: call.name })
                                    : call.truncated
                                      ? t('toolTruncated', { tool: call.name })
                                      : call.name}
                            </span>
                        </li>
                    ))}
                </ul>
            ) : null}

            {/* ── A REFUSAL SHOWS ITS REASON (#3849) ──
                Rendered as its own block with the reason, never as a blank
                answer or a generic error: a refusal the user cannot account
                for reads as a malfunction, and they retry, which spends again. */}
            {state.refusal !== null ? (
                <div
                    className="flex flex-col gap-1 rounded-md border border-border-subtle bg-bg-muted p-3"
                    data-testid="assistant-refusal"
                >
                    <p className="flex items-center gap-1.5 text-sm font-medium text-content-emphasis">
                        <TriangleWarning className="h-4 w-4" aria-hidden="true" />
                        {t('refusalTitle')}
                    </p>
                    <p className="text-sm text-content-default">{state.refusal}</p>
                </div>
            ) : null}

            {state.answer !== null ? (
                <div className="flex flex-col gap-compact" data-testid="assistant-answer">
                    <p className="whitespace-pre-wrap break-words text-sm text-content-default">
                        {state.answer}
                    </p>

                    {/* ── TRUNCATION IS LABELLED (#3850) ──
                        Beside the answer, not only in the call list: a total
                        computed from a partial set is wrong, and the reader of
                        the sentence is the one who needs to know. */}
                    {state.truncatedAny ? (
                        <p
                            className="rounded-md border border-border-subtle bg-bg-subtle p-2 text-xs text-content-muted"
                            data-testid="assistant-truncated"
                        >
                            {t('truncatedNotice')}
                        </p>
                    ) : null}

                    {/* ── A QUARANTINED PROPOSAL IS NEVER "QUEUED" (#3847) ──
                        The server's prose already says this, and the UI must
                        not undo it. Keyed on the STATUS rather than on the
                        presence of a proposal: "we have a proposal" and "it
                        reached the queue" are different facts. Anything that is
                        not explicitly QUARANTINED still has to EARN the queued
                        label, so the check is for the pending state by name
                        and not a negation. An earlier turn keeps its label as
                        the conversation scrolls. */}
                    {state.proposal !== null ? (
                        state.proposal.status === 'PENDING' ? (
                            <div
                                className="flex flex-col gap-1 rounded-md border border-border-subtle bg-bg-subtle p-3"
                                data-testid="assistant-proposal-queued"
                            >
                                <p className="text-sm font-medium text-content-emphasis">{t('proposalQueued')}</p>
                                <p className="text-xs text-content-muted">{t('proposalQueuedDescription')}</p>
                                {/* A PRODUCT-authored link, not one derived from
                                    model text — so it does not go through the
                                    nav route table, which exists to constrain
                                    what the MODEL may name. `/agents/proposals`
                                    is the real queue; `/agent-proposals` is a
                                    redirect shim. */}
                                <a
                                    href={tenantHref('/agents/proposals')}
                                    className="inline-flex items-center gap-1 text-xs text-content-default underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                                >
                                    {t('openReviewQueue')}
                                    <ArrowRight className="h-3 w-3" aria-hidden="true" />
                                </a>
                            </div>
                        ) : (
                            <div
                                className="flex flex-col gap-1 rounded-md border border-border-subtle bg-bg-muted p-3"
                                data-testid="assistant-proposal-quarantined"
                            >
                                <p className="text-sm font-medium text-content-emphasis">
                                    {t('proposalQuarantined')}
                                </p>
                                <p className="text-xs text-content-muted">{t('proposalQuarantinedDescription')}</p>
                                {/* No link to the review queue. It is not
                                    there, and offering the link would imply it
                                    is. */}
                            </div>
                        )
                    ) : null}

                    {/* ── DEEP LINKS, NOT NAVIGATION (#3844, #3846) ──
                        An anchor the user activates. Built with `tenantHref`
                        so the slug is never hand-assembled. */}
                    <AssistantDeepLinks
                        answer={state.answer}
                        tenantHref={tenantHref}
                        label={(page) => t('openPage', { page })}
                    />
                </div>
            ) : null}

            {state.halt !== null ? (
                <p className="text-xs text-content-muted" data-testid="assistant-halt">
                    {t('haltTitle')} — {state.halt}
                </p>
            ) : null}

            {state.stopped ? (
                <p className="text-xs text-content-muted" data-testid="assistant-stopped">
                    {t('stopped')}
                </p>
            ) : null}

            {/* An ERROR is a transport failure and is NOT dressed up as a
                refusal. The two have different causes and different remedies,
                and collapsing them would make "try again" the advice for a
                governance decision. */}
            {state.error !== null ? (
                <div
                    className="flex flex-col gap-1 rounded-md border border-border-danger bg-bg-muted p-3"
                    data-testid="assistant-error"
                >
                    <p className="text-sm font-medium text-content-emphasis">{t('errorTitle')}</p>
                    <p className="text-sm text-content-default">{state.error}</p>
                </div>
            ) : null}

            {state.connectionClosed ? (
                <div
                    className="flex flex-col gap-1 rounded-md border border-border-danger bg-bg-muted p-3"
                    data-testid="assistant-error"
                >
                    <p className="text-sm font-medium text-content-emphasis">{t('errorTitle')}</p>
                    <p className="text-sm text-content-default">{t('connectionClosed')}</p>
                </div>
            ) : null}
        </div>
    );
}

/**
 * Render a link for each nav route the answer names.
 *
 * The answer has ALREADY been checked server-side — an answer naming a route
 * the nav cannot vouch for is replaced with a refusal before it is streamed
 * (`checkGuidanceRoutes`). This re-derives the links from the text rather
 * than trusting a separate list, so a link can only ever point at something
 * the sentence beside it actually mentions.
 */
function AssistantDeepLinks({
    answer,
    tenantHref,
    label,
}: {
    answer: string;
    tenantHref: (path: string) => string;
    label: (page: string) => string;
}) {
    const routes = extractLinkableRoutes(answer);
    if (routes.length === 0) return null;

    return (
        <ul className="flex flex-wrap gap-tight" data-testid="assistant-links">
            {routes.map((route) => (
                <li key={route}>
                    <a
                        href={tenantHref(route)}
                        className="inline-flex items-center gap-1 rounded-md border border-border-subtle px-2 py-1 text-xs text-content-default hover:bg-bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                    >
                        {label(route)}
                        <ArrowRight className="h-3 w-3" aria-hidden="true" />
                    </a>
                </li>
            ))}
        </ul>
    );
}

/**
 * Routes mentioned in the answer, deduplicated and in first-mention order.
 *
 * Imported from the server module so the client cannot develop its own idea
 * of which routes exist — one table, two readers.
 */
function extractLinkableRoutes(answer: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const token of pathTokensIn(answer)) {
        if (isKnownAssistantRoute(token) && !seen.has(token)) {
            seen.add(token);
            out.push(token);
        }
    }
    return out;
}

/*
 * BORDER TONE — subtle, not default.
 *
 * The policy in `tests/guards/border-tone-budget.test.ts` reserves the STRONG
 * tone for "surfaces that need explicit containment: card outer border, table
 * outer border, modal/sheet boundary" and makes the quiet one the default for
 * "quiet panel boundaries" and form-field outlines, with the tie-break
 * written down: if you have to ask which, the answer is the quiet one.
 *
 * (The strong class name is deliberately not written out here: a comment
 * naming it is a scar the counting guard would read as a live use.)
 *
 * Every bordered block in this file sits INSIDE the sheet — the sheet is the
 * discrete surface, and these are panels within it. So `subtle` is not a
 * concession to the budget, it is the tone the policy actually specifies.
 */
