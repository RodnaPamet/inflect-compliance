/**
 * #4794 — every string the controls flow diagram shows comes from the
 * messages, so a Bulgarian reader no longer sees English column headings,
 * buttons and empty states; and a capped graph says it is partial.
 */
import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

jest.mock('next-intl', () => {
    const bg = require('../../messages/bg.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            bg,
        );
    const cache = new Map<string, unknown>();
    const make = (ns: string) => {
        if (cache.has(ns)) return cache.get(ns);
        const t = (key: string, params?: Record<string, unknown>) => {
            let v = resolve(ns, key);
            if (typeof v !== 'string') return `MISSING:${ns}.${key}`;
            if (params)
                for (const [p, val] of Object.entries(params))
                    v = (v as string).split(`{${p}}`).join(String(val));
            return v;
        };
        cache.set(ns, t);
        return t;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'bg' };
});

import { ControlsSankeyClient } from '@/app/t/[tenantSlug]/(app)/controls/sankey/ControlsSankeyClient';
import type {
    TraceabilityEdge,
    TraceabilityGraph,
    TraceabilityNode,
} from '@/lib/traceability-graph/types';

function node(id: string, kind: TraceabilityNode['kind']): TraceabilityNode {
    return { id, kind, label: id, secondary: null, badge: null, href: `/x/${id}` };
}
function edge(id: string, source: string, target: string, relation: TraceabilityEdge['relation']): TraceabilityEdge {
    return { id, source, target, relation, qualifier: null };
}
function graph(nodes: TraceabilityNode[], edges: TraceabilityEdge[], truncated = false): TraceabilityGraph {
    return {
        nodes,
        edges,
        categories: [],
        meta: { truncated, droppedNodeCount: truncated ? 12 : 0, nodeCap: truncated ? 500 : null, appliedFilters: {} },
    };
}
const FLOW = graph(
    [node('a1', 'asset'), node('r1', 'risk'), node('c1', 'control')],
    [edge('e1', 'a1', 'r1', 'exposes'), edge('e2', 'c1', 'r1', 'mitigates')],
);

describe('controls flow diagram — translated (#4794)', () => {
    it('column headings, the size button and the titles come from the messages', () => {
        const { container } = render(<ControlsSankeyClient initialGraph={FLOW} />);
        expect(screen.getByText('Активи')).toBeInTheDocument();
        expect(screen.getByText('Рискове')).toBeInTheDocument();
        expect(screen.getByText('Контроли')).toBeInTheDocument();
        const toggle = document.getElementById('sankey-fit-toggle') as HTMLElement;
        expect(toggle).toHaveTextContent('Побиране в изгледа');
        fireEvent.click(toggle);
        expect(toggle).toHaveTextContent('Действителен размер');
        const titles = Array.from(container.querySelectorAll('title')).map((n) => n.textContent ?? '');
        expect(titles.some((x) => x.startsWith('Намалява ('))).toBe(true);
        expect(titles.some((x) => x.includes('(тегло '))).toBe(true);
        expect(container.textContent).not.toMatch(/MISSING:|Fit to view|Assets|weight/);
    });

    it('the empty states come from the messages', () => {
        const { unmount } = render(<ControlsSankeyClient initialGraph={graph([], [])} />);
        expect(screen.getByText('Няма потоци на съответствие за показване.')).toBeInTheDocument();
        unmount();
        render(<ControlsSankeyClient initialGraph={graph([node('a1', 'asset'), node('r1', 'risk')], [])} />);
        expect(screen.getByText('Има записи, но все още нито един не е свързан с друг.')).toBeInTheDocument();
    });

    it('a capped graph says it is partial', () => {
        render(<ControlsSankeyClient initialGraph={graph(FLOW.nodes, FLOW.edges, true)} />);
        expect(document.getElementById('controls-sankey-truncated')).toHaveTextContent('до 500 елемента от всеки вид');
    });

    it('a whole graph shows no notice', () => {
        render(<ControlsSankeyClient initialGraph={FLOW} />);
        expect(document.getElementById('controls-sankey-truncated')).toBeNull();
    });
});
