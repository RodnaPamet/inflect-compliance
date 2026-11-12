'use client';

/**
 * What a reviewer reads before approving a PROCESS_MAP proposal (#5053).
 *
 * ── THE LIST IS THE RECORD ──────────────────────────────────────────────
 *
 * Every step, numbered in the order it is stored, with its type, label and
 * subtitle; every arrow, named by the numbers and labels of its two ends;
 * the notes the server worked out (a step no arrow touches, a decision with
 * fewer than two ways out); and the fixed sentence saying what approval does.
 * Always rendered, never collapsed, and all of it plain React text: a label is
 * never markdown or HTML, so injected markup reads as the characters it is.
 * The step and arrow keys are rendering handles and are never shown.
 *
 * ── THE PICTURE IS A CONVENIENCE ────────────────────────────────────────
 *
 * Under the list, the same map drawn read-only on the process canvas, at the
 * boxes the server's layout gave each step, which are the boxes approval
 * creates the map at. The canvas module is loaded with `next/dynamic` and
 * `ssr: false`, so the editor adds nothing to a route's First Load JS and is
 * fetched only when a process-map proposal is on screen. A chunk that fails to
 * load, or an editor that throws, is REPLACED by a plain sentence saying so,
 * outside any image role or inert subtree, so assistive technology reads the
 * failure rather than a label for a picture that is not there; the list is
 * untouched. While the canvas renders, its frame is one labelled image to
 * assistive technology, inert, and takes no pointer input.
 */
import { Component, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';

import { StatusBadge } from '@/components/ui/status-badge';
import type { ProcessMapPreview } from '@/lib/agentic/process-map-proposal';

/** Stands in for a canvas chunk that did not load, so the boundary below shows the fallback. */
function CanvasChunkFailed(): never {
    throw new Error('the process canvas chunk failed to load');
}

function CanvasLoading() {
    return <div aria-hidden="true" className="h-full w-full animate-pulse bg-bg-subtle" />;
}

const ProposedProcessMapCanvas = dynamic(
    () =>
        import('@/components/processes/ProposedProcessMapCanvas')
            .then((m) => m.ProposedProcessMapCanvas)
            .catch(() => CanvasChunkFailed),
    { ssr: false, loading: CanvasLoading },
);

/**
 * Catches a canvas that fails to load or to render, and reports it, so the
 * parent replaces the whole frame (see `ProposedMapPicture`). The list is
 * outside it.
 */
class CanvasBoundary extends Component<{ onFailed: () => void; children: ReactNode }, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    componentDidCatch(): void {
        this.props.onFailed();
    }

    render(): ReactNode {
        return this.state.failed ? null : this.props.children;
    }
}

/**
 * The read-only picture, or the sentence that replaces it.
 *
 * The image role and `inert` belong to a canvas that actually rendered. A
 * failure is not drawn INSIDE that frame: an `inert` subtree is removed from
 * the accessibility tree and an image's children are presentational, so a
 * screen-reader user would hear the label of a picture that is not there and
 * never the sentence saying it failed.
 */
function ProposedMapPicture({ proposalId, preview }: { proposalId: string; preview: ProcessMapPreview }) {
    const t = useTranslations('agents');
    const [failed, setFailed] = useState(false);

    if (failed) {
        return (
            <p
                data-testid={`proposal-processmap-canvas-unavailable-${proposalId}`}
                className="rounded border border-border-subtle p-3 text-xs text-content-muted"
            >
                {t('proposals.processMap.canvasUnavailable')}
            </p>
        );
    }
    return (
        <figure
            data-testid={`proposal-processmap-canvas-${proposalId}`}
            role="img"
            aria-label={t('proposals.processMap.canvasLabel')}
            className="m-0 h-64 overflow-hidden rounded border border-border-subtle bg-bg-default"
        >
            <div inert className="pointer-events-none h-full w-full select-none">
                <CanvasBoundary onFailed={() => setFailed(true)}>
                    <ProposedProcessMapCanvas preview={preview} />
                </CanvasBoundary>
            </div>
        </figure>
    );
}

