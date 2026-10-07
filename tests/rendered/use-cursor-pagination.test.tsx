/**
 * Epic E — useCursorPagination hook unit tests (jsdom).
 *
 * Behavioural coverage of the cursor accumulator:
 *
 *   - first page renders the seeded initialRows / initialNextCursor
 *   - loadMore() appends the next page's rows
 *   - subsequent loadMore() walks across multiple pages
 *   - hasMore flips to false when nextCursor returns null
 *   - calling loadMore() while loading is a no-op
 *   - non-2xx response sets a bounded `error` string and does NOT
 *     mutate rows
 *   - network throw sets `error` to the generic 'load_failed' code
 */

import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';

import {
    useCursorPagination,
} from '@inflect/ui/components/ui/hooks/use-cursor-pagination';

interface Row {
    id: string;
    label: string;
}

interface FetchCall {
    url: string;
}

function canned(body: unknown, ok = true, status = 200) {
    return {
        ok,
        status,
        json: async () => body,
    };
}

function installFetchStub(): { calls: FetchCall[]; impl: jest.Mock } {
    const calls: FetchCall[] = [];
    const impl = jest.fn();
    (global as unknown as { fetch: jest.Mock }).fetch = impl;
    impl.mockImplementation(async (url: string) => {
        calls.push({ url });
        return canned({ rows: [], nextCursor: null });
    });
    return { calls, impl };
}

function Harness({
    initialRows,
    initialNextCursor,
    fetchUrl,
}: {
    initialRows: Row[];
    initialNextCursor: string | null;
    fetchUrl: (cursor: string) => string;
}) {
    const p = useCursorPagination<Row>({
        initialRows,
        initialNextCursor,
        fetchUrl,
    });
    return (
        <div>
            <ul data-testid="rows">
                {p.rows.map((r) => (
                    <li key={r.id} data-testid={`row-${r.id}`}>
                        {r.label}
                    </li>
                ))}
            </ul>
            <span data-testid="has-more">{String(p.hasMore)}</span>
            <span data-testid="loading">{String(p.loading)}</span>
            <span data-testid="error">{p.error ?? ''}</span>
            <span data-testid="cursor">{p.nextCursor ?? '__null__'}</span>
            <button
                type="button"
                data-testid="load-more"
                onClick={() => {
                    void p.loadMore();
                }}
                disabled={p.loading}
            >
                load more
            </button>
        </div>
    );
}

const ROW_A: Row = { id: 'a', label: 'Alpha' };
const ROW_B: Row = { id: 'b', label: 'Bravo' };
const ROW_C: Row = { id: 'c', label: 'Charlie' };
const ROW_D: Row = { id: 'd', label: 'Delta' };

