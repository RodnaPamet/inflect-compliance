/**
 * The agent-flow editor (Phases 3 and 4, docs/ai-architecture/langflow.md),
 * rendered.
 *
 * The drawing is tldraw's and is replaced by a probe that reports what it was
 * given and can play a person's move of a box. What this file owns is the
 * editor around it: the palette offers the flow kinds and no checkpoint, the
 * inspector's pickers list the agent's grants and approved profiles, the
 * server's rules show inline before save, the ONE write goes to the existing
 * version route carrying the flow and no position, a move writes nothing, and
 * the Compiled panel shows the server's message rather than computing one.
 */
import { installTldrawJsdomShims } from '../helpers/tldraw-jsdom';

// The layout engine (dagre) needs `structuredClone`, which jsdom lacks.
installTldrawJsdomShims();

import * as React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json') as Record<string, unknown>;
    const resolve = (ns: string, key: string): unknown =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        let v = resolve(ns, key);
        if (typeof v !== 'string') return `${ns}.${key}`;
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

const refresh = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh, back: jest.fn() }),
    useParams: () => ({ tenantSlug: 'acme' }),
    usePathname: () => '/t/acme/processes/agents/agent-1/flow',
    useSearchParams: () => new URLSearchParams(''),
}));

jest.mock('@/components/ui/tooltip', () => ({
    __esModule: true,
    ...jest.requireActual('@/components/ui/tooltip'),
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// The canvas is tldraw's; the editor reaches it only through next/dynamic. The
// probe records its props and can play a move and a selection.
type ProbeProps = {
    nodes: Array<{ key: string; change: string; problems: string[] }>;
    edges: Array<{ from: string; to: string; change: string }>;
    readOnly?: boolean;
    onMove?: (key: string, at: { x: number; y: number }) => void;
    onSelect?: (key: string | null) => void;
};
const probe: { last: ProbeProps | null } = { last: null };
jest.mock('next/dynamic', () => () => {
    const Probe = (props: ProbeProps) => {
        probe.last = props;
        return (
            <div data-testid="agent-flow-canvas-probe" data-readonly={props.readOnly ? 'true' : 'false'}>
                {props.nodes.map((n) => (
                    <button key={n.key} data-testid={`probe-select-${n.key}`} onClick={() => props.onSelect?.(n.key)}>
                        {n.key}
                    </button>
                ))}
            </div>
        );
    };
    return Probe;
});

import { AgentFlowEditor, type AgentFlowEditorProps } from '@/components/processes/agent-flow/AgentFlowEditor';
import type { AgentFlow } from '@/lib/agentic/agent-flow';

const FLOW: AgentFlow = {
    nodes: [
        { key: 'read-1', kind: 'read', label: 'Read posture', tool: 'get_compliance_posture' },
        { key: 'synthesis-1', kind: 'synthesis', label: 'Answer' },
    ],
    edges: [{ from: 'read-1', to: 'synthesis-1' }],
};

function props(over: Partial<AgentFlowEditorProps> = {}): AgentFlowEditorProps {
    return {
        tenantSlug: 'acme',
        agentId: 'agent-1',
        profileId: 'prof-self',
        opened: {
            version: 2,
            status: 'DRAFT',
            flow: FLOW,
            instructions: 'Review the posture.',
            skillRefs: [],
            modelTier: 'balanced',
            effort: 'medium',
            maxTurns: 8,
            outputKind: 'ANSWER_AND_PROPOSALS',
            allowedTriggers: ['ASK'],
        },
        inForce: null,
        grants: ['get_compliance_posture', 'list_risks', 'propose_finding'],
        subagentOptions: [{ profileId: 'prof-other', agentName: 'Vendor agent', version: 3 }],
        preview: { state: 'SHOWN', version: 2, runAs: null, message: 'THE SERVER MESSAGE\n1. [READ] Read posture', readOnly: true },
        toolStates: [
            { name: 'get_compliance_posture', offered: true },
            { name: 'list_risks', offered: false, reason: 'PROFILE_TOOL_NOT_GRANTED' },
        ],
        ...over,
    };
}

let fetchMock: jest.Mock;
beforeEach(() => {
    probe.last = null;
    refresh.mockReset();
    fetchMock = jest.fn(async () => ({ ok: true, json: async () => ({}) }));
    global.fetch = fetchMock as unknown as typeof fetch;
});

describe('the palette', () => {
    it('offers the four flow kinds and no checkpoint', () => {
        render(<AgentFlowEditor {...props()} />);
        const palette = screen.getByTestId('agent-flow-palette');
        const kinds = within(palette)
            .getAllByRole('button')
            .map((b) => b.getAttribute('data-testid'));
        expect(kinds).toEqual([
            'agent-flow-add-read',
            'agent-flow-add-propose',
            'agent-flow-add-synthesis',
            'agent-flow-add-subagent',
        ]);
        expect(screen.queryByTestId('agent-flow-add-checkpoint')).toBeNull();
    });

    it('adding a step draws it and selects it in the inspector, with what is missing named', () => {
        render(<AgentFlowEditor {...props()} />);
        fireEvent.click(screen.getByTestId('agent-flow-add-read'));
        expect(probe.last?.nodes.map((n) => n.key)).toEqual(['read-1', 'synthesis-1', 'read-2']);
        const inspector = screen.getByTestId('agent-flow-inspector-read-2');
        expect(within(inspector).getByTestId('agent-flow-diagnostic-FLOW_STEP_NEEDS_TOOL')).toBeTruthy();
        // The draft would not save, so Save is off.
        expect(screen.getByTestId('agent-flow-save')).toHaveProperty('disabled', true);
    });
});

describe('the inspector', () => {
    it('the tool picker lists the agent’s grants of the step’s kind, never the catalogue', async () => {
        const user = userEvent.setup();
        render(<AgentFlowEditor {...props()} />);
        fireEvent.click(screen.getByTestId('probe-select-read-1'));
        await user.click(document.getElementById('agent-flow-step-tool') as HTMLElement);
        const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
        expect(options.sort()).toEqual(['get_compliance_posture', 'list_risks']);
    });

    it('a cycle is shown inline with the server’s reason, and Save stays off', async () => {
        const user = userEvent.setup();
        render(<AgentFlowEditor {...props()} />);
        fireEvent.click(screen.getByTestId('probe-select-synthesis-1'));
        await user.click(document.getElementById('agent-flow-step-next') as HTMLElement);
        await user.click(await screen.findByRole('option', { name: /read-1/ }));
        expect(await screen.findByTestId('agent-flow-diagnostic-FLOW_CYCLE')).toBeTruthy();
        expect(screen.getByTestId('agent-flow-save')).toHaveProperty('disabled', true);
    });
});

describe('the one write', () => {
    it('an unedited flow offers no save: opening a version never writes one', () => {
        render(<AgentFlowEditor {...props()} />);
        expect(screen.getByTestId('agent-flow-save')).toHaveProperty('disabled', true);
    });

    it('moving a step writes nothing and leaves the flow unchanged', () => {
        render(<AgentFlowEditor {...props()} />);
        act(() => probe.last?.onMove?.('read-1', { x: 900, y: 40 }));
        expect(screen.getByTestId('agent-flow-save')).toHaveProperty('disabled', true);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a logic change saves through the existing version route, carrying the flow and no position', async () => {
        render(<AgentFlowEditor {...props()} />);
        act(() => probe.last?.onMove?.('read-1', { x: 900, y: 40 }));
        fireEvent.click(screen.getByTestId('probe-select-read-1'));
        fireEvent.change(document.getElementById('agent-flow-step-label') as HTMLElement, {
            target: { value: 'Read the posture' },
        });
        const save = screen.getByTestId('agent-flow-save');
        expect(save).toHaveProperty('disabled', false);
        await act(async () => {
            fireEvent.click(save);
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/api/t/acme/admin/agents/agent-1/profile/versions');
        expect(init.method).toBe('POST');
        const body = JSON.parse(String(init.body));
        expect(body.flow.nodes[0]).toEqual({
            key: 'read-1',
            kind: 'read',
            label: 'Read the posture',
            tool: 'get_compliance_posture',
        });
        expect(body).not.toHaveProperty('toolNames');
        expect(String(init.body)).not.toMatch(/"(x|y|position|layout)":/);
        expect(body.instructions).toBe('Review the posture.');
        expect(refresh).toHaveBeenCalled();
    });

    it('an unedited draft version is submitted through the existing submit route', async () => {
        render(<AgentFlowEditor {...props()} />);
        await act(async () => {
            fireEvent.click(screen.getByTestId('agent-flow-submit'));
        });
        expect(fetchMock.mock.calls[0][0]).toBe('/api/t/acme/admin/agents/agent-1/profile/versions/2/submit');
    });
});

describe('the Compiled panel (Phase 4)', () => {
    it('shows the server’s run message and tool verdicts verbatim', () => {
        render(<AgentFlowEditor {...props()} />);
        expect(screen.getByTestId('agent-flow-compiled-message').textContent).toBe(
            'THE SERVER MESSAGE\n1. [READ] Read posture',
        );
        expect(screen.getByTestId('agent-flow-compiled-tool-list_risks').textContent).toMatch(
            /no longer granted this tool/,
        );
        expect(screen.queryByTestId('agent-flow-compiled-stale')).toBeNull();
    });

    it('says the preview is of the saved version once the draft differs from it', () => {
        render(<AgentFlowEditor {...props()} />);
        fireEvent.click(screen.getByTestId('agent-flow-add-synthesis'));
        expect(screen.getByTestId('agent-flow-compiled-stale')).toBeTruthy();
        // The message shown is still the server's, never one computed here.
        expect(screen.getByTestId('agent-flow-compiled-message').textContent).toBe(
            'THE SERVER MESSAGE\n1. [READ] Read posture',
        );
    });
});

describe('the approver’s diff (Phase 4.3)', () => {
    it('draws both flows read-only, each step and connection marked', () => {
        const inForceFlow: AgentFlow = {
            nodes: [
                { key: 'read-1', kind: 'read', label: 'Read the old way', tool: 'get_compliance_posture' },
                { key: 'read-9', kind: 'read', label: 'Read risks', tool: 'list_risks' },
            ],
            edges: [{ from: 'read-9', to: 'read-1' }],
        };
        render(<AgentFlowEditor {...props({ opened: { ...props().opened, status: 'SUBMITTED' }, inForce: { version: 1, flow: inForceFlow } })} />);
        fireEvent.click(screen.getByTestId('agent-flow-toggle-diff'));
        expect(probe.last?.readOnly).toBe(true);
        const change = Object.fromEntries((probe.last?.nodes ?? []).map((n) => [n.key, n.change]));
        expect(change).toEqual({ 'read-1': 'changed', 'read-9': 'removed', 'synthesis-1': 'added' });
        const edges = Object.fromEntries((probe.last?.edges ?? []).map((e) => [`${e.from}->${e.to}`, e.change]));
        expect(edges).toEqual({ 'read-9->read-1': 'removed', 'read-1->synthesis-1': 'added' });
        expect(screen.queryByTestId('agent-flow-palette')).toBeNull();
        expect(screen.getByTestId('agent-flow-diff-read-9').textContent).toMatch(/Step removed/);
    });
});
