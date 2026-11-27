'use client';

/**
 * Sankey flow client island for /controls/sankey.
 *
 * Pure presentation: page-level header (back-to-controls link
 * + title) + the SankeyChart projection of the
 * `TraceabilityGraph` payload (Assets → Risks → Controls). No
 * graph view, no table view, no view-toggle — those were the
 * other two surfaces on the deprecated /traceability page.
 *
 * Search is preserved as a tenant-wide narrowing affordance so
 * the user can isolate flows around a specific entity. State is
 * ephemeral (no persistence) — the Sankey is a glance-and-leave
 * surface, not a long-running workspace.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { SankeyChart } from '@/components/ui/SankeyChart';
import type { TraceabilityGraph } from '@/lib/traceability-graph/types';
import { Heading } from '@/components/ui/typography';
import { InlineNotice } from '@/components/ui/inline-notice';
import { useContentText } from '@/lib/content-i18n/use-content-text';

export interface ControlsSankeyClientProps {
    initialGraph: TraceabilityGraph;
}

export function ControlsSankeyClient({
    initialGraph,
}: ControlsSankeyClientProps) {
    const t = useTranslations('controls');
    const tc = useContentText();
    // Node labels that can hold catalogue text, in the reader's language: a
    // risk's title, and a control's name (the label only when the control has
    // no code; with a code the label IS the code and the name is `secondary`).
    const graph = useMemo(
        () => ({
            ...initialGraph,
            nodes: initialGraph.nodes.map((n) =>
                n.kind === 'risk' || (n.kind === 'control' && n.secondary === null)
                    ? { ...n, label: tc(n.label) }
                    : n,
            ),
        }),
        [initialGraph, tc],
    );
    // R14-PR7 — standalone search input retired (the user's
    // directive: per-page searchbars die; users search via the
    // global command palette or page filters). For sankey
    // specifically, the input fed `searchQuery` to <SankeyChart>
    // which used it to dim non-matching nodes. The chart now
    // renders the full graph. If chart-level filtering becomes
    // load-bearing again, re-introduce via a dedicated chart-
    // control primitive — never via a bare `<input type="search">`.

    return (
        <div className="space-y-default" id="controls-sankey-page">
            {/* Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-compact">
                <div>
                    <Heading level={1} id="controls-sankey-heading">
                        {t('sankey.title')}
                    </Heading>
                    <p className="text-sm text-content-muted mt-1">
                        {t('sankey.subtitle')}
                    </p>
                </div>
            </div>

            {/* #4794 — the graph is capped per kind; a partial diagram must
                say it is partial rather than pass for the whole register. */}
            {initialGraph.meta?.truncated && (
                <InlineNotice variant="warning" id="controls-sankey-truncated">
                    {t('sankey.truncated', { cap: initialGraph.meta.nodeCap ?? 0 })}
                </InlineNotice>
            )}

            {/* Below `md` the chart itself lists the flows, after a notice
                that the diagram is drawn for a larger screen (owner
                decision, 2026-11-23; `SankeyFlowList`). */}
            <SankeyChart graph={graph} searchQuery="" />
        </div>
    );
}