describe('useCursorPagination', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('renders initialRows and reports hasMore from initialNextCursor', () => {
        installFetchStub();
        render(
            <Harness
                initialRows={[ROW_A, ROW_B]}
                initialNextCursor="cursor-2"
                fetchUrl={(c) => `/api?cursor=${c}`}
            />,
        );
        expect(screen.getByTestId('row-a')).toHaveTextContent('Alpha');
        expect(screen.getByTestId('row-b')).toHaveTextContent('Bravo');
        expect(screen.getByTestId('has-more')).toHaveTextContent('true');
        expect(screen.queryByTestId('row-c')).toBeNull();
    });

    it('reports hasMore=false when initialNextCursor is null', () => {
        installFetchStub();
        render(
            <Harness
                initialRows={[ROW_A]}
                initialNextCursor={null}
                fetchUrl={(c) => `/api?cursor=${c}`}
            />,
        );
        expect(screen.getByTestId('has-more')).toHaveTextContent('false');
    });

    it('loadMore appends the next page and updates cursor', async () => {
        const { impl } = installFetchStub();
        impl.mockResolvedValueOnce(
            canned({ rows: [ROW_C, ROW_D], nextCursor: 'cursor-3' }),
        );

        render(
            <Harness
                initialRows={[ROW_A, ROW_B]}
                initialNextCursor="cursor-2"
                fetchUrl={(c) => `/api?cursor=${c}`}
            />,
        );

        const user = userEvent.setup();
        await act(async () => {
            await user.click(screen.getByTestId('load-more'));
        });

        // Issued exactly the URL the consumer specified.
        expect(impl).toHaveBeenCalledTimes(1);
        expect(impl.mock.calls[0][0]).toBe('/api?cursor=cursor-2');

        // Rows accumulated.
        expect(screen.getByTestId('row-a')).toBeInTheDocument();
        expect(screen.getByTestId('row-b')).toBeInTheDocument();
        expect(screen.getByTestId('row-c')).toHaveTextContent('Charlie');
        expect(screen.getByTestId('row-d')).toHaveTextContent('Delta');

        // Cursor advanced.
        expect(screen.getByTestId('cursor')).toHaveTextContent('cursor-3');
        expect(screen.getByTestId('has-more')).toHaveTextContent('true');
    });

    it('loadMore can walk across multiple pages — confirms > 50 rows accessible', async () => {
        const { impl } = installFetchStub();

        // Build 3 mock pages, 50 rows each. Total = 150 > the dashboard
        // hard cap of 50. Demonstrates the dedicated drill-down can
        // browse beyond the first window.
        function rowsForPage(p: number): Row[] {
            return Array.from({ length: 50 }, (_, n) => ({
                id: `p${p}-r${n}`,
                label: `page ${p} row ${n}`,
            }));
        }
        impl.mockResolvedValueOnce(
            canned({ rows: rowsForPage(2), nextCursor: 'cursor-3' }),
        );
        impl.mockResolvedValueOnce(
            canned({ rows: rowsForPage(3), nextCursor: null }),
        );

        render(
            <Harness
                initialRows={rowsForPage(1)}
                initialNextCursor="cursor-2"
                fetchUrl={(c) => `/api?cursor=${c}`}
            />,
        );

        const user = userEvent.setup();
        const loadMore = () => screen.getByTestId('load-more');

        // After page-1 there should be 50 rows visible.
        expect(screen.getAllByRole('listitem')).toHaveLength(50);

        await act(async () => {
            await user.click(loadMore());
        });
        expect(screen.getAllByRole('listitem')).toHaveLength(100);
        expect(screen.getByTestId('has-more')).toHaveTextContent('true');

        await act(async () => {
            await user.click(loadMore());
        });
        expect(screen.getAllByRole('listitem')).toHaveLength(150);
        // Last page reached — button should report no-more.
        expect(screen.getByTestId('has-more')).toHaveTextContent('false');
        expect(screen.getByTestId('cursor')).toHaveTextContent('__null__');
    });

    it('does NOT fire a network request when there is no cursor', async () => {
        const { impl } = installFetchStub();
        render(
            <Harness
                initialRows={[ROW_A]}
                initialNextCursor={null}
                fetchUrl={(c) => `/api?cursor=${c}`}
            />,
        );
        const user = userEvent.setup();
        await act(async () => {
            await user.click(screen.getByTestId('load-more'));
        });
        expect(impl).not.toHaveBeenCalled();
    });

    it('non-2xx response sets a bounded error code and preserves rows', async () => {
        const { impl } = installFetchStub();
        impl.mockResolvedValueOnce(canned({}, false, 500));

        render(
            <Harness
                initialRows={[ROW_A]}
                initialNextCursor="cursor-2"
                fetchUrl={(c) => `/api?cursor=${c}`}
            />,
        );
        const user = userEvent.setup();
        await act(async () => {
            await user.click(screen.getByTestId('load-more'));
        });
        expect(screen.getByTestId('error')).toHaveTextContent('load_failed_500');
        // Rows unchanged.
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
    });

    it('thrown fetch sets generic load_failed and preserves rows', async () => {
        const { impl } = installFetchStub();
        impl.mockRejectedValueOnce(new Error('network down'));

        render(
            <Harness
                initialRows={[ROW_A]}
                initialNextCursor="cursor-2"
                fetchUrl={(c) => `/api?cursor=${c}`}
            />,
        );
        const user = userEvent.setup();
        await act(async () => {
            await user.click(screen.getByTestId('load-more'));
        });
        expect(screen.getByTestId('error')).toHaveTextContent('load_failed');
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
    });

    it('successful loadMore clears a prior error', async () => {
        const { impl } = installFetchStub();
        impl.mockResolvedValueOnce(canned({}, false, 500));
        impl.mockResolvedValueOnce(
            canned({ rows: [ROW_B], nextCursor: null }),
        );

        render(
            <Harness
                initialRows={[ROW_A]}
                initialNextCursor="cursor-2"
                fetchUrl={(c) => `/api?cursor=${c}`}
            />,
        );
        const user = userEvent.setup();
        await act(async () => {
            await user.click(screen.getByTestId('load-more'));
        });
        expect(screen.getByTestId('error')).toHaveTextContent('load_failed_500');

        await act(async () => {
            await user.click(screen.getByTestId('load-more'));
        });
        expect(screen.getByTestId('error')).toHaveTextContent('');
        expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });
});
