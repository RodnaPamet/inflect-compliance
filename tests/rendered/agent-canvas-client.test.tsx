/**
 * The agent canvas page (Phase 2, docs/ai-architecture/langflow.md), rendered.
 *
 * The drawing itself is tldraw's and is replaced by a probe: what this file
 * owns is the page around it — the read-only framing, the Elements list that
 * says every narrowing in words, and the profile layer's absence named rather
 * than left blank. The editor is loaded through `next/dynamic`, which the probe
 * stands in for, so the test also proves the page reaches the canvas only
 * through that lazy import.
 */
import * as React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = resolve(ns, key);
        if (typeof v !== 'string') return key;
        if (params)
            for (const [p, val] of Object.entries(params))
                v = (v as string).replace(new RegExp('\\{' + p + '\\}', 'g'), String(val));
        return v as string;
    };
    const cache = new Map<string, ReturnType<typeof make>>();
    return {
        useTranslations: (ns: string) => {
            if (!cache.has(ns)) cache.set(ns, make(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
    };
});

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/processes/agents/agent-1',
    useSearchParams: () => new URLSearchParams(''),
}));

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    ...jest.requireActual('@/components/ui/tooltip'),
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The canvas is the editor's; the page reaches it only through next/dynamic.
jest.mock('next/dynamic', () => () => {
    const Probe = (props: { projection: { agent: { name: string } } }) => (
        <div data-testid="agent-canvas-probe">{props.projection.agent.name}</div>
    );
    return Probe;
});

import { AgentCanvasClient } from '@/app/t/[tenantSlug]/(app)/processes/agents/[agentId]/AgentCanvasClient';
import type { AgentCanvasProjection } from '@/lib/agentic/agent-canvas-projection';

function projection(profile: AgentCanvasProjection['profile']): AgentCanvasProjection {
    return {
        agent: { id: 'agent-1', name: 'Posture agent', status: 'ACTIVE', autonomyLevel: 2, riskTier: 'LOW', effectiveCeiling: 2 },
        envelope: {
            grants: [
                { name: 'get_compliance_posture', capability: 'read', requiredAutonomy: 1, withinCeiling: true },
                { name: 'propose_controls', capability: 'propose', requiredAutonomy: 2, withinCeiling: true },
            ],
            policyCardVersion: 1,
            breakerState: null,
            killScope: null,
        },
        profile,
        workflows: [],
        usedIn: [],
    };
}

const SHOWN: AgentCanvasProjection['profile'] = {
    state: 'SHOWN',
    version: 3,
    status: 'SUBMITTED',
    inForce: false,
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 8,
    outputKind: 'ANSWER_ONLY',
    readOnly: true,
    allowedTriggers: ['ASK'],
    tools: [
        { name: 'get_compliance_posture', offered: true },
        { name: 'propose_controls', offered: false, reason: 'READ_ONLY_WORKFLOW' },
    ],
    skills: [],
    instructions: 'Summarise the posture in one line.',
};

describe('AgentCanvasClient', () => {
    it('opens on the canvas, framed as read-only, under the agent it views', () => {
        render(<AgentCanvasClient tenantSlug="acme" projection={projection({ state: 'NONE' })} />);
        expect(screen.getByTestId('agent-canvas-probe')).toHaveTextContent('Posture agent');
        expect(screen.getByTestId('agent-canvas-readonly-badge')).toHaveTextContent('Read-only');
        expect(screen.getByRole('link', { name: 'Posture agent' })).toHaveAttribute('href', '/t/acme/agents/agent-1');
    });

    it('names why there is no profile layer instead of drawing an empty one', () => {
        render(<AgentCanvasClient tenantSlug="acme" projection={projection({ state: 'NOT_PERMITTED' })} />);
        expect(screen.getByTestId('agent-canvas-profile-absent')).toHaveTextContent(/needs the agent register permission/);
        expect(screen.queryByTestId('agent-canvas-instructions')).toBeNull();
    });

    it('lists every element with the reason a run is not offered a tool', () => {
        render(<AgentCanvasClient tenantSlug="acme" projection={projection(SHOWN)} />);
        fireEvent.click(screen.getByRole('tab', { name: /Elements/ }));
        const list = screen.getByTestId('agent-canvas-elements');
        const narrowed = within(list).getByTestId('agent-canvas-element-tool:propose_controls');
        expect(narrowed).toHaveTextContent('Narrowed away');
        expect(within(narrowed).getByTestId('agent-canvas-element-reason-tool:propose_controls')).toHaveTextContent(
            /this profile answers only/,
        );
        expect(within(list).queryByTestId('agent-canvas-element-reason-tool:get_compliance_posture')).toBeNull();
        expect(within(list).getByTestId('agent-canvas-element-trigger:ASK')).toBeInTheDocument();
    });

    it('says when the version drawn is not the one in force, and keeps its instructions collapsed', () => {
        render(<AgentCanvasClient tenantSlug="acme" projection={projection(SHOWN)} />);
        expect(screen.getByTestId('agent-canvas-version-not-in-force')).toHaveTextContent('version 3 (SUBMITTED)');
        expect(screen.queryByText('Summarise the posture in one line.')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /Profile instructions/ }));
        expect(screen.getByText('Summarise the posture in one line.')).toBeInTheDocument();
    });
});
