/**
 * VR-10 — governance graph page renders the meta-graph (nodes + edges).
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

// next-intl is ESM (jest can't parse its export); mock it to resolve real
// en.json values so text assertions track the original English.
jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns: string) => (key: string, params?: Record<string, unknown>) => {
            let v = key
                .split('.')
                .reduce((o: unknown, k) =>
                    o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined, en[ns]);
            if (typeof v !== 'string') return key;
            if (params) for (const [p, val] of Object.entries(params)) v = (v as string).replace(new RegExp(`\\{${p}\\}`, 'g'), String(val));
            return v;
        },
        useLocale: () => 'en',
    };
});

const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...a: unknown[]) => mockSWR(...a),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantHref: () => (p: string) => p,
}));
jest.mock('@/components/layout/PageBreadcrumbs', () => ({
    PageBreadcrumbs: () => null,
}));

import GovernanceGraphPage from '@/app/t/[tenantSlug]/(app)/processes/governance/page';

const GRAPH = {
    nodes: [
        { id: 'm1', name: 'Onboarding', canvasMode: 'AUTOMATION', ruleCount: 4, size: 2, successRate: 0.95, health: 'green' },
        { id: 'm2', name: 'Incident', canvasMode: 'AUTOMATION', ruleCount: 1, size: 1, successRate: 0.5, health: 'red' },
    ],
    edges: [{ id: 'subflow-call:m1->m2', source: 'm1', target: 'm2', kind: 'subflow-call' }],
};

describe('GovernanceGraphPage', () => {
    it('renders a health-ringed node per map + the sub-flow edges', () => {
        mockSWR.mockReturnValue({ data: GRAPH, isLoading: false });
        render(<GovernanceGraphPage />);
        expect(screen.getByTestId('governance-graph-page')).toBeInTheDocument();
        expect(screen.getByText('Onboarding')).toBeInTheDocument();
        expect(screen.getByText('Incident')).toBeInTheDocument();
        // health data-attr surfaced for the ring
        const { container } = render(<GovernanceGraphPage />);
        expect(container.querySelector('[data-governance-node="m1"][data-health="green"]')).toBeTruthy();
        expect(container.querySelector('[data-governance-node="m2"][data-health="red"]')).toBeTruthy();
        // edge rendered
        expect(screen.getAllByTestId('governance-edges').length).toBeGreaterThan(0);
    });

    it('shows an empty hint when there are no maps', () => {
        mockSWR.mockReturnValue({ data: { nodes: [], edges: [] }, isLoading: false });
        render(<GovernanceGraphPage />);
        expect(screen.getByText(/create an automation workflow/)).toBeInTheDocument();
    });

    it('names each map\'s health in words, not only by ring colour (#4801)', () => {
        mockSWR.mockReturnValue({ data: GRAPH, isLoading: false });
        const { container } = render(<GovernanceGraphPage />);
        expect(container.querySelector('[data-governance-health-label="green"]')).toHaveTextContent('Healthy');
        expect(container.querySelector('[data-governance-health-label="red"]')).toHaveTextContent('Failing');
        expect(document.getElementById('governance-health-legend')).toHaveTextContent('90%');
    });

    it('words the connection kind and names a map outside the list (#4801)', () => {
        mockSWR.mockReturnValue({
            data: {
                nodes: GRAPH.nodes,
                edges: [
                    ...GRAPH.edges,
                    { id: 'shared-rule:m1->gone', source: 'm1', target: 'gone', kind: 'shared-rule' },
                ],
            },
            isLoading: false,
        });
        render(<GovernanceGraphPage />);
        expect(screen.getByText('Connections between maps')).toBeInTheDocument();
        const edges = screen.getByTestId('governance-edges');
        expect(edges).toHaveTextContent('(sub-flow call)');
        expect(edges).toHaveTextContent('(shared rule)');
        expect(edges).toHaveTextContent('A map not in this list');
        expect(edges).not.toHaveTextContent('gone');
        expect(edges).not.toHaveTextContent('subflow-call');
    });
});
