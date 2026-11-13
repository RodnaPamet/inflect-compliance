/**
 * THE ORG'S AGENT SWITCHES SAY WHEN THEY ARE OVERRIDDEN, AND SEND ONE KEY (#4557).
 *
 *   1. Each switch shows the organization's stored choice.
 *   2. Flipping one PUTs that key alone and adopts the server's answer.
 *   3. A switch the deployment overrides says so, ON or OFF, and stays usable:
 *      the choice is stored for when the deployment leaves it open.
 *   4. A member without the write key sees the switches disabled and one
 *      sentence saying who can change them.
 *   5. A refused save shows the server's sentence under THAT switch and keeps
 *      the stored state.
 *   6. Turning a switch OFF asks first, naming the organization and how many
 *      workspaces it reaches (#4850); cancelling sends nothing. Turning one on,
 *      a switch the deployment overrides, and an organization with no
 *      workspace save at once.
 *   7. The "Per-turn limits" group (#4594): two steppers bounded by the
 *      database's ranges, each saving its own key alone; lowering a ceiling
 *      asks first, naming the organization and its reach, as turning a switch
 *      off does; raising one saves at once; a reader sees them read-only.
 */
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json') as Record<string, unknown>;
    const resolve = (path: string): unknown =>
        path.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    // `{name}` and the flat `plural` blocks the catalogue uses, so a test can
    // assert the confirmation's reach rather than its template.
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const OPTION = /(=\d+|one|other)\s*\{([^{}]*)\}/g;
    const format = (str: string, params?: Record<string, unknown>) =>
        str
            .replace(PLURAL, (block: string, name: string, options: string) => {
                if (!params || !(name in params)) return block;
                const n = Number(params[name]);
                const forms = new Map<string, string>();
                for (const m of options.matchAll(OPTION)) forms.set(m[1], m[2]);
                const body = forms.get(`=${n}`) ?? (n === 1 ? forms.get('one') : undefined) ?? forms.get('other');
                return body === undefined ? block : body.split('#').join(String(n));
            })
            .replace(/\{(\w+)\}/g, (m: string, name: string) => (params && name in params ? String(params[name]) : m));
    const make = (ns: string) => (key: string, params?: Record<string, unknown>) => {
        const v = resolve(`${ns}.${key}`);
        return typeof v === 'string' ? format(v, params) : key;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

// The confirmation is a Modal, which reads the router.
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/org/acme/settings',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/org-context-provider', () => {
    const apiUrl = (path: string) => `/api/org/acme${path.startsWith('/') ? path : `/${path}`}`;
    return {
        useOrgApiUrl: () => apiUrl,
        useOrgContext: () => ({ orgName: 'Acme Group', orgSlug: 'acme' }),
    };
});

import {
    OrgAgentSwitchesSection,
    type OrgAgentSwitchesPayload,
    type OrgAgentTurnCapsPayload,
} from '@/app/org/[orgSlug]/(app)/settings/OrgAgentSwitchesSection';

const EN = (
    require('../../messages/en.json') as { org: { settings: { agentSwitches: Record<string, unknown> } } }
).org.settings.agentSwitches as Record<string, string> & Record<'agentProfiles' | 'toolRunner', { label: string }>;

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];

function payload(over: Partial<OrgAgentSwitchesPayload> = {}): OrgAgentSwitchesPayload {
    return {
        agentProfiles: { organization: false, deployment: 'UNSET' },
        toolRunner: { organization: false, deployment: 'UNSET' },
        canManage: true,
        workspaceCount: 3,
        ...over,
    };
}

/** The organization's per-turn ceilings (#4594): today's behaviour by default. */
function caps(over: Partial<OrgAgentTurnCapsPayload> = {}): OrgAgentTurnCapsPayload {
    return { delegationsPerTurn: 3, toolCallsPerTurn: 1, canManage: true, workspaceCount: 3, ...over };
}

/** The PUT echoes the change into the payload, as the route does, or refuses. */
function stubPut(base: OrgAgentSwitchesPayload, refuseWith?: string): void {
    calls = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url, method: init?.method ?? 'GET', body });
        if (refuseWith) return { ok: false, json: async () => ({ error: { code: 'FORBIDDEN', message: refuseWith } }) };
        const next = { ...base } as OrgAgentSwitchesPayload;
        for (const [k, v] of Object.entries(body as Record<string, boolean>)) {
            const key = k as 'agentProfiles' | 'toolRunner';
            next[key] = { ...next[key], organization: v };
        }
        return { ok: true, json: async () => ({ switches: next }) };
    }) as unknown as typeof fetch;
}

afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
});

describe('the organization\'s agent switches', () => {
    it('shows each stored choice', () => {
        const initial = payload({ toolRunner: { organization: true, deployment: 'UNSET' } });
        stubPut(initial);
        render(<OrgAgentSwitchesSection initial={initial} turnCaps={caps()} />);
        expect(screen.getByTestId('org-agent-switch-agentProfiles')).not.toBeChecked();
        expect(screen.getByTestId('org-agent-switch-toolRunner')).toBeChecked();
        expect(screen.queryByTestId('org-agent-switches-read-only')).toBeNull();
    });

    it('flipping one switch sends that key alone, and adopts the answer', async () => {
        const user = userEvent.setup();
        const initial = payload();
        stubPut(initial);
        render(<OrgAgentSwitchesSection initial={initial} turnCaps={caps()} />);
        await user.click(screen.getByTestId('org-agent-switch-toolRunner'));
        expect(calls).toEqual([{ url: '/api/org/acme/agent-switches', method: 'PUT', body: { toolRunner: true } }]);
        expect(await screen.findByTestId('org-agent-switch-toolRunner')).toBeChecked();
        expect(screen.getByTestId('org-agent-switch-agentProfiles')).not.toBeChecked();
    });

    it.each([
        ['ON', 'deploymentOn', 'deploymentOnBadge'],
        ['OFF', 'deploymentOff', 'deploymentOffBadge'],
    ] as const)('a deployment that turns it %s says so, and the switch stays usable', async (state, sentence, badge) => {
        const user = userEvent.setup();
        const initial = payload({ agentProfiles: { organization: false, deployment: state } });
        stubPut(initial);
        render(<OrgAgentSwitchesSection initial={initial} turnCaps={caps()} />);
        const row = screen.getByTestId('org-agent-switch-agentProfiles-row');
        expect(within(row).getByTestId('org-agent-switch-agentProfiles-overridden')).toHaveTextContent(EN[sentence]);
        expect(row).toHaveTextContent(EN[badge]);
        // The other switch, left open, carries no such note.
        expect(screen.queryByTestId('org-agent-switch-toolRunner-overridden')).toBeNull();
        await user.click(screen.getByTestId('org-agent-switch-agentProfiles'));
        expect(calls.map((c) => c.body)).toEqual([{ agentProfiles: true }]);
    });

    it('a member who cannot change them sees them disabled and is told who can', async () => {
        const user = userEvent.setup();
        const initial = payload({ canManage: false });
        stubPut(initial);
        render(<OrgAgentSwitchesSection initial={initial} turnCaps={caps()} />);
        expect(screen.getByTestId('org-agent-switches-read-only')).toHaveTextContent(EN.readOnly);
        expect(screen.getByTestId('org-agent-switch-toolRunner')).toBeDisabled();
        await user.click(screen.getByTestId('org-agent-switch-toolRunner'));
        expect(calls).toEqual([]);
    });

    it('a refused save shows the server\'s sentence under that switch, and keeps the stored state', async () => {
        const user = userEvent.setup();
        const initial = payload();
        stubPut(initial, 'Permission denied');
        render(<OrgAgentSwitchesSection initial={initial} turnCaps={caps()} />);
        await user.click(screen.getByTestId('org-agent-switch-toolRunner'));
        const row = screen.getByTestId('org-agent-switch-toolRunner-row');
        expect(await within(row).findByText('Permission denied')).toBeInTheDocument();
        expect(screen.getByTestId('org-agent-switch-toolRunner')).not.toBeChecked();
        expect(within(screen.getByTestId('org-agent-switch-agentProfiles-row')).queryByText('Permission denied')).toBeNull();
    });

    it('turning a switch off asks first, naming the organization and its reach (#4850)', async () => {
        const user = userEvent.setup();
        const initial = payload({ agentProfiles: { organization: true, deployment: 'UNSET' } });
        stubPut(initial);
        render(<OrgAgentSwitchesSection initial={initial} turnCaps={caps()} />);

        await user.click(screen.getByTestId('org-agent-switch-agentProfiles'));
        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('Turn off agent profiles?');
        expect(dialog).toHaveTextContent('Agent profiles stop working in every workspace in Acme Group (3 workspaces)');
        // Nothing is sent while the person decides.
        expect(calls).toEqual([]);

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(calls).toEqual([]);
        expect(screen.getByTestId('org-agent-switch-agentProfiles')).toBeChecked();

        await user.click(screen.getByTestId('org-agent-switch-agentProfiles'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Turn off' }));
        expect(calls).toEqual([{ url: '/api/org/acme/agent-switches', method: 'PUT', body: { agentProfiles: false } }]);
        expect(await screen.findByTestId('org-agent-switch-agentProfiles')).not.toBeChecked();
    });

    it('names the one workspace when the organization has exactly one', async () => {
        const user = userEvent.setup();
        const initial = payload({ toolRunner: { organization: true, deployment: 'UNSET' }, workspaceCount: 1 });
        stubPut(initial);
        render(<OrgAgentSwitchesSection initial={initial} turnCaps={caps()} />);
        await user.click(screen.getByTestId('org-agent-switch-toolRunner'));
        expect(await screen.findByRole('dialog')).toHaveTextContent(
            'The Tool Runner engine stops being available in every workspace in Acme Group (1 workspace).',
        );
    });

    it.each([
        ['the deployment overrides it', { deployment: 'ON' as const }, 3],
        ['the organization has no workspace yet', { deployment: 'UNSET' as const }, 0],
    ])('turning off saves at once when %s: it changes no workspace', async (_why, state, workspaceCount) => {
        const user = userEvent.setup();
        const initial = payload({ agentProfiles: { organization: true, ...state }, workspaceCount });
        stubPut(initial);
        render(<OrgAgentSwitchesSection initial={initial} turnCaps={caps()} />);
        await user.click(screen.getByTestId('org-agent-switch-agentProfiles'));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(calls.map((c) => c.body)).toEqual([{ agentProfiles: false }]);
    });
});

describe('the organization\'s per-turn limits (#4594)', () => {
    /** The turn-caps PUT echoes the change, as the route does, or refuses. */
    function stubCapsPut(base: OrgAgentTurnCapsPayload, refuseWith?: string): void {
        calls = [];
        (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
            const body = init?.body ? JSON.parse(String(init.body)) : undefined;
            calls.push({ url, method: init?.method ?? 'GET', body });
            if (refuseWith) return { ok: false, json: async () => ({ error: { code: 'BAD_REQUEST', message: refuseWith } }) };
            return { ok: true, json: async () => ({ turnCaps: { ...base, ...(body as object) } }) };
        }) as unknown as typeof fetch;
    }
    const TC = (
        require('../../messages/en.json') as {
            org: { settings: { agentSwitches: { turnCaps: Record<string, { label: string }> & { title: string } } } };
        }
    ).org.settings.agentSwitches.turnCaps;

    it('shows both ceilings, bounded by the database\'s ranges, inside the Agent features section', () => {
        stubCapsPut(caps());
        render(<OrgAgentSwitchesSection initial={payload()} turnCaps={caps({ delegationsPerTurn: 2, toolCallsPerTurn: 4 })} />);
        const group = within(screen.getByTestId('org-agent-switches')).getByTestId('org-turn-caps');
        expect(group).toHaveTextContent(TC.title);
        expect(group).toHaveTextContent(TC.delegationsPerTurn.label);
        expect(group).toHaveTextContent(TC.toolCallsPerTurn.label);
        const delegations = within(screen.getByTestId('org-turn-cap-delegationsPerTurn-row')).getByRole('spinbutton');
        const tools = within(screen.getByTestId('org-turn-cap-toolCallsPerTurn-row')).getByRole('spinbutton');
        expect(delegations).toHaveValue('2');
        expect(tools).toHaveValue('4');
        // Nothing moved, so nothing can be saved.
        expect(screen.getByTestId('org-turn-cap-toolCallsPerTurn-save')).toBeDisabled();
    });

    it('raising a ceiling saves that key alone, at once, and adopts the answer', async () => {
        const user = userEvent.setup();
        stubCapsPut(caps());
        render(<OrgAgentSwitchesSection initial={payload()} turnCaps={caps()} />);
        const row = screen.getByTestId('org-turn-cap-toolCallsPerTurn-row');
        await user.click(within(row).getByRole('button', { name: 'Increase' }));
        await user.click(screen.getByTestId('org-turn-cap-toolCallsPerTurn-save'));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(calls).toEqual([{ url: '/api/org/acme/agent-turn-caps', method: 'PUT', body: { toolCallsPerTurn: 2 } }]);
        expect(await screen.findByTestId('org-turn-cap-toolCallsPerTurn-saved')).toBeInTheDocument();
        expect(screen.getByTestId('org-turn-cap-toolCallsPerTurn-save')).toBeDisabled();
    });

    it('lowering a ceiling asks first, naming the organization and its reach; cancelling sends nothing', async () => {
        const user = userEvent.setup();
        stubCapsPut(caps());
        render(<OrgAgentSwitchesSection initial={payload()} turnCaps={caps()} />);
        const row = screen.getByTestId('org-turn-cap-delegationsPerTurn-row');
        await user.click(within(row).getByRole('button', { name: 'Decrease' }));
        await user.click(screen.getByTestId('org-turn-cap-delegationsPerTurn-save'));

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('Lower the delegations limit?');
        expect(dialog).toHaveTextContent('The limit goes from 3 to 2 in every workspace in Acme Group (3 workspaces)');
        expect(calls).toEqual([]);
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(calls).toEqual([]);

        await user.click(screen.getByTestId('org-turn-cap-delegationsPerTurn-save'));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Lower limit' }));
        expect(calls).toEqual([{ url: '/api/org/acme/agent-turn-caps', method: 'PUT', body: { delegationsPerTurn: 2 } }]);
    });

    it('lowering saves at once when the organization has no workspace yet', async () => {
        const user = userEvent.setup();
        stubCapsPut(caps({ workspaceCount: 0 }));
        render(<OrgAgentSwitchesSection initial={payload()} turnCaps={caps({ workspaceCount: 0 })} />);
        await user.click(within(screen.getByTestId('org-turn-cap-delegationsPerTurn-row')).getByRole('button', { name: 'Decrease' }));
        await user.click(screen.getByTestId('org-turn-cap-delegationsPerTurn-save'));
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(calls.map((c) => c.body)).toEqual([{ delegationsPerTurn: 2 }]);
    });

    it('a ceiling cannot be stepped past its range: tool calls stop at 1, delegations at 0', async () => {
        const user = userEvent.setup();
        stubCapsPut(caps());
        render(<OrgAgentSwitchesSection initial={payload()} turnCaps={caps({ delegationsPerTurn: 0, toolCallsPerTurn: 1 })} />);
        expect(within(screen.getByTestId('org-turn-cap-toolCallsPerTurn-row')).getByRole('button', { name: 'Decrease' })).toBeDisabled();
        expect(within(screen.getByTestId('org-turn-cap-delegationsPerTurn-row')).getByRole('button', { name: 'Decrease' })).toBeDisabled();
        await user.click(within(screen.getByTestId('org-turn-cap-toolCallsPerTurn-row')).getByRole('button', { name: 'Decrease' }));
        expect(calls).toEqual([]);
    });

    it('a member who cannot change them sees the values read-only, with no Save', () => {
        stubCapsPut(caps());
        render(<OrgAgentSwitchesSection initial={payload({ canManage: false })} turnCaps={caps({ canManage: false })} />);
        expect(within(screen.getByTestId('org-turn-cap-toolCallsPerTurn-row')).getByRole('spinbutton')).toBeDisabled();
        expect(screen.queryByTestId('org-turn-cap-toolCallsPerTurn-save')).toBeNull();
        expect(screen.queryByTestId('org-turn-cap-delegationsPerTurn-save')).toBeNull();
    });

    it('a refused save shows the server\'s sentence under that limit, and keeps the stored value', async () => {
        const user = userEvent.setup();
        stubCapsPut(caps(), 'Permission denied');
        render(<OrgAgentSwitchesSection initial={payload()} turnCaps={caps()} />);
        const row = screen.getByTestId('org-turn-cap-toolCallsPerTurn-row');
        await user.click(within(row).getByRole('button', { name: 'Increase' }));
        await user.click(screen.getByTestId('org-turn-cap-toolCallsPerTurn-save'));
        expect(await within(row).findByText('Permission denied')).toBeInTheDocument();
        expect(within(screen.getByTestId('org-turn-cap-delegationsPerTurn-row')).queryByText('Permission denied')).toBeNull();
    });
});
