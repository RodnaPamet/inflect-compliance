/**
 * The /tests due filter, executed.
 *
 * Two defects live here and neither is visible in the source.
 *
 * ─── 1. `?due=overdue` painted an EMPTY table, permanently ───
 *
 * `useHydratedNow()` returns `null` on the first client render — deliberately,
 * so the SSR pass and the hydration pass compare against the same instant and
 * React does not throw #418. `isOverdue(_, null)` therefore reports
 * not-overdue, also deliberately.
 *
 * The bug was that `hydratedNow` was READ inside the filter memo but missing
 * from its dependency array. So the memo computed "nothing is overdue" on the
 * first render, cached it, and never recomputed when the clock arrived. The
 * filter showed zero rows and stayed that way — and `/tests?due=overdue` is
 * exactly the link the tests dashboard hands users.
 *
 * A source scan cannot catch that: both the read and the null-guard look
 * correct in isolation, and the dep array is three lines away.
 *
 * ─── 2. There was no way to see the due QUEUE from the list ───
 *
 * `/tests/due` shows a seven-day lookahead. The list's due filter offered only
 * `overdue`, so the two surfaces could not express the same question.
 *
 * The subtle part is the shape of the window. The SERVER's `next7d` query
 * parameter carries a `gte: now` lower bound, which EXCLUDES overdue work —
 * mirroring it here would have produced a "due soon" filter that silently drops
 * the most urgent rows. `getDueQueue` itself has no lower bound. These tests
 * pin the superset relationship so a future "tidy-up" toward the server's
 * parameter shape fails loudly.
 */

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-15T12:00:00.000Z');

type Plan = { nextDueAt: string | null; nextRunAt: string | null; status: string };

/**
 * The predicates as `tests/page.tsx` defines them. They are module-private
 * there (the page is a client component with a large import graph), so they
 * are restated here and pinned against the page source below — the pairing is
 * what keeps this honest.
 */
const effectiveDue = (p: { nextDueAt: string | null; nextRunAt: string | null }): string | null => {
    const ds = [p.nextDueAt, p.nextRunAt].filter((d): d is string => d != null);
    if (ds.length === 0) return null;
    return ds.reduce((a, b) => (new Date(a) <= new Date(b) ? a : b));
};

const isOverdue = (p: Plan, now: Date | null) => {
    if (!now) return false;
    if (p.status !== 'ACTIVE') return false;
    const d = effectiveDue(p);
    return d ? new Date(d) <= now : false;
};

const DUE_SOON_WINDOW_MS = 7 * DAY;

const isDueWithin7Days = (p: Plan, now: Date | null) => {
    if (!now) return false;
    if (p.status !== 'ACTIVE') return false;
    const d = effectiveDue(p);
    return d ? new Date(d).getTime() <= now.getTime() + DUE_SOON_WINDOW_MS : false;
};

const plan = (over: Partial<Plan> = {}): Plan => ({
    status: 'ACTIVE',
    nextDueAt: null,
    nextRunAt: null,
    ...over,
});

const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

