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
 */

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
// Nucleo, the canonical family. The tool-row icons are gone rather than
// substituted: Nucleo has no scissors or file-warning, and the rows already
// SAY "unavailable" and "partial result" — an icon beside that text was
// decoration carrying no information the label did not.
import { ArrowRight, TriangleWarning } from '@inflect/ui/components/ui/icons/nucleo';

import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { EmptyState } from '@/components/ui/empty-state';
import { useTenantApiUrl, useTenantHref } from '@/lib/tenant-context-provider';

import { isKnownAssistantRoute } from '@/app-layer/ai/assistant/nav-routes';
import { pathTokensIn } from '@/app-layer/ai/assistant/guidance';

import { useAssistantPageContext } from './assistant-page-context';
import { useAssistantStream } from './use-assistant-stream';

interface AssistantSheetProps {
    open: boolean;
    onClose: () => void;
    titleId: string;
}

export function AssistantSheet({ open, onClose, titleId }: AssistantSheetProps) {
    const t = useTranslations('assistant');
    const apiUrl = useTenantApiUrl();
    const tenantHref = useTenantHref();
    const pageContext = useAssistantPageContext();
    const { state, ask, cancel, reset } = useAssistantStream(apiUrl('assistant/stream'));
    const [question, setQuestion] = useState('');

    const submit = useCallback(
        (e: React.FormEvent) => {
            e.preventDefault();
            const q = question.trim();
            if (q === '') return;
            void ask({ question: q, pageContext });
        },
        [ask, question, pageContext],
    );

    const askAgain = useCallback(() => {
        reset();
        setQuestion('');
    }, [reset]);

    const busy = state.phase !== 'idle' && state.phase !== 'done';

    return (
        <Sheet
            open={open}
            onOpenChange={(next) => {
                if (!next) {
                    // Closing mid-turn aborts the stream. Leaving it running
                    // would keep spending tokens on an answer nobody will see.
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
                {state.phase === 'idle' ? (
                    <EmptyState
                        title={t('emptyTitle')}
                        description={t('emptyDescription')}
                        data-testid="assistant-empty"
                    />
                ) : (
                    <div className="flex flex-col gap-default">
                        {/* ── WHAT IT IS DOING (#3848) ──
                            A silent pause reads as a hang, so the phase is
                            always on screen while the turn is live, and a tool
                            call is NAMED rather than reduced to a spinner. */}
                        {busy ? (
                            <p
                                className="text-sm text-content-muted"
                                aria-live="polite"
                                data-testid="assistant-phase"
                            >
                                {state.callingTool !== null
                                    ? t('phaseCalling', { tool: state.callingTool })
                                    : state.phase === 'answering'
                                      ? t('phaseAnswering')
                                      : t('phaseThinking')}
                            </p>
                        ) : null}

                        {state.calls.length > 0 ? (
                            <ul
                                className="flex flex-col gap-1 text-xs text-content-subtle"
                                data-testid="assistant-calls"
                            >
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
                            Rendered as its own block with the reason, never as
                            a blank answer or a generic error: a refusal the
                            user cannot account for reads as a malfunction, and
                            they retry, which spends again. */}
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
                                <p className="whitespace-pre-wrap text-sm text-content-default">
                                    {state.answer}
                                </p>

                                {/* ── TRUNCATION IS LABELLED (#3850) ──
                                    Beside the answer, not only in the call
                                    list: a total computed from a partial set
                                    is wrong, and the reader of the sentence is
                                    the one who needs to know. */}
                                {state.truncatedAny ? (
                                    <p
                                        className="rounded-md border border-border-subtle bg-bg-subtle p-2 text-xs text-content-muted"
                                        data-testid="assistant-truncated"
                                    >
                                        {t('truncatedNotice')}
                                    </p>
                                ) : null}

                                {/* ── DEEP LINKS, NOT NAVIGATION (#3844, #3846) ──
                                    An anchor the user activates. Built with
                                    `tenantHref` so the slug is never
                                    hand-assembled. */}
                                {/* ── A QUARANTINED PROPOSAL IS NEVER "QUEUED" (#3847) ──
                                    The server's prose already says this, and
                                    the UI must not undo it. Keyed on the
                                    STATUS rather than on the presence of a
                                    proposal: "we have a proposal" and "it
                                    reached the queue" are different facts,
                                    and treating the first as the second is
                                    precisely the error. Anything that is not
                                    explicitly QUARANTINED still has to EARN
                                    the queued label, so the check is for the
                                    pending state by name and not a negation. */}
                                {state.proposal !== null ? (
                                    state.proposal.status === 'PENDING' ? (
                                        <div
                                            className="flex flex-col gap-1 rounded-md border border-border-subtle bg-bg-subtle p-3"
                                            data-testid="assistant-proposal-queued"
                                        >
                                            <p className="text-sm font-medium text-content-emphasis">
                                                {t('proposalQueued')}
                                            </p>
                                            <p className="text-xs text-content-muted">
                                                {t('proposalQueuedDescription')}
                                            </p>
                                            {/* A PRODUCT-authored link, not one
                                                derived from model text — so it
                                                does not go through the nav
                                                route table, which exists to
                                                constrain what the MODEL may
                                                name. `/agents/proposals` is
                                                the real queue;
                                                `/agent-proposals` is a
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
                                            <p className="text-xs text-content-muted">
                                                {t('proposalQuarantinedDescription')}
                                            </p>
                                            {/* No link to the review queue. It
                                                is not there, and offering the
                                                link would imply it is. */}
                                        </div>
                                    )
                                ) : null}

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

                        {/* An ERROR is a transport failure and is NOT dressed up
                            as a refusal. The two have different causes and
                            different remedies, and collapsing them would make
                            "try again" the advice for a governance decision. */}
                        {state.error !== null ? (
                            <div
                                className="flex flex-col gap-1 rounded-md border border-border-danger bg-bg-muted p-3"
                                data-testid="assistant-error"
                            >
                                <p className="text-sm font-medium text-content-emphasis">
                                    {t('errorTitle')}
                                </p>
                                <p className="text-sm text-content-default">{state.error}</p>
                            </div>
                        ) : null}
                    </div>
                )}
            </Sheet.Body>

            <Sheet.Footer>
                {state.phase === 'done' ? (
                    <Button type="button" variant="secondary" onClick={askAgain}>
                        {t('newQuestion')}
                    </Button>
                ) : (
                    <form className="flex w-full items-end gap-tight" onSubmit={submit}>
                        <label className="flex-1">
                            <span className="sr-only">{t('questionLabel')}</span>
                            <input
                                type="text"
                                value={question}
                                onChange={(e) => setQuestion(e.target.value)}
                                placeholder={t('questionPlaceholder')}
                                disabled={busy}
                                data-testid="assistant-input"
                                className="w-full rounded-md border border-border-subtle bg-bg-default px-3 py-2 text-sm text-content-default placeholder:text-content-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
                            />
                        </label>
                        {busy ? (
                            <Button type="button" variant="secondary" onClick={cancel}>
                                {t('cancel')}
                            </Button>
                        ) : (
                            <Button type="submit" variant="primary" disabled={question.trim() === ''}>
                                {t('send')}
                            </Button>
                        )}
                    </form>
                )}
            </Sheet.Footer>
        </Sheet>
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
