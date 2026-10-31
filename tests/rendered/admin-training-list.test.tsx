/**
 * #4817 — the Training list says each assignment's status in words, reports an
 * open assignment past its due date as overdue (and the Overdue filter finds
 * it), searches, says the cap, and its empty state describes no page that does
 * not exist.
 */
import * as React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/training',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantHref: () => href, useTenantApiUrl: () => (p: string) => `/api/t/acme${p}` };
});

import { TrainingClient, type AssignmentRow } from '@/app/t/[tenantSlug]/(app)/admin/training/TrainingClient';
import en from '../../messages/en.json';
import bg from '../../messages/bg.json';

const row = (over: Partial<AssignmentRow> = {}): AssignmentRow => ({
    id: 'a-1',
    status: 'ASSIGNED',
    assignedAt: '2026-09-01T00:00:00.000Z',
    dueAt: '2099-01-01T00:00:00.000Z',
    completedAt: null,
    employee: { fullName: 'Ada Lovelace', workEmail: 'ada@acme.test' },
    course: { name: 'Phishing basics' },
    ...over,
});

beforeEach(() => {
    window.history.replaceState({}, '', '/t/acme/admin/training');
});

describe('status', () => {
    it('is a label, not the stored value', () => {
        render(<TrainingClient initialRows={[row({ status: 'IN_PROGRESS' })]} />);
        expect(screen.getByText(en.training.filterEnums.status.IN_PROGRESS)).toBeInTheDocument();
        expect(screen.queryByText('IN_PROGRESS')).not.toBeInTheDocument();
    });

    it('an open assignment past its due date reads Overdue', () => {
        render(<TrainingClient initialRows={[row({ dueAt: '2020-01-01T00:00:00.000Z' })]} />);
        expect(screen.getByText(en.training.filterEnums.status.OVERDUE)).toBeInTheDocument();
        expect(screen.queryByText(en.training.filterEnums.status.ASSIGNED)).not.toBeInTheDocument();
    });
});

describe('the Overdue filter', () => {
    it('finds a past-due assignment that is stored as Assigned', async () => {
        window.history.replaceState({}, '', '/t/acme/admin/training?status=OVERDUE');
        render(
            <TrainingClient
                initialRows={[
                    row({ id: 'late', dueAt: '2020-01-01T00:00:00.000Z', employee: { fullName: 'Late Larry', workEmail: 'l@acme.test' } }),
                    row({ id: 'fine', employee: { fullName: 'Prompt Pat', workEmail: 'p@acme.test' } }),
                ]}
            />,
        );
        await waitFor(() => expect(screen.queryByText('Prompt Pat')).not.toBeInTheDocument());
        expect(screen.getByText('Late Larry')).toBeInTheDocument();
    });
});

describe('search', () => {
    it('narrows by employee, email or course', async () => {
        render(
            <TrainingClient
                initialRows={[row(), row({ id: 'a-2', employee: { fullName: 'Grace Hopper', workEmail: 'g@acme.test' }, course: { name: 'Secure coding' } })]}
            />,
        );
        fireEvent.click(document.querySelector('[data-filter-trigger]') as HTMLElement);
        await waitFor(() => expect(document.querySelector('#training-search input')).not.toBeNull());
        fireEvent.change(document.querySelector('#training-search input') as HTMLInputElement, { target: { value: 'secure' } });
        await waitFor(() => expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument());
        expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    });
});

describe('the cap and the empty state', () => {
    it('says when there are more assignments than the list shows', () => {
        render(<TrainingClient initialRows={[row()]} truncated />);
        expect(screen.getByTestId('list-truncation-banner')).toBeInTheDocument();
    });

    it('does not tell anyone to create a course on a page that cannot', () => {
        render(<TrainingClient initialRows={[]} />);
        const empty = screen.getByText(en.training.emptyDesc);
        expect(within(empty.parentElement as HTMLElement).queryByText(/create a course/i)).toBeNull();
        expect(en.training.emptyDesc).not.toMatch(/create a course/i);
        expect(bg.training.emptyDesc).not.toMatch(/Създайте курс/);
    });
});
