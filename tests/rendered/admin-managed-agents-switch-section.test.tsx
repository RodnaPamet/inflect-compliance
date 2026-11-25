/**
 * The "Managed Agents engine" section of Admin → AI features (#5964, owner
 * decisions 2026-11-25), against the real `messages/en.json`:
 *
 *   - an owner, with the variable unset, toggles it, and the PUT carries
 *     exactly the choice; the engines section below is refreshed too;
 *   - an admin sees the state and who can change it, and no control;
 *   - when the operator's variable decides, the toggle is disabled and the
 *     section says the operator decided, in both directions;
 *   - a refusal is shown, not swallowed;
 *   - every sentence it renders exists in both catalogues.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.mock('next-intl', () => {
    const en = require('../../messages/en.json');
    return {
        useTranslations: (ns?: string) => (key: string) => {
            const dotted = ns ? `${ns}.${key}` : key;
            let cur: unknown = en;
            for (const part of dotted.split('.')) {
                cur = (cur as Record<string, unknown> | undefined)?.[part];
            }
            return typeof cur === 'string' ? cur : dotted;
        },
    };
});

const permissions = { admin: { tenant_lifecycle: true } };
jest.mock('@/lib/tenant-context-provider', () => ({
    usePermissions: () => permissions,
    useTenantApiUrl: () => (path: string) => `/api/t/acme${path}`,
}));

const globalMutate = jest.fn(async () => undefined);
jest.mock('swr', () => ({ useSWRConfig: () => ({ mutate: globalMutate }) }));

const mutate = jest.fn(async () => undefined);
const swrState: { data: unknown; isLoading: boolean; error: unknown; mutate: typeof mutate } = {
    data: undefined,
    isLoading: false,
    error: undefined,
    mutate,
};
const requested: string[] = [];
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (path: string) => {
        requested.push(path);
        return swrState;
    },
}));

import {
    ManagedAgentsSwitchSection,
    type ManagedAgentsSwitchPayload,
} from '@/app/t/[tenantSlug]/(app)/admin/ai-features/ManagedAgentsSwitchSection';

const EN = require('../../messages/en.json') as { admin: { managedAgentsSwitch: Record<string, string> } };
const BG = require('../../messages/bg.json') as { admin: { managedAgentsSwitch: Record<string, string> } };
const COPY = EN.admin.managedAgentsSwitch;

type Setting = ManagedAgentsSwitchPayload['setting'];
const WORKSPACE_OFF: Setting = { enabled: false, deployment: 'UNSET', effective: { on: false, basis: 'WORKSPACE_OFF' } };
const WORKSPACE_ON: Setting = { enabled: true, deployment: 'UNSET', effective: { on: true, basis: 'WORKSPACE_ON' } };
const OPERATOR_OFF: Setting = { enabled: true, deployment: 'OFF', effective: { on: false, basis: 'DEPLOYMENT_OFF' } };
const OPERATOR_ON: Setting = { enabled: false, deployment: 'ON', effective: { on: true, basis: 'DEPLOYMENT_ON' } };

function arrange(setting: Setting, canChange: boolean) {
    permissions.admin.tenant_lifecycle = canChange;
    swrState.data = { setting };
    return render(<ManagedAgentsSwitchSection />);
}

const fetchMock = jest.fn();
beforeEach(() => {
    swrState.data = undefined;
    swrState.error = undefined;
    requested.length = 0;
    mutate.mockClear();
    globalMutate.mockClear();
    fetchMock.mockReset();
    (global as unknown as { fetch: typeof fetchMock }).fetch = fetchMock;
});

describe('ManagedAgentsSwitchSection', () => {
    it('reads the switch from its own route', () => {
        arrange(WORKSPACE_OFF, true);
        expect(requested).toEqual(expect.arrayContaining(['/admin/managed-agents']));
    });

    it('an owner turns it on, and the PUT carries exactly that; the engines section is refreshed too', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ setting: WORKSPACE_ON }) });
        arrange(WORKSPACE_OFF, true);
        expect(screen.getByTestId('managed-agents-switch')).toHaveAttribute('data-control', 'editable');
        expect(screen.getByTestId('managed-agents-switch-state')).toHaveTextContent(COPY.off);
        const toggle = screen.getByTestId('managed-agents-switch-toggle');
        expect(toggle).toBeEnabled();
        expect(toggle).toHaveTextContent(COPY.turnOn);

        await user.click(toggle);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/t/acme/admin/managed-agents');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({ enabled: true });
        await waitFor(() => expect(mutate).toHaveBeenCalled());
        expect(globalMutate).toHaveBeenCalledWith('/api/t/acme/admin/agent-driver');
    });

    it('an owner turns it off from on', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({ ok: true, json: async () => ({ setting: WORKSPACE_OFF }) });
        arrange(WORKSPACE_ON, true);
        expect(screen.getByTestId('managed-agents-switch-state')).toHaveTextContent(COPY.on);
        await user.click(screen.getByTestId('managed-agents-switch-toggle'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ enabled: false });
    });

    it('an admin sees the state and who can change it, and no control', () => {
        arrange(WORKSPACE_ON, false);
        expect(screen.getByTestId('managed-agents-switch')).toHaveAttribute('data-control', 'read-only');
        expect(screen.getByTestId('managed-agents-switch-state')).toHaveTextContent(COPY.on);
        expect(screen.queryByTestId('managed-agents-switch-toggle')).toBeNull();
        expect(screen.getByTestId('managed-agents-switch-owner-only')).toHaveTextContent(COPY.ownerOnly);
    });

    it.each([
        ['off', OPERATOR_OFF, 'operatorOff', 'storedOn', COPY.off],
        ['on', OPERATOR_ON, 'operatorOn', 'storedOff', COPY.on],
    ] as const)('when the operator turned it %s for every workspace, the toggle is disabled with the reason', (_dir, setting, said, stored, state) => {
        arrange(setting, true);
        expect(screen.getByTestId('managed-agents-switch')).toHaveAttribute('data-control', 'operator-decides');
        expect(screen.getByTestId('managed-agents-switch-state')).toHaveTextContent(state);
        expect(screen.getByTestId('managed-agents-switch-toggle')).toBeDisabled();
        expect(screen.getByTestId('managed-agents-switch-operator')).toHaveTextContent(COPY[said]);
        expect(screen.getByTestId('managed-agents-switch-stored')).toHaveTextContent(COPY[stored]);
    });

    it('an admin under the operator\'s override reads the reason, and still no control', () => {
        arrange(OPERATOR_OFF, false);
        expect(screen.getByTestId('managed-agents-switch-operator')).toHaveTextContent(COPY.operatorOff);
        expect(screen.queryByTestId('managed-agents-switch-toggle')).toBeNull();
    });

    it('shows a refusal rather than swallowing it', async () => {
        const user = userEvent.setup();
        fetchMock.mockResolvedValue({
            ok: false,
            status: 403,
            json: async () => ({ error: { message: 'Only an owner can turn the Managed Agents engine on or off for this workspace.' } }),
        });
        arrange(WORKSPACE_OFF, true);
        await user.click(screen.getByTestId('managed-agents-switch-toggle'));
        expect(await screen.findByTestId('managed-agents-switch-save-failed')).toHaveTextContent(/owner/);
        expect(mutate).not.toHaveBeenCalled();
    });

    it('every sentence exists in both catalogues', () => {
        expect(Object.keys(BG.admin.managedAgentsSwitch).sort()).toEqual(Object.keys(COPY).sort());
        for (const key of Object.keys(COPY)) {
            expect(typeof BG.admin.managedAgentsSwitch[key]).toBe('string');
            expect(BG.admin.managedAgentsSwitch[key]).not.toBe('');
        }
    });
});
