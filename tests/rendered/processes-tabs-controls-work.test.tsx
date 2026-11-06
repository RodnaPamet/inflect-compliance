/** @jest-environment jsdom */

/**
 * The Rules and Monitor tabs offer only controls that work.
 *
 * Each case below was a control on the Processes page that did nothing, said
 * the wrong thing, or was offered to a role the server refuses:
 *
 *   • the Rules table had a checkbox column with no bulk action, and selection
 *     took the single click, so opening a rule took a double click;
 *   • the sheet's enable switch and priority stepper read the row as it was
 *     when the sheet opened, so each change snapped back on screen;
 *   • a refused change read "[object Object]", or nothing at all;
 *   • the sheet's "Re-trigger" said "Re-run queued" for a run the server never
 *     queued (the replay endpoint answers 200 with `enqueued: false`);
 *   • the Status filter offered "Archived", which can only ever match nothing:
 *     an archived rule is soft-deleted and the list excludes it;
 *   • Monitor's "Test a rule" was offered to every role, while both its
 *     buttons need the write tier.
 */
import * as React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react';

const sonner = {
    custom: jest.fn(), dismiss: jest.fn(), success: jest.fn(),
    error: jest.fn(), warning: jest.fn(), info: jest.fn(),
    message: jest.fn(), loading: jest.fn(),
};
jest.mock('sonner', () => ({
    Toaster: () => null,
    toast: Object.assign((m: string) => m, sonner),
}));

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/processes',
    useSearchParams: () => new URLSearchParams(),
    useSelectedLayoutSegment: () => null,
    useSelectedLayoutSegments: () => [],
    notFound: jest.fn(),
    redirect: jest.fn(),
}));

import { SWRConfig } from 'swr';
import { RulesTab, type AutomationRuleRow } from '@/app/t/[tenantSlug]/(app)/processes/RulesTab';
import { MonitorTab } from '@/app/t/[tenantSlug]/(app)/processes/MonitorTab';
import { buildRuleFilters } from '@/app/t/[tenantSlug]/(app)/processes/automation-filter-defs';
import { TenantProvider } from '@/lib/tenant-context-provider';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutProvider } from '@/lib/hooks/use-keyboard-shortcut';

const RULE: AutomationRuleRow = {
    id: 'rule-1', name: 'Notify owner on overdue task', triggerEvent: 'TASK_OVERDUE',
    actionType: 'NOTIFY_USER', status: 'ENABLED', priority: 10,
    executionCount: 0, lastTriggeredAt: null,
};

const TENANT_CTX = {
    userId: 'user-1', tenantId: 'tenant-1', tenantSlug: 'acme', tenantName: 'Acme',
    role: 'ADMIN' as const,
    permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true, canExport: true },
} as never;

type Responder = (url: string, init?: RequestInit) => { status: number; body: unknown } | null;

let patchResponder: Responder = () => null;
let rules: AutomationRuleRow[] = [RULE];
const fetchMock = jest.fn();

beforeEach(() => {
    jest.clearAllMocks();
    rules = [{ ...RULE }];
    patchResponder = (_url, init) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Partial<AutomationRuleRow>;
        rules = rules.map((r) => ({ ...r, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) }));
        return { status: 200, body: rules[0] };
    };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        const reply = (status: number, body: unknown) => ({
            ok: status >= 200 && status < 300, status,
            text: async () => JSON.stringify(body), json: async () => body,
        }) as Response;
        if (init?.method === 'PATCH' && u.includes('/automation/rules/rule-1')) {
            const r = patchResponder(u, init)!;
            return reply(r.status, r.body);
        }
        if (u.endsWith('/automation/rules')) return reply(200, rules);
        if (u.includes('/automation/rules/rule-1/executions')) return reply(200, { items: [], nextCursor: null });
        if (u.includes('/automation/rules/rule-1')) return reply(200, { ...rules[0], triggerFilterJson: null, actionConfigJson: {} });
        if (u.includes('/automation/executions')) return reply(200, { stuck: [], recent: [] });
        return reply(200, []);
    });
    (global as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
    delete (global as unknown as { fetch?: unknown }).fetch;
});

