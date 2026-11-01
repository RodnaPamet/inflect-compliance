/**
 * ONE INITIATIVE CAN BE EDITED, LINKED AND DELETED, AND SAYS WHAT IT LINKS (#4852).
 *
 *   1. Linked work is shown by name and workspace, opens the item, and a link
 *      to an item that is gone says so.
 *   2. Edit sends the fields the API takes; a refused save shows the reason.
 *   3. Link work picks a workspace, a type and an item by name, and posts it.
 *   4. Delete waits for the typed title, then returns to the list.
 *   5. A status that ends the initiative is asked first; a refused change
 *      says why instead of refreshing as if it had worked.
 *   6. A refused unlink puts the row back and says so.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

const pushMock = jest.fn();
const refreshMock = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: pushMock, replace: jest.fn(), refresh: refreshMock, back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/org/acme/initiatives/i-1',
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/lib/nav/use-guarded-push', () => ({ useGuardedPush: () => jest.fn() }));
// The undo toast renders through sonner; only its timer matters here.
jest.mock('sonner', () => ({ toast: { custom: () => 1, dismiss: (id: number) => id } }));

import { InitiativeDetailClient } from '@/app/org/[orgSlug]/(app)/initiatives/[initiativeId]/InitiativeDetailClient';
import { __resetPendingUndoToastsForTest } from '@/components/ui/hooks/use-toast-with-undo';

const ORG = (require('../../messages/en.json') as { org: Record<string, Record<string, string>> }).org;
const EN = ORG.initiativeDetail;
const STATUS_COMPLETED = ORG.widgets.statusCompleted;

const initiative = (links: Array<Record<string, unknown>> = []) => ({
    id: 'i-1',
    title: 'Roll out MFA',
    description: null,
    status: 'IN_PROGRESS',
    ownerUserId: 'u-olivia',
    ownerName: 'Olivia Owner',
    targetDate: null,
    manualProgressPercent: null,
    links: links as never,
});
const progress = { percent: 0, completed: 0, total: 0, manual: false };
const members = [{ id: 'u-olivia', label: 'Olivia Owner' }, { id: 'u-sam', label: 'Sam Second' }];
const workspaces = [{ id: 't-eu', name: 'Acme EU' }];

type Call = { url: string; method: string; body: unknown };
function mockFetch(answer: (call: Call) => { ok: boolean; status: number; body: unknown }) {
    const calls: Call[] = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
        const call = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
        calls.push(call);
        const a = answer(call);
        return { ok: a.ok, status: a.status, json: async () => a.body };
    }) as unknown as typeof fetch;
    return calls;
}

function renderPage(links: Array<Record<string, unknown>> = []) {
    return render(
        <InitiativeDetailClient
            orgSlug="acme"
            canManage
            members={members}
            workspaces={workspaces}
            initiative={initiative(links)}
            progress={progress}
        />,
    );
}

beforeEach(() => __resetPendingUndoToastsForTest());
afterEach(() => {
    jest.useRealTimers();
    delete (globalThis as { fetch?: unknown }).fetch;
    pushMock.mockReset();
    refreshMock.mockReset();
});

it('shows linked work by name and workspace, opens it, and says when an item is gone', () => {
    renderPage([
        { id: 'l-1', entityType: 'CONTROL', entityId: 'c-1', linkedTenantId: 't-eu', workspaceName: 'Acme EU', name: 'C-1 · MFA for admins', href: '/t/acme-eu/controls/c-1' },
        { id: 'l-2', entityType: 'FINDING', entityId: 'f-9', linkedTenantId: 't-eu', workspaceName: 'Acme EU', name: null, href: null },
    ]);
    const table = screen.getByTestId('initiative-links-table');
    expect(within(table).getByRole('link', { name: 'C-1 · MFA for admins' })).toHaveAttribute('href', '/t/acme-eu/controls/c-1');
    expect(within(table).getAllByText('Acme EU')).toHaveLength(2);
    expect(within(table).getByText(EN.typeControl)).toBeInTheDocument();
    expect(within(table).getByText(EN.itemGone)).toBeInTheDocument();
    // No stored id reaches the page.
    expect(table).not.toHaveTextContent('c-1');
    expect(table).not.toHaveTextContent('t-eu');
    expect(screen.getByTestId('initiative-owner')).toHaveTextContent('Olivia Owner');
});

it('an initiative with no linked work says so, and how to add some', () => {
    renderPage();
    expect(screen.getByText(EN.emptyLinksTitle)).toBeInTheDocument();
    expect(screen.getByText(EN.emptyLinksManage)).toBeInTheDocument();
});

it('edits the initiative, and shows the reason when the save is refused', async () => {
    const user = userEvent.setup();
    let n = 0;
    const calls = mockFetch(() =>
        ++n === 1
            ? { ok: false, status: 400, body: { error: { message: 'The owner must be a member of this organization.' } } }
            : { ok: true, status: 200, body: { initiative: {} } },
    );
    renderPage();
    await user.click(screen.getByRole('button', { name: EN.edit }));
    const title = await screen.findByDisplayValue('Roll out MFA');
    await user.clear(title);
    await user.type(title, 'Roll out MFA everywhere');
    await user.click(screen.getByRole('combobox', { name: EN.progressLabel }));
    await user.click(await screen.findByRole('option', { name: EN.progressByHand }));
    await user.click(screen.getByRole('button', { name: EN.save }));

    expect(await screen.findByTestId('initiative-edit-error')).toHaveTextContent('The owner must be a member of this organization.');
    expect(calls[0]).toEqual({
        url: '/api/org/acme/initiatives/i-1',
        method: 'PATCH',
        body: {
            title: 'Roll out MFA everywhere',
            description: null,
            ownerUserId: 'u-olivia',
            targetDate: null,
            manualProgressPercent: 0,
        },
    });

    await user.click(screen.getByRole('button', { name: EN.save }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
});

it('links an item chosen by workspace, type and name', async () => {
    const user = userEvent.setup();
    const calls = mockFetch((call) =>
        call.url.includes('/link-candidates')
            ? { ok: true, status: 200, body: { candidates: [{ id: 'r-7', name: 'Phishing of finance staff' }] } }
            : { ok: true, status: 201, body: { link: { id: 'l-new' } } },
    );
    renderPage();
    await user.click(screen.getByRole('button', { name: EN.linkWork }));
    const form = await screen.findByTestId('initiative-link-form');
    await user.click(within(form).getByRole('combobox', { name: EN.workspaceLabel }));
    await user.click(await screen.findByRole('option', { name: 'Acme EU' }));
    await user.click(within(form).getByRole('combobox', { name: EN.typeLabel }));
    await user.click(await screen.findByRole('option', { name: EN.typeRisk }));
    await user.click(within(form).getByRole('combobox', { name: EN.itemPlaceholder }));
    await user.click(await screen.findByRole('option', { name: 'Phishing of finance staff' }));

    const search = calls.find((c) => c.url.includes('/link-candidates'));
    expect(search?.url).toContain('tenantId=t-eu');
    expect(search?.url).toContain('type=RISK');

    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: EN.linkWork }));
    await waitFor(() => expect(refreshMock).toHaveBeenCalled());
    expect(calls.find((c) => c.method === 'POST')).toEqual({
        url: '/api/org/acme/initiatives/i-1/links',
        method: 'POST',
        body: { tenantId: 't-eu', entityType: 'RISK', entityId: 'r-7' },
    });
});

it('deletes only once the title is typed, then returns to the list', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(() => ({ ok: true, status: 200, body: { ok: true } }));
    renderPage();
    await user.click(screen.getByRole('button', { name: EN.delete }));
    const confirm = await screen.findByRole('button', { name: EN.deleteConfirm });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole('textbox'), 'Roll out');
    expect(confirm).toBeDisabled();
    await user.type(screen.getByRole('textbox'), ' MFA');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/org/acme/initiatives'));
    expect(calls).toEqual([{ url: '/api/org/acme/initiatives/i-1', method: 'DELETE', body: undefined }]);
});

it('asks before ending the initiative, and says why a refused change did not happen', async () => {
    const user = userEvent.setup();
    const calls = mockFetch(() => ({ ok: false, status: 403, body: { error: { message: 'Only an organization admin can change initiatives.' } } }));
    renderPage();
    await user.click(screen.getByTestId('initiative-status-COMPLETED'));
    // Nothing is sent before the confirmation.
    expect(calls).toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: EN.confirmStatusLabel.replace('{status}', STATUS_COMPLETED) }));
    expect(await screen.findByTestId('initiative-error')).toHaveTextContent('Only an organization admin can change initiatives.');
    expect(calls[0]).toMatchObject({ url: '/api/org/acme/initiatives/i-1/status', method: 'PUT', body: { status: 'COMPLETED' } });
    expect(refreshMock).not.toHaveBeenCalled();
});

it('a refused unlink puts the row back and says so', async () => {
    const calls = mockFetch(() => ({ ok: false, status: 403, body: { error: { message: 'Forbidden' } } }));
    renderPage([
        { id: 'l-1', entityType: 'RISK', entityId: 'r-1', linkedTenantId: 't-eu', workspaceName: 'Acme EU', name: 'Phishing of finance staff', href: '/t/acme-eu/risks/r-1' },
    ]);
    jest.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: EN.unlink }));
    // Removed at once, and nothing is sent inside the undo window.
    expect(screen.queryByText('Phishing of finance staff')).not.toBeInTheDocument();
    await act(async () => {
        await jest.advanceTimersByTimeAsync(4999);
    });
    expect(calls).toHaveLength(0);
    await act(async () => {
        await jest.advanceTimersByTimeAsync(2);
    });
    expect(calls).toEqual([{ url: '/api/org/acme/initiatives/i-1/links/l-1', method: 'DELETE', body: undefined }]);
    // The refusal used to leave the row gone until a reload brought it back.
    expect(screen.getByText('Phishing of finance staff')).toBeInTheDocument();
    expect(screen.getByTestId('initiative-error')).toHaveTextContent(EN.failedUnlink);
    expect(refreshMock).not.toHaveBeenCalled();
});
