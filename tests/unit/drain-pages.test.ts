/**
 * `drainPages` — the replacement for four silent caps.
 *
 * Three cron dispatchers selected work with a bare `take: 1000` and logged
 * `connections: connections.length`. At the cap those two facts are
 * indistinguishable, so tenants past the boundary never synced — indefinitely,
 * under a green job run. The failure reported success, which is the only
 * reason it survived.
 *
 * These assert the property that makes the cap unnecessary: every row comes
 * back, however many pages that takes.
 */
import { drainPages, DRAIN_PAGE_SIZE } from '@/app-layer/jobs/drain-pages';

/** A fake page source over a fixed row set, recording how it was called. */
function pagedSource(total: number, pageSize = DRAIN_PAGE_SIZE) {
    const rows = Array.from({ length: total }, (_, i) => ({
        id: `id-${String(i).padStart(6, '0')}`,
    }));
    const cursors: Array<string | undefined> = [];

    const fetchPage = async (cursor: string | undefined) => {
        cursors.push(cursor);
        const start = cursor ? rows.findIndex((r) => r.id === cursor) + 1 : 0;
        return rows.slice(start, start + pageSize);
    };

    return { rows, cursors, fetchPage };
}

describe('drainPages', () => {
    it('returns every row when the set spans several pages', () => {
        // The case the old `take: 1000` got wrong. 1,250 rows is two full
        // pages plus a remainder — the shape that hides an off-by-one.
        const { fetchPage, rows } = pagedSource(1250, 500);
        return drainPages(fetchPage, 500).then((out) => {
            expect(out).toHaveLength(1250);
            expect(out.map((r) => r.id)).toEqual(rows.map((r) => r.id));
        });
    });

    it('advances the cursor past the last row of each page', async () => {
        const { fetchPage, cursors } = pagedSource(1250, 500);
        await drainPages(fetchPage, 500);
        // First call takes no cursor; each later call resumes AFTER the
        // previous page's last id. A cursor that repeated a row would
        // double-enqueue; one that skipped would silently drop work again.
        expect(cursors).toEqual([
            undefined,
            'id-000499',
            'id-000999',
        ]);
    });

    it('stops on a short page rather than querying forever', async () => {
        const { fetchPage, cursors } = pagedSource(300, 500);
        const out = await drainPages(fetchPage, 500);
        expect(out).toHaveLength(300);
        expect(cursors).toHaveLength(1);
    });

    it('handles an exact multiple without an extra row', async () => {
        // 1000 rows in pages of 500: two full pages, then one empty probe.
        // The empty probe is the cost of not knowing the total up front —
        // assert it happens exactly once, not that it never happens.
        const { fetchPage, cursors } = pagedSource(1000, 500);
        const out = await drainPages(fetchPage, 500);
        expect(out).toHaveLength(1000);
        expect(cursors).toHaveLength(3);
    });

    it('returns empty for an empty set without looping', async () => {
        const { fetchPage, cursors } = pagedSource(0, 500);
        expect(await drainPages(fetchPage, 500)).toEqual([]);
        expect(cursors).toHaveLength(1);
    });

    it('does NOT stop at 1000 — the boundary the old caps stopped at', async () => {
        // The regression this exists for, stated as its own case: the old
        // dispatchers returned exactly 1000 and reported that as the total.
        const { fetchPage } = pagedSource(1001, 500);
        const out = await drainPages(fetchPage, 500);
        expect(out).toHaveLength(1001);
    });
});
