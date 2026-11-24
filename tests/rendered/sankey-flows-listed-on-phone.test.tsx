/**
 * On a phone the Sankey lists every flow it draws, after a notice that the
 * diagram is drawn for a larger screen.
 *
 * Below `md` the chart's labels and bars are a few pixels. The chart itself
 * makes the switch, so no page can put the diagram on a phone without the
 * list. It is CSS (the list is `md:hidden`, the chart `hidden md:block`), so
 * this reads those classes, and holds the list to the chart's own dataset:
 * every link the chart would draw is a row here, and each end links to its
 * record.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';

import { ControlsSankeyClient } from '@/app/t/[tenantSlug]/(app)/controls/sankey/ControlsSankeyClient';
import { SankeyChart, sankeyFlowBands } from '@/components/ui/SankeyChart';
import { buildSankeyDataset } from '@/lib/traceability-graph/sankey';
import type { TraceabilityEdge, TraceabilityGraph, TraceabilityNode } from '@/lib/traceability-graph/types';

const en = require('../../messages/en.json');

function node(id: string, kind: TraceabilityNode['kind'], href: string | null = `/t/acme/${kind}s/${id}`): TraceabilityNode {
    return { id, kind, label: `Name of ${id}`, secondary: null, badge: null, href };
}
function edge(id: string, source: string, target: string, relation: TraceabilityEdge['relation']): TraceabilityEdge {
    return { id, source, target, relation, qualifier: null };
}

const GRAPH: TraceabilityGraph = {
    nodes: [
        node('a1', 'asset'), node('a2', 'asset'),
        node('r1', 'risk'), node('r2', 'risk'),
        node('c1', 'control'), node('q1', 'requirement', null),
        node('p1', 'policy'),
    ],
    edges: [
        edge('e1', 'a1', 'r1', 'exposes'),
        edge('e2', 'a1', 'r2', 'exposes'),
        edge('e3', 'a2', 'r1', 'exposes'),
        // Stored the other way round; the chart flips it, and so must the list.
        edge('e4', 'c1', 'r1', 'mitigates'),
        edge('e5', 'r2', 'c1', 'mitigates'),
        edge('e6', 'c1', 'q1', 'implements'),
        // Two edges between one pair: one row, counted twice.
        edge('e7', 'c1', 'q1', 'implements'),
        // A policy has no column in the chart, so none here either.
        edge('e8', 'p1', 'c1', 'governs'),
    ],
    categories: [],
    meta: { truncated: false, droppedNodeCount: 0, nodeCap: null, appliedFilters: {} },
} as TraceabilityGraph;

describe('the Sankey on a phone', () => {
    it('shows the list below md and the chart from md up', () => {
        render(<ControlsSankeyClient initialGraph={GRAPH} />);
        const summary = screen.getByTestId('sankey-flow-summary');
        expect(summary.className).toContain('md:hidden');
        const chart = screen.getByTestId('sankey-chart-desktop');
        expect(chart.className).toContain('hidden');
        expect(chart.className).toContain('md:block');
        expect(within(chart).getByRole('img')).toBeInTheDocument();
        expect(within(summary).getByText(en.common.ui.sankeyPhone.notice)).toBeInTheDocument();
    });

    it('lists every flow the chart draws, once per pair, in the chart direction', () => {
        render(<ControlsSankeyClient initialGraph={GRAPH} />);
        const summary = screen.getByTestId('sankey-flow-summary');
        const rows = Array.from(summary.querySelectorAll('[data-sankey-flow]')).map((el) => el.getAttribute('data-sankey-flow'));
        const expected = [...new Set(buildSankeyDataset(GRAPH).links.map((l) => `${l.source}->${l.target}`))];
        expect(rows.sort()).toEqual(expected.sort());
        expect(rows).toEqual(expect.arrayContaining(['r1->c1', 'r2->c1']));
        expect(rows).not.toContain('p1->c1');
        // The doubled pair says so.
        const doubled = summary.querySelector('[data-sankey-flow="c1->q1"]') as HTMLElement;
        expect(doubled).toHaveTextContent('×2');
    });

    it('groups flows into the chart bands, with counts that add up to every edge drawn', () => {
        const bands = sankeyFlowBands(buildSankeyDataset(GRAPH));
        expect(bands.map((b) => `${b.sourceKind}-${b.targetKind}`)).toEqual(['asset-risk', 'risk-control', 'control-requirement']);
        expect(bands.reduce((n, b) => n + b.flowCount, 0)).toBe(buildSankeyDataset(GRAPH).links.length);
        expect(bands[0].sources.map((s) => s.node.id)).toEqual(['a1', 'a2']);
    });

    it('links each end to its record, finger-sized, and names a record with no page in plain text', () => {
        render(<ControlsSankeyClient initialGraph={GRAPH} />);
        const summary = screen.getByTestId('sankey-flow-summary');
        const flow = summary.querySelector('[data-sankey-flow="a1->r2"]') as HTMLElement;
        const target = within(flow).getByRole('link', { name: 'Name of r2' });
        expect(target).toHaveAttribute('href', '/t/acme/risks/r2');
        expect(target.className).toContain('min-h-11');
        const source = within(summary.querySelector('[data-sankey-source="a1"]') as HTMLElement).getAllByRole('link')[0];
        expect(source).toHaveAttribute('href', '/t/acme/assets/a1');
        // The requirement has no page: its name, never a dead link.
        const toRequirement = summary.querySelector('[data-sankey-flow="c1->q1"]') as HTMLElement;
        expect(within(toRequirement).queryByRole('link')).toBeNull();
        expect(toRequirement).toHaveTextContent('Name of q1');
    });

    it('lists only the flows the chart draws when a search narrows it', () => {
        render(<SankeyChart graph={GRAPH} searchQuery="Name of a2" />);
        const summary = screen.getByTestId('sankey-flow-summary');
        const rows = Array.from(summary.querySelectorAll('[data-sankey-flow]')).map((el) => el.getAttribute('data-sankey-flow'));
        const drawn = [...new Set(buildSankeyDataset(GRAPH, { searchQuery: 'Name of a2' }).links.map((l) => `${l.source}->${l.target}`))];
        expect(rows.sort()).toEqual(drawn.sort());
        expect(rows).not.toContain('a1->r1');
    });

    it('says so when nothing is linked yet, at every width', () => {
        render(<ControlsSankeyClient initialGraph={{ ...GRAPH, edges: [] }} />);
        // A sentence reads at any width, so there is no list and no hidden chart.
        expect(screen.queryByTestId('sankey-flow-summary')).toBeNull();
        expect(screen.queryByTestId('sankey-chart-desktop')).toBeNull();
        expect(screen.getByText(en.common.ui.sankeyNoLinks)).toBeInTheDocument();
    });
});
