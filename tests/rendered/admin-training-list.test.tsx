/**
 * The Training list (#4817, #5764 item 6). It says each assignment's status in
 * words and reports an open assignment past its due date as overdue. It is
 * paged on the server: the filter bar writes the search and the status to the
 * URL, which the server page applies in SQL; "Load more" reads the next page
 * with the filters the server applied; the header counts every match, not the
 * page; and no banner claims that filtering reveals rows the list cannot reach.
 */
import * as React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// The repo-wide next-intl mock substitutes `{name}` only, so the header's
// `{total, plural, …}` would stay a template and an assertion on the COUNT
// would be an assertion on a template. This one also evaluates flat plurals
// and `{x, number}`. Memoised per namespace: a fresh `t` per render would
// invalidate every `useMemo([t])` below it.
jest.mock('next-intl', () => {
    const en = jest.requireActual('../../messages/en.json');
    const lookup = (ns: string, key: string) =>
        `${ns}.${key}`.split('.').reduce<unknown>(
            (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            en,
        );
    const PLURAL = /\{(\w+),\s*plural,((?:\s*(?:=\d+|one|other)\s*\{[^{}]*\})+)\s*\}/g;
    const OPTION = /(=\d+|one|other)\s*\{([^{}]*)\}/g;
    const has = (p: Record<string, unknown> | undefined, n: string) => !!p && Object.prototype.hasOwnProperty.call(p, n);
    const format = (str: string, params?: Record<string, unknown>) =>
        str
            .replace(PLURAL, (block: string, name: string, options: string) => {
                if (!has(params, name)) return block;
                const n = Number(params![name]);
                const forms = new Map<string, string>();
                for (const m of options.matchAll(OPTION)) forms.set(m[1], m[2]);
                const body = forms.get(`=${n}`) ?? (n === 1 ? forms.get('one') : undefined) ?? forms.get('other');
                return body === undefined ? block : body.split('#').join(String(n));
            })
            .replace(/\{(\w+)(?:,\s*number)?\}/g, (m: string, name: string) => (has(params, name) ? String(params![name]) : m));
    const cache = new Map<string, unknown>();
    const makeT = (ns: string) => {
        const t = (key: string, params?: Record<string, unknown>) => {
            const val = lookup(ns, key);
            return typeof val === 'string' ? format(val, params) : key;
        };
        t.rich = t;
        t.markup = t;
        t.raw = (k: string) => lookup(ns, k);
        t.has = (k: string) => lookup(ns, k) !== undefined;
        return t;
    };
    return {
        useTranslations: (ns = '') => {
            if (!cache.has(ns)) cache.set(ns, makeT(ns));
            return cache.get(ns);
        },
        useLocale: () => 'en',
        useFormatter: () => ({ dateTime: String, number: String, relativeTime: String, list: (l: string[]) => l.join(', ') }),
        NextIntlClientProvider: ({ children }: { children: React.ReactNode }) => children,
    };
});

const routerReplace = jest.fn();
jest.mock('next/navigation', () => ({
    useParams: () => ({ tenantSlug: 'acme' }),
    useRouter: () => ({ push: jest.fn(), replace: routerReplace, refresh: jest.fn(), back: jest.fn(), forward: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/t/acme/admin/training',
    useSearchParams: () => new URLSearchParams(),
}));

jest.mock('@/lib/tenant-context-provider', () => {
    const href = (path: string) => `/t/acme${path.startsWith('/') ? path : `/${path}`}`;
    return { useTenantHref: () => href, useTenantApiUrl: () => (p: string) => `/api/t/acme${p.startsWith('/') ? p : `/${p}`}` };
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

const person = (id: string, fullName: string) =>
    row({ id, employee: { fullName, workEmail: `${id}@acme.test` } });

let fetchMock: jest.Mock;

beforeEach(() => {
    window.history.replaceState({}, '', '/t/acme/admin/training');
    routerReplace.mockClear();
    fetchMock = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
});

function lastReplacedUrl(): URL {
    const calls = routerReplace.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return new URL(String(calls[calls.length - 1][0]), 'http://localhost');
}

const loadMoreButton = () => document.getElementById('training-load-more-button') as HTMLElement;

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

describe("the filters are the server's", () => {
    it("a search goes to the URL the server page reads, and the rows stay the server's", async () => {
        render(
            <TrainingClient
                initialRows={[row(), row({ id: 'a-2', employee: { fullName: 'Grace Hopper', workEmail: 'g@acme.test' }, course: { name: 'Secure coding' } })]}
                total={2}
            />,
        );
        fireEvent.click(document.querySelector('[data-filter-trigger]') as HTMLElement);
        await waitFor(() => expect(document.querySelector('#training-search input')).not.toBeNull());
        fireEvent.change(document.querySelector('#training-search input') as HTMLInputElement, { target: { value: 'secure' } });
        await waitFor(() => expect(lastReplacedUrl().searchParams.get('q')).toBe('secure'));
        // Nothing filters in the browser any more: until the server answers
        // with the matching first page, the list is the page it rendered.
        expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
        expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    });

    it('the header counts what the server matched, and says so when filtered', () => {
        render(
            <TrainingClient
                initialRows={[row({ id: 'late', dueAt: '2020-01-01T00:00:00.000Z' })]}
                total={734}
                filters={{ q: '', statuses: ['OVERDUE'] }}
            />,
        );
        expect(screen.getByText('734 assignments match the search and filters.')).toBeInTheDocument();
    });

    it('unfiltered, the header counts every assignment, not the page', () => {
        render(<TrainingClient initialRows={[row()]} initialNextCursor="c1" total={734} />);
        expect(screen.getByText('734 security-awareness training assignments.')).toBeInTheDocument();
    });
});

describe('paging', () => {
    it("Load more reads the next page with the server's filters and appends it", async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ rows: [person('p2', 'Page Two')], nextCursor: null, total: 2 }),
        });
        render(
            <TrainingClient
                initialRows={[person('p1', 'Page One')]}
                initialNextCursor="cursor-1"
                total={2}
                filters={{ q: 'page', statuses: ['ASSIGNED', 'OVERDUE'] }}
            />,
        );
        expect(screen.queryByText('Page Two')).not.toBeInTheDocument();
        expect(within(document.getElementById('training-load-more') as HTMLElement).getByText('Showing 1 of 2')).toBeInTheDocument();

        await act(async () => {
            fireEvent.click(loadMoreButton());
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const url = new URL(String(fetchMock.mock.calls[0][0]), 'http://localhost');
        expect(url.pathname).toBe('/api/t/acme/training');
        expect(url.searchParams.get('cursor')).toBe('cursor-1');
        expect(url.searchParams.get('q')).toBe('page');
        expect(url.searchParams.get('status')).toBe('ASSIGNED,OVERDUE');
        expect(url.searchParams.get('limit')).toBe('100');

        expect(await screen.findByText('Page Two')).toBeInTheDocument();
        expect(screen.getByText('Page One')).toBeInTheDocument();
        // The last page: nothing more to load.
        expect(document.getElementById('training-load-more')).toBeNull();
    });

    it('a new first page from the server replaces the rows loaded for the old filters', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => ({ rows: [person('p2', 'Page Two')], nextCursor: null, total: 2 }),
        });
        const { rerender } = render(
            <TrainingClient initialRows={[person('p1', 'Page One')]} initialNextCursor="cursor-1" total={2} />,
        );
        await act(async () => {
            fireEvent.click(loadMoreButton());
        });
        expect(await screen.findByText('Page Two')).toBeInTheDocument();

        rerender(
            <TrainingClient
                initialRows={[person('m1', 'Match Only')]}
                initialNextCursor={null}
                total={1}
                filters={{ q: 'match', statuses: [] }}
            />,
        );
        expect(await screen.findByText('Match Only')).toBeInTheDocument();
        expect(screen.queryByText('Page One')).not.toBeInTheDocument();
        expect(screen.queryByText('Page Two')).not.toBeInTheDocument();
    });

    it('a failed page says so and keeps the rows it has', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
        render(<TrainingClient initialRows={[person('p1', 'Page One')]} initialNextCursor="cursor-1" total={2} />);
        await act(async () => {
            fireEvent.click(loadMoreButton());
        });
        expect(await screen.findByRole('alert')).toHaveTextContent(en.training.loadFailed);
        expect(screen.getByText('Page One')).toBeInTheDocument();
    });

    it('shows no banner telling anyone that filters reveal the rest', () => {
        render(<TrainingClient initialRows={[row()]} initialNextCursor="cursor-1" total={900} />);
        expect(screen.queryByTestId('list-truncation-banner')).not.toBeInTheDocument();
    });
});

describe('the empty state', () => {
    it('does not tell anyone to create a course on a page that cannot', () => {
        render(<TrainingClient initialRows={[]} total={0} />);
        const empty = screen.getByText(en.training.emptyDesc);
        expect(within(empty.parentElement as HTMLElement).queryByText(/create a course/i)).toBeNull();
        expect(en.training.emptyDesc).not.toMatch(/create a course/i);
        expect(bg.training.emptyDesc).not.toMatch(/Създайте курс/);
    });

    it('says "no matching" when the server applied a filter', () => {
        render(<TrainingClient initialRows={[]} total={0} filters={{ q: 'nobody', statuses: [] }} />);
        expect(screen.getByText(en.training.emptyMatchingTitle)).toBeInTheDocument();
    });
});
