/**
 * VR-4 — Automation inspector panel renders the right per-kind form and the
 * unsynced hint when the node has no linked rule.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import * as React from 'react';

const mockSWR = jest.fn();
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (...args: unknown[]) => mockSWR(...args),
}));
jest.mock('@/lib/tenant-context-provider', () => ({
    useTenantApiUrl: () => (p: string) => p,
}));
const toastError = jest.fn();
jest.mock('@/components/ui/hooks', () => ({
    useToast: () => ({ error: toastError, success: jest.fn(), info: jest.fn(), warning: jest.fn() }),
}));
// The builder is a 1,500-line form with its own tests; what matters here is
// that the panel opens it for the right rule.
jest.mock('@/components/processes/RuleBuilderModal', () => ({
    RuleBuilderModal: ({ editRule }: { editRule: { id: string } | null }) => (
        <div data-testid="rule-builder-open">{editRule?.id}</div>
    ),
}));

import { AutomationInspectorPanel } from '@/components/processes/AutomationInspectorPanel';

const RULE = {
    id: 'r1',
    name: 'My rule',
    description: null,
    triggerEvent: 'RISK_CREATED',
    triggerFilterJson: null,
    actionType: 'NOTIFY_USER',
    actionConfigJson: {},
    status: 'ENABLED',
    slaWindowMinutes: null,
    readiness: [] as string[],
};
const ROWS = [
    { id: 'r1', name: 'Notify the owner', triggerEvent: 'RISK_CREATED', actionType: 'NOTIFY_USER', status: 'ENABLED', priority: 0, executionCount: 0, lastTriggeredAt: null },
    { id: 'r2', name: 'Open a task', triggerEvent: 'RISK_CREATED', actionType: 'CREATE_TASK', status: 'DRAFT', priority: 0, executionCount: 0, lastTriggeredAt: null },
];

function serve(rule: typeof RULE = RULE) {
    mockSWR.mockImplementation((key: string | null) => {
        if (key === null) return { data: undefined, mutate: jest.fn() };
        if (key.endsWith('/automation/rules')) return { data: ROWS, mutate: jest.fn() };
        return { data: rule, mutate: jest.fn() };
    });
}

const fetchMock = jest.fn();
beforeEach(() => {
    jest.clearAllMocks();
    serve();
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
});

describe('AutomationInspectorPanel', () => {
    it('an Action step with no rule yet says to save the map', () => {
        render(<AutomationInspectorPanel kind="action" ruleIds={[]} tenantSlug="acme" canManageRules />);
        expect(screen.getByTestId('automation-inspector-unsynced').textContent).toMatch(/Save the map/);
    });

    it('a Trigger step wired to nothing says to connect it, not to save', () => {
        render(<AutomationInspectorPanel kind="trigger" ruleIds={[]} tenantSlug="acme" canManageRules />);
        expect(screen.getByTestId('automation-inspector-unsynced').textContent).toMatch(/Connect this step/);
    });

    it('a Trigger step leading to an unsaved Action says to save', () => {
        render(<AutomationInspectorPanel kind="trigger" ruleIds={[]} unsavedOwners={1} tenantSlug="acme" canManageRules />);
        expect(screen.getByTestId('automation-inspector-unsynced').textContent).toMatch(/Save the map/);
    });

    it('renders the trigger-event field for a trigger node', () => {
        render(<AutomationInspectorPanel kind="trigger" ruleIds={['r1']} tenantSlug="acme" canManageRules />);
        expect(screen.getByTestId('automation-inspector')).toBeInTheDocument();
        expect(screen.getByText('Trigger event')).toBeInTheDocument();
    });

    it('a Trigger step names every rule it sets', () => {
        render(<AutomationInspectorPanel kind="trigger" ruleIds={['r1', 'r2']} tenantSlug="acme" canManageRules />);
        const fed = screen.getByTestId('automation-inspector-fed-rules');
        expect(fed.textContent).toContain('Notify the owner');
        expect(fed.textContent).toContain('Open a task');
    });

    it('renders the action-type field for an action node', () => {
        render(<AutomationInspectorPanel kind="action" ruleIds={['r1']} tenantSlug="acme" canManageRules />);
        expect(screen.getByText('Action type')).toBeInTheDocument();
    });

    it('Edit action opens the rule builder for THIS step\'s rule', () => {
        render(<AutomationInspectorPanel kind="action" ruleIds={['r1']} tenantSlug="acme" canManageRules />);
        fireEvent.click(screen.getByTestId('automation-inspector-edit-action'));
        expect(screen.getByTestId('rule-builder-open').textContent).toBe('r1');
    });

    it('Edit conditions opens the builder for the rule the Condition step feeds', () => {
        render(<AutomationInspectorPanel kind="condition" ruleIds={['r2']} tenantSlug="acme" canManageRules />);
        fireEvent.click(screen.getByTestId('automation-inspector-edit-conditions'));
        expect(screen.getByTestId('rule-builder-open').textContent).toBe('r2');
    });

    it('says what a rule still needs before it can be enabled', () => {
        serve({ ...RULE, status: 'DRAFT', readiness: ['TRIGGER_NOT_SET', 'ACTION_INCOMPLETE'] });
        render(<AutomationInspectorPanel kind="action" ruleIds={['r1']} tenantSlug="acme" canManageRules />);
        const notice = screen.getByTestId('automation-inspector-readiness');
        expect(notice.textContent).toMatch(/trigger event/i);
        expect(notice.textContent).toMatch(/action/i);
    });

    it("a refused enable shows the server's reason", async () => {
        serve({ ...RULE, status: 'DRAFT' });
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 400,
            json: async () => ({ error: { code: 'VALIDATION', message: 'This rule cannot be enabled yet: choose the event that triggers it.' } }),
        });
        render(<AutomationInspectorPanel kind="action" ruleIds={['r1']} tenantSlug="acme" canManageRules />);
        await act(async () => {
            fireEvent.click(screen.getByRole('switch'));
        });
        expect(toastError).toHaveBeenCalledWith('This rule cannot be enabled yet: choose the event that triggers it.');
    });

    it('renders the execution-watchdog field for an slaGate node', () => {
        render(<AutomationInspectorPanel kind="slaGate" ruleIds={['r1']} tenantSlug="acme" canManageRules />);
        // PR-E — "SLA window" was relabelled to an honest "execution watchdog".
        expect(screen.getByText('Execution watchdog (max minutes)')).toBeInTheDocument();
    });
});

describe('a viewer who may not change rules (#5283, #5284)', () => {
    it('offers no rule write: the switch, name, trigger and edit buttons are inert', async () => {
        render(<AutomationInspectorPanel kind="action" ruleIds={['r1']} tenantSlug="acme" />);
        expect(screen.getByRole('switch')).toBeDisabled();
        expect(screen.getByTestId('automation-inspector-edit-action')).toBeDisabled();
        await act(async () => {
            fireEvent.click(screen.getByRole('switch'));
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('the enable switch goes through PATCH, which refuses an archived rule', async () => {
        serve({ ...RULE, status: 'DISABLED' });
        render(<AutomationInspectorPanel kind="action" ruleIds={['r1']} tenantSlug="acme" canManageRules />);
        await act(async () => {
            fireEvent.click(screen.getByRole('switch'));
        });
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(init.method).toBe('PATCH');
        expect(JSON.parse(String(init.body))).toEqual({ status: 'ENABLED' });
    });
});
