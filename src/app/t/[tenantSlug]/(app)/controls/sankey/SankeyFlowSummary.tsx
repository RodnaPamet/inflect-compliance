'use client';

/**
 * The Sankey's flows as a list, for a phone (owner decision, 2026-11-23:
 * "notice plus a summary list" for desktop-shaped surfaces).
 *
 * Below `md` the chart's labels shrink to a few pixels and its bars to a
 * few pixels of tap target, so the page shows this instead: a notice that
 * the diagram is drawn for a larger screen, then every flow the diagram
 * draws, band by band (Assets → Risks, Risks → Controls, Controls →
 * Requirements). Within a band the flows are grouped by their source, and
 * each source and target links to its own page.
 *
 * It reads the same projection as the chart (`buildSankeyDataset`, no
 * search), so the two cannot disagree about which flows exist: a link the
 * chart draws is a row here, and two edges between the same pair are one
 * row with a count.
 */

import Link from 'next/link';
import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { cn } from '@inflect/ui/lib/cn';
import { cardVariants } from '@/components/ui/card';
import { InlineNotice } from '@/components/ui/inline-notice';
import { Heading } from '@/components/ui/typography';
import { buildSankeyDataset, type SankeyNode } from '@/lib/traceability-graph/sankey';
import type { TraceabilityGraph, TraceabilityNodeKind } from '@/lib/traceability-graph/types';

export interface SankeyFlowBand {
    key: string;
    sourceKind: TraceabilityNodeKind;
    targetKind: TraceabilityNodeKind;
    /** Every flow in the band, counted per edge (the chart's link count). */
    flowCount: number;
    sources: Array<{
        node: SankeyNode;
        targets: Array<{ node: SankeyNode; count: number }>;
    }>;
}

/**
 * Groups the dataset's links by band, then by source, then by target.
 * Bands follow the chart's column order; sources and targets keep the
 * order the chart stacks them in.
 */
export function sankeyFlowBands(graph: TraceabilityGraph): SankeyFlowBand[] {
    const dataset = buildSankeyDataset(graph);
    const nodeById = new Map(dataset.nodes.map((n) => [n.id, n]));
    const order = new Map(dataset.nodes.map((n, i) => [n.id, i]));
    const bands = new Map<string, SankeyFlowBand & { bySource: Map<string, Map<string, number>> }>();

    for (const link of dataset.links) {
        const src = nodeById.get(link.source);
        const tgt = nodeById.get(link.target);
        if (!src || !tgt) continue;
        const key = `${src.columnIndex}-${tgt.columnIndex}`;
        let band = bands.get(key);
        if (!band) {
            band = { key, sourceKind: src.kind, targetKind: tgt.kind, flowCount: 0, sources: [], bySource: new Map() };
            bands.set(key, band);
        }
        band.flowCount += link.value;
        const targets = band.bySource.get(src.id) ?? new Map<string, number>();
        targets.set(tgt.id, (targets.get(tgt.id) ?? 0) + link.value);
        band.bySource.set(src.id, targets);
    }

    const byOrder = (a: string, b: string) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
    return [...bands.values()]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map(({ bySource, ...band }) => ({
            ...band,
            sources: [...bySource.keys()].sort(byOrder).map((sourceId) => {
                const targets = bySource.get(sourceId)!;
                return {
                    node: nodeById.get(sourceId)!,
                    targets: [...targets.keys()].sort(byOrder).map((targetId) => ({
                        node: nodeById.get(targetId)!,
                        count: targets.get(targetId)!,
                    })),
                };
            }),
        }));
}

/** A node's name, as a link to its page when it has one. */
function NodeLink({ node, className }: { node: SankeyNode; className?: string }) {
    const body = <span className="min-w-0 break-words">{node.label}</span>;
    const base = cn('flex min-h-11 items-center', className);
    return node.href ? (
        <Link href={node.href} className={cn(base, 'hover:underline')}>
            {body}
        </Link>
    ) : (
        <span className={base}>{body}</span>
    );
}

export function SankeyFlowSummary({ graph, className }: { graph: TraceabilityGraph; className?: string }) {
    const t = useTranslations('controls');
    const tUi = useTranslations('common.ui');
    const bands = useMemo(() => sankeyFlowBands(graph), [graph]);
    const kindLabel = (kind: TraceabilityNodeKind) => tUi(`sankeyColumn.${kind}` as Parameters<typeof tUi>[0]);

    return (
        <div className={cn('space-y-default', className)} id="controls-sankey-summary" data-testid="sankey-flow-summary">
            <InlineNotice variant="info" id="controls-sankey-larger-screen">
                {t('sankey.phone.notice')}
            </InlineNotice>
            {bands.length === 0 ? (
                <p className={cn(cardVariants({ density: 'compact' }), 'text-center text-sm text-content-subtle')}>
                    {graph.nodes.length === 0 ? tUi('sankeyEmpty') : tUi('sankeyNoLinks')}
                </p>
            ) : (
                bands.map((band) => {
                    const heading = `${kindLabel(band.sourceKind)} → ${kindLabel(band.targetKind)}`;
                    return (
                        <section
                            key={band.key}
                            className={cn(cardVariants({ density: 'compact' }), 'space-y-tight')}
                            aria-label={heading}
                            data-sankey-band={`${band.sourceKind}-${band.targetKind}`}
                        >
                            <div className="flex flex-wrap items-baseline justify-between gap-tight">
                                <Heading level={2}>{heading}</Heading>
                                <span className="text-xs text-content-muted tabular-nums">
                                    {t('sankey.phone.flowCount', { count: band.flowCount })}
                                </span>
                            </div>
                            <ul className="divide-y divide-border-subtle">
                                {band.sources.map(({ node, targets }) => (
                                    <li key={node.id} className="py-tight" data-sankey-source={node.id}>
                                        <NodeLink node={node} className="text-sm font-medium text-content-emphasis" />
                                        <ul
                                            className="border-l border-border-subtle pl-3"
                                            aria-label={t('sankey.phone.targetsAria', { name: node.label })}
                                        >
                                            {targets.map(({ node: target, count }) => (
                                                <li
                                                    key={target.id}
                                                    className="flex items-center gap-tight text-sm text-content-default"
                                                    data-sankey-flow={`${node.id}->${target.id}`}
                                                >
                                                    <span aria-hidden className="text-content-subtle">→</span>
                                                    <NodeLink node={target} className="flex-1" />
                                                    {count > 1 && (
                                                        <span className="shrink-0 text-xs text-content-muted tabular-nums">
                                                            ×{count}
                                                        </span>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    );
                })
            )}
        </div>
    );
}