export function ProcessMapProposalPreview({
    proposalId,
    preview,
}: {
    proposalId: string;
    preview: ProcessMapPreview;
}) {
    const t = useTranslations('agents');
    const { isolatedSteps, decisionsWithFewerThanTwoExits } = preview.notes;
    const hasNotes = isolatedSteps.length > 0 || decisionsWithFewerThanTwoExits.length > 0;

    return (
        <section
            data-testid={`proposal-processmap-${proposalId}`}
            aria-label={t('proposals.processMap.heading')}
            className="space-y-default rounded border border-border-subtle p-3"
        >
            <div className="space-y-tight">
                <span className="block text-xs font-medium text-content-subtle">
                    {t('proposals.processMap.heading')}
                </span>
                <span
                    data-testid={`proposal-processmap-name-${proposalId}`}
                    className="block whitespace-pre-wrap break-words text-sm font-medium text-content-default"
                >
                    {preview.name}
                </span>
                {preview.description !== null && (
                    <span
                        data-testid={`proposal-processmap-description-${proposalId}`}
                        className="block whitespace-pre-wrap break-words text-sm text-content-muted"
                    >
                        {preview.description}
                    </span>
                )}
                <span
                    data-testid={`proposal-processmap-counts-${proposalId}`}
                    className="block text-xs text-content-subtle"
                >
                    {t('proposals.processMap.counts', {
                        steps: preview.steps.length,
                        arrows: preview.arrows.length,
                    })}
                </span>
            </div>

            <div className="space-y-tight">
                <span className="block text-xs font-medium text-content-subtle">
                    {t('proposals.processMap.stepsHeading')}
                </span>
                <ol data-testid={`proposal-processmap-steps-${proposalId}`} className="space-y-tight">
                    {preview.steps.map((s) => (
                        <li
                            key={s.key}
                            data-testid={`proposal-processmap-step-${proposalId}-${s.key}`}
                            data-step-type={s.nodeType}
                            className="flex items-start gap-tight text-sm"
                        >
                            <span className="shrink-0 tabular-nums text-content-subtle">{s.index}.</span>
                            <StatusBadge variant={s.nodeType === 'decision' ? 'warning' : 'neutral'}>
                                {s.nodeType === 'decision'
                                    ? t('proposals.processMap.stepType.decision')
                                    : t('proposals.processMap.stepType.processStep')}
                            </StatusBadge>
                            <span className="min-w-0">
                                <span className="block whitespace-pre-wrap break-words text-content-default">
                                    {s.label}
                                </span>
                                {s.subtitle !== null && (
                                    <span className="block whitespace-pre-wrap break-words text-xs text-content-muted">
                                        {s.subtitle}
                                    </span>
                                )}
                            </span>
                        </li>
                    ))}
                </ol>
            </div>

            <div className="space-y-tight">
                <span className="block text-xs font-medium text-content-subtle">
                    {t('proposals.processMap.arrowsHeading')}
                </span>
                {preview.arrows.length === 0 ? (
                    <p
                        data-testid={`proposal-processmap-no-arrows-${proposalId}`}
                        className="text-sm text-content-muted"
                    >
                        {t('proposals.processMap.noArrows')}
                    </p>
                ) : (
                    <ul data-testid={`proposal-processmap-arrows-${proposalId}`} className="space-y-tight">
                        {preview.arrows.map((a) => (
                            <li
                                key={a.key}
                                data-testid={`proposal-processmap-arrow-${proposalId}-${a.key}`}
                                className="text-sm text-content-default"
                            >
                                <span className="whitespace-pre-wrap break-words">
                                    <span className="tabular-nums text-content-subtle">{a.fromIndex}.</span>{' '}
                                    {a.fromLabel}{' '}
                                    {/* Spaces on both sides of the pair, so a screen
                                        reader hears "A leads to 2. B" rather than
                                        "Aleads to2. B": the glyph is hidden from it. */}
                                    <span aria-hidden="true" className="text-content-subtle">
                                        →
                                    </span>
                                    <span className="sr-only">{t('proposals.processMap.arrowTo')}</span>{' '}
                                    <span className="tabular-nums text-content-subtle">{a.toIndex}.</span>{' '}
                                    {a.toLabel}
                                </span>
                                {a.label !== null && (
                                    <span className="block whitespace-pre-wrap break-words text-xs text-content-muted">
                                        {t('proposals.processMap.arrowLabel')}: {a.label}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            {hasNotes && (
                <ul
                    data-testid={`proposal-processmap-notes-${proposalId}`}
                    className="space-y-tight rounded border border-border-subtle bg-bg-subtle p-2 text-xs text-content-muted"
                >
                    {isolatedSteps.map((n) => (
                        <li key={`isolated-${n}`}>{t('proposals.processMap.noteIsolated', { step: n })}</li>
                    ))}
                    {decisionsWithFewerThanTwoExits.map((n) => (
                        <li key={`decision-${n}`}>{t('proposals.processMap.noteDecisionExits', { step: n })}</li>
                    ))}
                </ul>
            )}

            <ProposedMapPicture proposalId={proposalId} preview={preview} />

            <p
                data-testid={`proposal-processmap-creates-${proposalId}`}
                className="text-xs text-content-subtle"
            >
                {t('proposals.processMap.createsDraft')}
            </p>
        </section>
    );
}