describe('due-soon is a SUPERSET of overdue, not a sibling bucket', () => {
    it('includes work that is already late', () => {
        const late = plan({ nextDueAt: at(-90 * DAY) });
        expect(isOverdue(late, NOW)).toBe(true);
        // The whole point. A `gte: now` lower bound — the shape the server's
        // `next7d` parameter uses — would make this false and hide the most
        // urgent rows behind the filter meant to surface them.
        expect(isDueWithin7Days(late, NOW)).toBe(true);
    });

    it('includes work due inside the window that is not yet late', () => {
        const soon = plan({ nextDueAt: at(3 * DAY) });
        expect(isOverdue(soon, NOW)).toBe(false);
        expect(isDueWithin7Days(soon, NOW)).toBe(true);
    });

    it('excludes work beyond the window', () => {
        const later = plan({ nextDueAt: at(8 * DAY) });
        expect(isDueWithin7Days(later, NOW)).toBe(false);
    });

    it('is inclusive at the boundary, like the server queries', () => {
        expect(isDueWithin7Days(plan({ nextDueAt: at(7 * DAY) }), NOW)).toBe(true);
        expect(isDueWithin7Days(plan({ nextDueAt: at(7 * DAY + 1) }), NOW)).toBe(false);
    });

    it('honours the earliest of the two clocks', () => {
        // nextRunAt (cron) fires first — the queue sorts by min(), so must this.
        const p = plan({ nextDueAt: at(30 * DAY), nextRunAt: at(2 * DAY) });
        expect(isDueWithin7Days(p, NOW)).toBe(true);
    });

    it.each(['PAUSED', 'ARCHIVED'])('excludes %s plans, matching getDueQueue', (status) => {
        const p = plan({ status, nextDueAt: at(-90 * DAY) });
        expect(isOverdue(p, NOW)).toBe(false);
        expect(isDueWithin7Days(p, NOW)).toBe(false);
    });

    it('excludes a plan with no due clock at all', () => {
        expect(isDueWithin7Days(plan(), NOW)).toBe(false);
    });
});

describe('the pre-hydration clock reports nothing, by design', () => {
    it.each([
        ['isOverdue', isOverdue],
        ['isDueWithin7Days', isDueWithin7Days],
    ])('%s returns false while the clock is null', (_name, fn) => {
        expect(fn(plan({ nextDueAt: at(-90 * DAY) }), null)).toBe(false);
    });
});

/**
 * The dependency-array half of defect 1, which the predicates above cannot
 * express: the null result is only correct if the memo RECOMPUTES once the
 * clock arrives.
 */
/**
 * KPI card counts must equal what the card's CLICK returns.
 *
 * The three status cards set the STATUS filter on top of whatever else is
 * active. Counting the whole fetched array meant that with, say, a frequency
 * filter set, the card advertised rows its own click would not produce — the
 * same disagreement `total` had on Policies, and reachable at any tenant size.
 *
 * Deliberately NOT lifted to a server kpiCounts like the sibling surfaces.
 * This page's filters are not all server filters: `result` comes from
 * `getLastResultKey(p)` and the due buckets from `isOverdue(p, hydratedNow)`,
 * both derived CLIENT-SIDE from the fetched row and the hydration clock. A
 * server count cannot mirror a click that filters on a value the server never
 * computes, so lifting these would have made the cards disagree with the TABLE
 * instead of with the click — trading one lie for another.
 *
 * Mirrors `filterPlans` as page.tsx defines it, pinned against the source
 * below, matching the pairing the predicates above already use.
 */
