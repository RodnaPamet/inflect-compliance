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
    const make = (ns: string) => (key: string) => {
        const v = resolve(`${ns}.${key}`);
        return typeof v === 'string' ? v : key;
    };
    return { useTranslations: (ns: string) => make(ns), useLocale: () => 'en' };
});

jest.mock('@/lib/org-context-provider', () => {
    const apiUrl = (path: string) => `/api/org/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useOrgApiUrl: () => apiUrl };
});

import {
    OrgAgentSwitchesSection,
    type OrgAgentSwitchesPayload,
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
        ...over,
    };
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
        render(<OrgAgentSwitchesSection initial={initial} />);
        expect(screen.getByTestId('org-agent-switch-agentProfiles')).not.toBeChecked();
        expect(screen.getByTestId('org-agent-switch-toolRunner')).toBeChecked();
        expect(screen.queryByTestId('org-agent-switches-read-only')).toBeNull();
    });

    it('flipping one switch sends that key alone, and adopts the answer', async () => {
        const user = userEvent.setup();
        const initial = payload();
        stubPut(initial);
        render(<OrgAgentSwitchesSection initial={initial} />);
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
        render(<OrgAgentSwitchesSection initial={initial} />);
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
        render(<OrgAgentSwitchesSection initial={initial} />);
        expect(screen.getByTestId('org-agent-switches-read-only')).toHaveTextContent(EN.readOnly);
        expect(screen.getByTestId('org-agent-switch-toolRunner')).toBeDisabled();
        await user.click(screen.getByTestId('org-agent-switch-toolRunner'));
        expect(calls).toEqual([]);
    });

    it('a refused save shows the server\'s sentence under that switch, and keeps the stored state', async () => {
        const user = userEvent.setup();
        const initial = payload();
        stubPut(initial, 'Permission denied');
        render(<OrgAgentSwitchesSection initial={initial} />);
        await user.click(screen.getByTestId('org-agent-switch-toolRunner'));
        const row = screen.getByTestId('org-agent-switch-toolRunner-row');
        expect(await within(row).findByText('Permission denied')).toBeInTheDocument();
        expect(screen.getByTestId('org-agent-switch-toolRunner')).not.toBeChecked();
        expect(within(screen.getByTestId('org-agent-switch-agentProfiles-row')).queryByText('Permission denied')).toBeNull();
    });
});
