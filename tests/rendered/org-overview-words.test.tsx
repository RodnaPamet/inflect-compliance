/**
 * THE PORTFOLIO OVERVIEW SAYS WHAT HAPPENED, AND LETS A REMOVAL BE UNDONE (#4842).
 *
 *   1. Removing a widget takes it off the grid at once and offers Undo; the
 *      DELETE goes out only when the window closes. Undo puts it back; a
 *      refused DELETE puts it back and says so in words, never as a code
 *      such as `delete_failed_403`.
 *   2. A threat-level history that does not load says so, instead of looking
 *      like "no history".
 *   3. The empty dashboard tells an editor what to click, not a shell command.
 *   4. Health pills are words, not the stored GREEN / AMBER / RED.
 *   5. A refused threat-level save shows the server's reason.
 */
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), forward: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/org/acme-org',
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({ orgSlug: 'acme-org' }),
}));

// The grid and the dispatcher are not under test: a stand-in renders each
// widget's title and its edit-mode action slot.
jest.mock('@/components/ui/dashboard-widgets', () => ({
    DashboardGrid: ({ widgets, renderWidget }: { widgets: Array<{ id: string }>; renderWidget: (w: unknown) => React.ReactNode }) => (
        <div data-testid="grid">
            {widgets.map((w) => (
                <div key={w.id}>{renderWidget(w)}</div>
            ))}
        </div>
    ),
    WidgetPicker: () => null,
}));
jest.mock('@/app/org/[orgSlug]/(app)/widget-dispatcher', () => ({
    DispatchedWidget: ({ widget, actionsSlot }: { widget: { id: string; title: string | null }; actionsSlot: React.ReactNode }) => (
        <div data-testid={`tile-${widget.id}`}>
            <span>{widget.title}</span>
            {actionsSlot}
        </div>
    ),
}));

type Trigger = {
    action: () => Promise<unknown>;
    undoAction?: () => void;
    message: string;
    undoMessage: string;
    onError?: (e: unknown) => void;
};
const triggers: Trigger[] = [];
jest.mock('@/components/ui/hooks', () => {
    const actual = jest.requireActual('@/components/ui/hooks');
    return { ...actual, useToastWithUndo: () => (input: Trigger) => { triggers.push(input); return 'toast-1'; } };
});

import { PortfolioDashboard } from '@/app/org/[orgSlug]/(app)/PortfolioDashboard';
import { OrgThreatLevelWidget } from '@/app/org/[orgSlug]/(app)/OrgThreatLevelWidget';
import { RagPill } from '@/app/org/[orgSlug]/(app)/dashboard-sections';
import type { PortfolioData } from '@/app/org/[orgSlug]/(app)/widget-dispatcher';

const EN = (require('../../messages/en.json') as {
    org: { dashboard: Record<string, string>; widgets: Record<string, string>; health: Record<string, string> };
}).org;

function widget(id: string, title: string) {
    return {
        id,
        organizationId: 'org_1',
        type: 'KPI',
        chartType: 'coverage',
        title,
        config: {},
        position: { x: 0, y: 0 },
        size: { w: 3, h: 2 },
        enabled: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
    };
}

const data = {
    orgSlug: 'acme-org',
    summary: { generatedAt: '2026-05-03T00:00:00Z', tenants: { total: 3, snapshotted: 3, pending: 0 } },
} as unknown as PortfolioData;

afterEach(() => {
    triggers.length = 0;
    delete (globalThis as { fetch?: unknown }).fetch;
});