describe('KPI counts are filter-aware', () => {
    type P = Plan & { frequency: string; name: string };
    const plan = (over: Partial<P>): P => ({
        nextDueAt: null, nextRunAt: null, status: 'ACTIVE',
        frequency: 'MONTHLY', name: 'plan', ...over,
    });

    const filterPlans = (
        plans: P[],
        state: Record<string, string[] | undefined>,
        search: string,
        now: Date | null,
    ) => {
        const statusSel = state.status ?? [];
        const freqSel = state.frequency ?? [];
        const dueSel = state.due ?? [];
        const q = search.trim().toLowerCase();
        return plans.filter((p) => {
            if (statusSel.length && !statusSel.includes(p.status)) return false;
            if (freqSel.length && !freqSel.includes(p.frequency)) return false;
            if (dueSel.includes('overdue') && !isOverdue(p, now)) return false;
            if (q && !p.name.toLowerCase().includes(q)) return false;
            return true;
        });
    };

    const counts = (plans: P[], state: Record<string, string[] | undefined>, now: Date | null) => {
        const nonStatus = filterPlans(plans, { ...state, status: undefined }, '', now);
        return {
            total: plans.length,
            active: nonStatus.filter((p) => p.status === 'ACTIVE').length,
            paused: nonStatus.filter((p) => p.status === 'PAUSED').length,
        };
    };

    const FIXTURE: P[] = [
        plan({ status: 'ACTIVE', frequency: 'MONTHLY' }),
        plan({ status: 'ACTIVE', frequency: 'QUARTERLY' }),
        plan({ status: 'PAUSED', frequency: 'MONTHLY' }),
    ];

    it('counts the whole set when nothing else is filtered', () => {
        const c = counts(FIXTURE, {}, NOW);
        expect(c).toEqual({ total: 3, active: 2, paused: 1 });
    });

    it('NARROWS when another dimension is filtered — the card predicts its click', () => {
        const c = counts(FIXTURE, { frequency: ['MONTHLY'] }, NOW);
        // One ACTIVE monthly, one PAUSED monthly. The quarterly ACTIVE plan is
        // excluded because clicking "Active" would not show it either.
        expect(c.active).toBe(1);
        expect(c.paused).toBe(1);
    });

    it('IGNORES the status filter itself — the cards replace that dimension', () => {
        // With status=PAUSED set, the Active card must still count the ACTIVE
        // plans: clicking it REPLACES the status selection rather than
        // intersecting with it.
        const c = counts(FIXTURE, { status: ['PAUSED'] }, NOW);
        expect(c.active).toBe(2);
    });

    it('`total` stays the whole set — its click clears every filter', () => {
        expect(counts(FIXTURE, { frequency: ['MONTHLY'] }, NOW).total).toBe(3);
    });

    it('respects the hydration clock like the table does', () => {
        const overdue = plan({ status: 'ACTIVE', nextDueAt: '2026-01-01T00:00:00.000Z' });
        const withDue = counts([overdue, ...FIXTURE], { due: ['overdue'] }, NOW);
        expect(withDue.active).toBe(1);
        // Pre-hydration the clock is null and nothing reads as overdue — the
        // same null-safety the table relies on, not a separate rule.
        expect(counts([overdue, ...FIXTURE], { due: ['overdue'] }, null).active).toBe(0);
    });
});

describe('the filter memo depends on the hydrated clock', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    const path = require('node:path') as typeof import('node:path');
    const src = fs.readFileSync(
        path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)/tests/page.tsx'),
        'utf8',
    );

    it('`hydratedNow` is in the filtered-plans dependency array', () => {
        // Without it the memo caches the pre-hydration "nothing is overdue"
        // verdict forever and the filter shows an empty table.
        expect(src).toMatch(/\}, \[plans, state, search, hydratedNow\]\);/);
    });

    it('the page defines the due-soon predicate the queue uses', () => {
        expect(src).toMatch(/const isDueWithin7Days = \(/);
        // Upper bound only — no `gte`/lower-bound reconstruction.
        expect(src).toMatch(/<= now\.getTime\(\) \+ DUE_SOON_WINDOW_MS/);
    });

    /**
     * The mirror above is only honest if the page really does compute its card
     * counts from the filtered set. These pin the two halves that make it true.
     */
    it('the counts run through the SAME predicate as the table', () => {
        // One implementation, two callers. Two copies would drift, and the
        // drift IS the defect: a card disagreeing with the table it filters.
        expect(src).toMatch(/function filterPlans\(/);
        expect(src).toMatch(/const filteredPlans = useMemo\(\(\) => \{\s*return filterPlans\(/);
    });

    it('the card counts drop the status dimension the cards themselves set', () => {
        // `{ ...state, status: undefined }` is the whole mechanism: count what
        // the click would show, which means every OTHER filter but not this one.
        expect(src).toMatch(
            /filterPlans\(plans, \{ \.\.\.state, status: undefined \}, search, hydratedNow\)/,
        );
    });

    it('the due filter offers both buckets', () => {
        const defs = fs.readFileSync(
            path.resolve(__dirname, '../../src/app/t/[tenantSlug]/(app)/tests/filter-defs.ts'),
            'utf8',
        );
        expect(defs).toMatch(/TEST_DUE_KEYS = \['overdue', 'next7d'\]/);
    });
});
