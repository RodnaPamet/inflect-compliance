/**
 * A page's KPI tiles are one scrolling strip on a phone and a grid from md up
 * (#5895, owner decision 2026-11-23).
 *
 * Four to seven tiles in a two-column grid filled a phone's first screen
 * before the list they summarise. `<KpiStrip>` lays them out in one row below
 * `md` — fixed, compact tiles that do not shrink, so the row scrolls — with
 * its end edge faded and a trailing spacer, so the cut tile says there is
 * more and the last one can scroll clear. From `md` up the same list is the
 * grid it was. jsdom applies no media query, so the layout is held by the
 * classes that make it.
 */
import { render, screen, within } from '@testing-library/react';
import * as React from 'react';

import { KpiStrip, KPI_STRIP_LIST_CLASS } from '@/components/ui/kpi-strip';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';

jest.mock('@/components/ui/mini-area-chart', () => ({ MiniAreaChart: () => null }));

const EN = jest.requireActual('../../messages/en.json') as { ui: { kpiStrip: Record<string, string> } };

const IDS = ['total', 'implemented', 'inProgress', 'notStarted'];

function Row() {
    return (
        <KpiStrip>
            {IDS.map((id) => (
                <KpiFilterCard key={id} label={id} value={7} onClick={() => {}} data-testid={`kpi-${id}`} />
            ))}
        </KpiStrip>
    );
}

const group = () => screen.getByRole('group', { name: EN.ui.kpiStrip.label });
const classes = () => group().className.split(/\s+/);

describe('KpiStrip', () => {
    it('is a named group of the tiles, rendered once, in one list', () => {
        render(<Row />);
        const tiles = IDS.map((id) => within(group()).getByTestId(`kpi-${id}`));
        for (const tile of tiles) expect(tile.parentElement).toBe(group());
        expect(screen.getAllByTestId('kpi-total')).toHaveLength(1);
    });

    it('lays the tiles in one row that scrolls on a phone, compact and unshrinking', () => {
        render(<Row />);
        // A flex row that scrolls sideways…
        expect(classes()).toEqual(expect.arrayContaining(['flex', 'overflow-x-auto']));
        // …whose tiles keep a fixed width and do not shrink to fit, so the row
        // scrolls rather than squeezing four tiles into one screen…
        expect(classes()).toEqual(expect.arrayContaining(['max-md:*:w-40', 'max-md:*:shrink-0', 'max-md:*:p-3']));
        // …and whose headline figures are smaller there.
        expect(classes()).toContain('max-md:[&_[data-metric-value]]:text-xl');
    });

    it('cues the overflow on a phone: the end edge fades, and a spacer clears the last tile', () => {
        render(<Row />);
        const mask = classes().find((c) => c.startsWith('max-md:[mask-image:'));
        expect(mask).toBe('max-md:[mask-image:linear-gradient(to_right,black_calc(100%-3rem),transparent)]');
        expect(classes()).toEqual(
            expect.arrayContaining(['max-md:after:w-8', 'max-md:after:shrink-0', "max-md:after:content-['']"]),
        );
    });

    it('is the grid it was from md up, and carries nothing phone-only there', () => {
        render(<Row />);
        expect(classes()).toEqual(expect.arrayContaining(['md:grid', 'md:grid-cols-4', 'md:gap-default', 'md:overflow-visible']));
        // Every sizing, padding and cue class is behind `max-md:`.
        const unscoped = KPI_STRIP_LIST_CLASS.split(/\s+/).filter((c) => /^(w-|shrink-|p-|text-|after:|\[mask)/.test(c));
        expect(unscoped).toEqual([]);
    });

    it('takes the page\'s own grid columns and gap from md up', () => {
        render(
            <KpiStrip columns="md:grid-cols-3 lg:grid-cols-7" gridGap="md:gap-compact">
                <div>a</div>
            </KpiStrip>,
        );
        expect(classes()).toEqual(expect.arrayContaining(['md:grid-cols-3', 'lg:grid-cols-7', 'md:gap-compact']));
        expect(classes()).not.toContain('md:grid-cols-4');
        expect(classes()).not.toContain('md:gap-default');
    });
});
