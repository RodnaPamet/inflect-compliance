/**
 * THE INITIATIVES LIST NAMES ITS OWNERS AND CREATES WHAT THE API TAKES (#4851).
 *
 *   1. Each row names its owner, or says it has none.
 *   2. An empty list says so, with what to do, instead of a blank table.
 *   3. The create dialog has labelled fields and sends the owner and target
 *      date with the title; a refused create shows the server's reason.
 */
import * as React from 'react';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

jest.setTimeout(60_000);

const pushMock = jest.fn();
jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: pushMock, replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/org/acme/initiatives',
    useSearchParams: () => new URLSearchParams(),
}));
jest.mock('@/lib/nav/use-guarded-push', () => ({ useGuardedPush: () => jest.fn() }));

import { InitiativesClient } from '@/app/org/[orgSlug]/(app)/initiatives/InitiativesClient';

const EN = (require('../../messages/en.json') as { org: { initiatives: Record<string, string> } }).org.initiatives;

const row = (id: string, ownerName: string | null) => ({
    id,
    title: `Initiative ${id}`,
    status: 'IN_PROGRESS',
    ownerUserId: ownerName ? `u-${id}` : null,
    ownerName,
    targetDate: null,
    manualProgressPercent: null,
    linkCount: 0,
    tenantSpan: 0,
});

const members = [{ id: 'u-olivia', label: 'Olivia Owner' }];

afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch;
    pushMock.mockReset();
});

it('names each owner, or says there is none', () => {
    render(<InitiativesClient orgSlug="acme" canManage={false} members={[]} initiatives={[row('a', 'Olivia Owner'), row('b', null)]} />);
    const table = screen.getByTestId('org-initiatives-table');
    expect(within(table).getByText('Olivia Owner')).toBeInTheDocument();
    expect(within(table).getByText(EN.noOwner)).toBeInTheDocument();
});

it('an empty list says so, and what to do', () => {
    render(<InitiativesClient orgSlug="acme" canManage members={members} initiatives={[]} />);
    expect(screen.getByText(EN.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(EN.emptyDescManage)).toBeInTheDocument();
});

it('creates with the owner, and shows the server\'s reason when refused', async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return bodies.length === 1
            ? { ok: false, status: 400, json: async () => ({ error: { message: 'The owner must be a member of this organization.' } }) }
            : { ok: true, status: 201, json: async () => ({ initiative: { id: 'new-1' } }) };
    }) as unknown as typeof fetch;

    render(<InitiativesClient orgSlug="acme" canManage members={members} initiatives={[]} />);
    await user.click(screen.getByRole('button', { name: EN.newInitiative }));
    // The dialog is loaded when first opened.
    await user.type(await screen.findByLabelText(new RegExp(EN.titleLabel)), 'Roll out MFA');
    await user.click(screen.getByRole('combobox', { name: EN.noOwner }));
    await user.click(await screen.findByRole('option', { name: 'Olivia Owner' }));
    await user.click(screen.getByRole('button', { name: EN.createInitiative }));

    expect(await screen.findByTestId('org-initiative-create-error')).toHaveTextContent(
        'The owner must be a member of this organization.',
    );
    expect(bodies[0]).toEqual({ title: 'Roll out MFA', description: null, ownerUserId: 'u-olivia', targetDate: null });

    await user.click(screen.getByRole('button', { name: EN.createInitiative }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/org/acme/initiatives/new-1'));
});

it('the dialog loads when New initiative is clicked, with every field', async () => {
    const user = userEvent.setup();
    render(<InitiativesClient orgSlug="acme" canManage members={members} initiatives={[]} />);
    // Not part of the page until it is asked for.
    expect(screen.queryByTestId('org-initiative-create-form')).toBeNull();
    await user.click(screen.getByRole('button', { name: EN.newInitiative }));
    const form = await screen.findByTestId('org-initiative-create-form');
    expect(within(form).getByLabelText(new RegExp(EN.titleLabel))).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: EN.targetLabel })).toBeInTheDocument();
    expect(within(form).getByRole('combobox', { name: EN.noOwner })).toBeInTheDocument();
});