describe('removing a widget', () => {
    async function removeFirst() {
        const user = userEvent.setup();
        render(<PortfolioDashboard initialWidgets={[widget('w1', 'Coverage'), widget('w2', 'Risks')] as never} data={data} canEdit />);
        await user.click(screen.getByRole('button', { name: EN.dashboard.editDashboard }));
        await user.click(screen.getByTestId('dashboard-delete-widget-w1'));
    }

    it('takes it off the grid at once and offers Undo, sending nothing yet', async () => {
        (globalThis as { fetch?: unknown }).fetch = jest.fn();
        await removeFirst();
        expect(screen.queryByTestId('tile-w1')).toBeNull();
        expect(screen.getByTestId('tile-w2')).toBeInTheDocument();
        expect(triggers).toHaveLength(1);
        expect(triggers[0].message).toBe('Coverage removed');
        expect(triggers[0].undoMessage).toBe(EN.dashboard.undo);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('Undo puts it back where it was', async () => {
        await removeFirst();
        triggers[0].undoAction?.();
        await waitFor(() => expect(screen.getByTestId('tile-w1')).toBeInTheDocument());
        const tiles = screen.getAllByTestId(/^tile-/).map((el) => el.getAttribute('data-testid'));
        expect(tiles).toEqual(['tile-w1', 'tile-w2']);
    });

    it('when the window closes it sends the DELETE; a refusal puts it back and says so in words', async () => {
        (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({ ok: false, status: 403, json: async () => ({}) }));
        await removeFirst();
        await expect(triggers[0].action()).rejects.toBeTruthy();
        expect(globalThis.fetch).toHaveBeenCalledWith('/api/org/acme-org/dashboard/widgets/w1', expect.objectContaining({ method: 'DELETE' }));
        triggers[0].onError?.(new Error('request failed'));
        await waitFor(() => expect(screen.getByTestId('tile-w1')).toBeInTheDocument());
        const alert = screen.getByTestId('dashboard-error');
        expect(alert).toHaveTextContent(EN.dashboard.failedDeleteWidget);
        expect(alert.textContent ?? '').not.toMatch(/_failed_|403/);
    });
});

it('tells an editor what to click when the dashboard is empty', () => {
    render(<PortfolioDashboard initialWidgets={[]} data={data} canEdit />);
    const empty = screen.getByTestId('dashboard-empty-state');
    expect(empty).toHaveTextContent(EN.dashboard.emptyAdmin);
    expect(empty.textContent ?? '').not.toMatch(/npm run|backfill/);
});

it('says when the threat-level history did not load', async () => {
    const user = userEvent.setup();
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    render(
        <OrgThreatLevelWidget
            data={{ level: 'ELEVATED', summary: 'Phishing wave', detail: null, setAt: '2026-10-30T00:00:00Z', setByUserId: 'u', setByName: 'Olivia', isDefault: false } as never}
            canSet={false}
            showHistory
            orgSlug="acme-org"
        />,
    );
    await user.click(screen.getByRole('button', { name: new RegExp(EN.widgets.history) }));
    expect(await screen.findByTestId('threat-history-failed')).toHaveTextContent(EN.widgets.historyFailed);
    expect(screen.queryByText(EN.widgets.historyEmpty)).toBeNull();
});

it('health pills say what the stored value means', () => {
    for (const rag of ['GREEN', 'AMBER', 'RED'] as const) {
        const { unmount } = render(<RagPill rag={rag} />);
        expect(screen.getByText(EN.health[rag])).toBeInTheDocument();
        expect(screen.queryByText(rag)).toBeNull();
        unmount();
    }
});

it('a refused threat-level save shows the server\'s reason', async () => {
    const user = userEvent.setup();
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({ error: { message: 'Only an organization admin can set the threat level.' } }),
    }));
    render(
        <OrgThreatLevelWidget
            data={{ level: 'ELEVATED', summary: 'Phishing wave', detail: null, setAt: '2026-10-30T00:00:00Z', setByUserId: 'u', setByName: 'Olivia', isDefault: false } as never}
            canSet
            showHistory={false}
            orgSlug="acme-org"
        />,
    );
    await user.click(screen.getByRole('button', { name: EN.widgets.update }));
    await user.type(await screen.findByPlaceholderText(EN.widgets.headlinePlaceholder), 'Ransomware campaign');
    await user.click(screen.getByRole('button', { name: EN.widgets.setThreatLevel }));
    expect(await screen.findByText('Only an organization admin can set the threat level.')).toBeInTheDocument();
    expect(screen.queryByText(EN.widgets.setThreatFailed)).toBeNull();
});