function wrap(node: React.ReactNode) {
    const cache = new Map();
    return render(
        <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, shouldRetryOnError: false }}>
            <TenantProvider value={TENANT_CTX}>
                <KeyboardShortcutProvider>
                    <TooltipProvider>{node}</TooltipProvider>
                </KeyboardShortcutProvider>
            </TenantProvider>
        </SWRConfig>,
    );
}

async function openRuleSheet(canManage = true): Promise<HTMLElement> {
    const view = wrap(<RulesTab tenantSlug="acme" canManage={canManage} />);
    await waitFor(() => expect(view.getByText(RULE.name)).toBeTruthy());
    await act(async () => {
        fireEvent.click(view.getByText(RULE.name));
    });
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
    return document.querySelector('[role="dialog"]') as HTMLElement;
}

describe('the Rules table', () => {
    it('has no checkbox column, and a SINGLE click opens the rule', async () => {
        const sheet = await openRuleSheet();
        expect(sheet.textContent).toContain(RULE.name);
        expect(document.querySelector('[data-testid="automation-rules-table"] input[type="checkbox"]')).toBeNull();
        expect(document.querySelector('[data-testid="automation-rules-table"] [role="checkbox"]')).toBeNull();
    });

    it('does not offer an Archived status filter, which could only match nothing', () => {
        const filters = buildRuleFilters((k) => k, (k) => k) as Array<{
            key: string;
            options?: Array<{ value: string }>;
        }>;
        const status = filters.find((f) => f.key === 'status');
        const values = (status?.options ?? []).map((o) => o.value);
        expect(values).toEqual(expect.arrayContaining(['DRAFT', 'ENABLED', 'DISABLED']));
        expect(values).not.toContain('ARCHIVED');
    });
});

describe('the rule sheet', () => {
    it('the enable switch shows the change it just made', async () => {
        const sheet = await openRuleSheet();
        const toggle = sheet.querySelector('[role="switch"]') as HTMLElement;
        expect(toggle.getAttribute('aria-checked')).toBe('true');
        await act(async () => {
            fireEvent.click(toggle);
        });
        await waitFor(() =>
            expect((sheet.querySelector('[role="switch"]') as HTMLElement).getAttribute('aria-checked')).toBe('false'),
        );
        const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
        expect(JSON.parse(String((patch![1] as RequestInit).body))).toMatchObject({ status: 'DISABLED' });
    });

    it("a refused change says the server's reason, not [object Object]", async () => {
        patchResponder = () => ({
            status: 403,
            body: { error: { code: 'FORBIDDEN', message: 'Only an admin can change automation rules' } },
        });
        const sheet = await openRuleSheet();
        await act(async () => {
            fireEvent.click(sheet.querySelector('[role="switch"]') as HTMLElement);
        });
        await waitFor(() => expect(sonner.error).toHaveBeenCalled());
        const message = String(sonner.error.mock.calls[0]![0]);
        expect(message).toBe('Only an admin can change automation rules');
        // And the switch is back where the server left it.
        await waitFor(() =>
            expect((sheet.querySelector('[role="switch"]') as HTMLElement).getAttribute('aria-checked')).toBe('true'),
        );
    });

    it('carries no Re-trigger: running a rule by hand is Monitor\'s, which reports the outcome', async () => {
        const sheet = await openRuleSheet();
        const labels = Array.from(sheet.querySelectorAll('button')).map((b) => b.textContent?.trim());
        expect(labels).not.toContain('Re-trigger');
    });
});

describe('Monitor', () => {
    it('offers "Test a rule" only to a role that can run one', async () => {
        const reader = wrap(<MonitorTab />);
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(reader.queryByText('Test a rule')).toBeNull();
        reader.unmount();

        const editor = wrap(<MonitorTab canExecute />);
        await waitFor(() => expect(editor.getByText('Test a rule')).toBeTruthy());
    });
});
