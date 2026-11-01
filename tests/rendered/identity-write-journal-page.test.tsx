/** @jest-environment jsdom */
/**
 * The identity write journal names whose account each entry is about, who
 * made it, and in words what happened; a reference opens its entry; the
 * captured state reads as fields (#4877).
 *
 * Before: the table showed provider, action, status, time and the actor's raw
 * user id, all as stored codes; a reference quoted in a disable notification
 * could only be found by eye; the captured state was raw JSON; a failed read of
 * the backlog looked like "nothing outstanding"; the breadcrumb began at
 * Integrations.
 */
import * as React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

let search = new URLSearchParams();
jest.mock('next/navigation', () => ({
    useSearchParams: () => search,
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn() }),
    usePathname: () => '/t/acme/admin/identity-write-journal',
    useParams: () => ({ tenantSlug: 'acme' }),
}));

const HREF = (p: string) => `/t/acme${p}`;
jest.mock('@/lib/tenant-context-provider', () => ({ useTenantHref: () => HREF }));

// The trail as text, so its steps can be asserted.
jest.mock('@/components/layout/PageBreadcrumbs', () => ({
    PageBreadcrumbs: ({ items }: { items: Array<{ label: string; href?: string }> }) => (
        <nav data-testid="crumbs">{items.map((i) => `${i.label}${i.href ? `(${i.href})` : ''}`).join(' / ')}</nav>
    ),
}));

const ROW = {
    journalId: 'jr_applied_1',
    linkId: 'link-ana',
    provider: 'entra-id',
    action: 'DISABLE_ACCOUNT',
    mode: 'AUTOMATIC',
    outcome: 'APPLIED',
    attemptedAt: '2026-09-12T05:00:00.000Z',
    settledAt: '2026-09-12T05:00:02.000Z',
    actorUserId: 'user-owner',
};
const PENDING = { ...ROW, journalId: 'jr_pending_1', outcome: 'INDETERMINATE', linkId: 'link-gone', actorUserId: null };
const PEOPLE = {
    accounts: { 'link-ana': { name: 'Ana Petrova', email: 'ana@acme.test' } },
    actors: { 'user-owner': { name: 'Ivo Owner', email: 'ivo@acme.test' } },
};

type Reply = { data?: unknown; error?: unknown };
let replies: Record<string, Reply> = {};
jest.mock('@/lib/hooks/use-tenant-swr', () => ({
    useTenantSWR: (key: string | null) => {
        const r = key ? replies[key] : undefined;
        return { data: r?.data, error: r?.error, isLoading: false, mutate: jest.fn() };
    },
}));

import { JournalClient } from '@/app/t/[tenantSlug]/(app)/admin/identity-write-journal/JournalClient';

const en = require('../../messages/en.json');
const J = en.admin.identityWriteJournal;

beforeEach(() => {
    search = new URLSearchParams();
    replies = {
        '/admin/identity-write-journal': { data: { writes: [ROW], ...PEOPLE } },
        '/admin/identity-write-journal/unsettled': { data: { writes: [PENDING], minutes: 30, accounts: {}, actors: {} } },
        [`/admin/identity-write-journal/${ROW.journalId}`]: {
            data: {
                write: { ...ROW, priorState: { accountEnabled: true, userPrincipalName: 'ana@acme.test', groups: [] } },
                ...PEOPLE,
            },
        },
    };
});

const history = () => screen.getByTestId('identity-write-journal-history-table');

it('names whose account, who acted, and what happened, in words', () => {
    render(<JournalClient />);
    const table = within(history());
    expect(table.getByText('Ana Petrova · ana@acme.test')).toBeTruthy();
    expect(table.getByText('Ivo Owner · ivo@acme.test')).toBeTruthy();
    expect(table.getByText(J.action.DISABLE_ACCOUNT)).toBeTruthy();
    expect(table.getByText(J.outcome.APPLIED)).toBeTruthy();
    expect(table.getByText('Microsoft Entra ID')).toBeTruthy();
    expect(history().textContent).not.toMatch(/DISABLE_ACCOUNT|APPLIED|user-owner|entra-id/);
});

it('says a link that no longer exists, and a scheduled run, rather than an id', () => {
    render(<JournalClient />);
    const backlog = within(screen.getByTestId('identity-write-journal-unsettled-table'));
    expect(backlog.getByText(J.accountGone)).toBeTruthy();
    expect(backlog.getByText(J.actorScheduled)).toBeTruthy();
    expect(backlog.getByText(J.outcome.INDETERMINATE)).toBeTruthy();
});

it('opens the entry a reference in the address names, with the captured state as fields', () => {
    search = new URLSearchParams(`ref=${ROW.journalId}`);
    render(<JournalClient />);
    const entry = within(document.getElementById('identity-write-journal-entry')!);
    expect(entry.getByText('Ana Petrova · ana@acme.test')).toBeTruthy();
    const prior = within(document.getElementById('identity-write-journal-prior-state')!);
    expect(prior.getByText('accountEnabled')).toBeTruthy();
    expect(prior.getByText(J.valueYes)).toBeTruthy();
    expect(prior.getByText('userPrincipalName')).toBeTruthy();
    expect(prior.getByText(J.valueEmpty)).toBeTruthy();
    // No raw JSON block on the page.
    expect(document.querySelector('pre')).toBeNull();
});

it('opens a pasted reference, and says plainly when there is no such entry', () => {
    replies['/admin/identity-write-journal/jr_missing'] = { error: Object.assign(new Error('nf'), { status: 404 }) };
    render(<JournalClient />);
    fireEvent.change(document.getElementById('identity-write-journal-reference')!, { target: { value: '  jr_missing ' } });
    fireEvent.click(screen.getByRole('button', { name: J.findOpen }));
    expect(screen.getByText(J.referenceNotFound.replace('{ref}', 'jr_missing'))).toBeTruthy();
});

it('says the backlog could not be read, rather than showing none', () => {
    replies['/admin/identity-write-journal/unsettled'] = { error: new Error('boom') };
    render(<JournalClient />);
    expect(screen.getByText(J.unsettledLoadFailed)).toBeTruthy();
    expect(screen.queryByTestId('identity-write-journal-unsettled-table')).toBeNull();
});

it('the breadcrumb starts at the dashboard', () => {
    render(<JournalClient />);
    expect(screen.getByTestId('crumbs').textContent).toBe(
        `Dashboard(/t/acme/dashboard) / Admin(/t/acme/admin) / Integrations(/t/acme/admin/integrations) / ${J.breadcrumb}`,
    );
});
