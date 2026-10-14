/**
 * Phase 1 of list-page-shell — rendered DOM contract for
 * `<ListPageShell>` and `<DataTable fillBody>`.
 *
 * The user-visible promise is "page header + filter toolbar +
 * pagination footer stay anchored; only the table body scrolls."
 * Layout fidelity (actual scroll behaviour at a given viewport) is
 * a manual / Playwright concern. What we lock down here is the
 * class-name contract that delivers that behaviour:
 *
 *   • The shell root carries `data-list-page-shell="true"` so the
 *     print-stylesheet escape can target it (without that hook,
 *     printing a viewport-clamped page would only print the rows
 *     visible above the fold).
 *   • The shell root and its Body slot carry the flex-chain
 *     classes that allow children to shrink — the `min-h-0` /
 *     `flex-1` / `overflow-hidden` triad on md+ that nothing else
 *     in the page should override.
 *   • DataTable's `fillBody` prop composes the same classes onto
 *     its outer container + scroll wrapper so the table is the
 *     only scroll context inside the shell body.
 *
 * If a future refactor strips one of those classes the layout
 * silently falls back to the old "whole page scrolls" behaviour —
 * no runtime error, just bad UX. These assertions catch that.
 */

import React from 'react';
import { render } from '@testing-library/react';
import { ListPageShell } from '@/components/layout/ListPageShell';
import { DataTable, createColumns } from '@/components/ui/table/data-table';
import { EntityListPage } from '@/components/layout/EntityListPage';

describe('ListPageShell — slot contract', () => {
    it('root carries the data-list-page-shell hook + flex-column chain', () => {
        const { container } = render(
            <ListPageShell>
                <div data-testid="child" />
            </ListPageShell>
        );
        const root = container.querySelector(
            '[data-list-page-shell="true"]',
        );
        expect(root).not.toBeNull();
        const cls = root!.className;
        expect(cls).toContain('flex');
        expect(cls).toContain('flex-col');
        // md+ flex-1 + min-h-0 are the load-bearing classes for the
        // viewport-clamped chain to actually clamp.
        expect(cls).toContain('md:flex-1');
        expect(cls).toContain('md:min-h-0');
    });

    it('Body slot fills remaining space and clips its own overflow on md+', () => {
        const { getByTestId } = render(
            <ListPageShell>
                <ListPageShell.Body>
                    <div data-testid="body-child" />
                </ListPageShell.Body>
            </ListPageShell>
        );
        const bodyChild = getByTestId('body-child');
        const body = bodyChild.parentElement!;
        const cls = body.className;
        // The four invariants the design relies on:
        expect(cls).toContain('md:flex-1');
        expect(cls).toContain('md:flex');
        expect(cls).toContain('md:flex-col');
        expect(cls).toContain('md:overflow-hidden');

        // ── AND A FLOOR, which is the fifth and the newest (#3524) ──
        //
        // This assertion was `toContain('md:min-h-0')` until 2026-10-14. The
        // class it now forbids is the one that let the body be crushed to
        // nothing: `min-h-0` permits a flex child to shrink below its content,
        // which the body's own `overflow-hidden` needs, but it sets no lower
        // bound — so everything above the body (title, banners, KPI strip,
        // filter toolbar) takes its height first and the body gets the
        // remainder, which at 1280x720 can reach nearly zero.
        //
        // A crushed body does not read as a layout bug. The table renders at
        // its natural height inside an `overflow-hidden` parent, so every row
        // keeps a real bounding box and only the CLIPPING hides it. Hit testing
        // follows the clipping ancestor, so a click aimed at a row lands on
        // `<main>` or the sticky header, while anything measuring the row's box
        // to answer "is it visible?" says yes. Three E2E specs spent 3.6 minutes
        // each retrying a click on a row that was present, measurable, and off
        // screen.
        //
        // Asserted BOTH ways on purpose. The positive half pins the floor; the
        // negative half is what actually fails if somebody re-adds `min-h-0`,
        // because `cn` is `twMerge` and the last `min-h-*` wins — so a
        // reinstated `min-h-0` would silently delete the floor while leaving
        // this file's positive assertion satisfied by the string it replaced.
        expect(cls).toContain('md:min-h-[20rem]');
        expect(cls).not.toContain('md:min-h-0');
    });

    it('Header / Filters / Footer slots are flex-shrink-0 so they keep natural height', () => {
        const { getByText } = render(
            <ListPageShell>
                <ListPageShell.Header>HEADER</ListPageShell.Header>
                <ListPageShell.Filters>FILTERS</ListPageShell.Filters>
                <ListPageShell.Footer>FOOTER</ListPageShell.Footer>
            </ListPageShell>
        );
        for (const text of ['HEADER', 'FILTERS', 'FOOTER']) {
            expect(getByText(text).className).toContain('flex-shrink-0');
        }
    });

    it('renders the Header as a semantic <header> and Footer as <footer>', () => {
        const { getByText } = render(
            <ListPageShell>
                <ListPageShell.Header>HEAD</ListPageShell.Header>
                <ListPageShell.Footer>FOOT</ListPageShell.Footer>
            </ListPageShell>
        );
        expect(getByText('HEAD').tagName).toBe('HEADER');
        expect(getByText('FOOT').tagName).toBe('FOOTER');
    });
});

/**
 * The banner is chrome, not table content (#3524).
 *
 * `EntityListPage` used to render `banner` inside `<ListPageShell.Body>`, above
 * the `<DataTable fillBody>`. The body is the viewport-clamped region with
 * `overflow-hidden`, and `fillBody` makes the table `flex-1` inside it — so a
 * banner there takes its natural height first and the table gets whatever is
 * left. Measured on `/agents` at 1280x720 with three notice panels: the body was
 * 394px, the table's box 34px, its own sticky header 37px, and the first row
 * landed at y701..762 against a 720px viewport. Playwright's click point came
 * out at (774, 731) — off screen — so `elementFromPoint` returned `null` and no
 * hit test could ever pass, while the row stayed "visible, enabled and stable"
 * because it still had a real box.
 *
 * Asserted STRUCTURALLY rather than by measuring, because jsdom has no layout:
 * the question "is the banner inside the clamped region?" is answerable from the
 * tree, and it is the question that matters. A test that tried to assert
 * heights here would assert zeros.
 */
describe('EntityListPage — the banner is outside the clamped body (#3524)', () => {
    it('renders the banner OUTSIDE [data-list-page-body], and the table inside it', () => {
        const { container } = render(
            <EntityListPage
                header={{ title: 'Things' }}
                banner={<div data-testid="the-banner">notice</div>}
                table={{
                    'data-testid': 'things-table',
                    data: [],
                    columns: [],
                    getRowId: () => 'x',
                }}
            />,
        );

        const body = container.querySelector('[data-list-page-body]');
        expect(body).not.toBeNull();

        const banner = container.querySelector('[data-testid="the-banner"]');
        expect(banner).not.toBeNull();

        // The assertion, both halves. The positive half alone would pass if the
        // banner vanished altogether, and the negative half alone would pass if
        // the body stopped existing — so the pair is what pins it.
        expect(body!.contains(banner!)).toBe(false);
        expect(container.contains(banner!)).toBe(true);
    });

    it('still renders the banner when there are no filters and no kpis', () => {
        // The slot it moved into was gated on `(filters || kpis)`. A page that
        // passes only a banner would have lost it entirely — which is the way
        // this change could have silently deleted a notice surface.
        const { getByTestId } = render(
            <EntityListPage
                header={{ title: 'Things' }}
                banner={<div data-testid="lonely-banner">notice</div>}
                table={{
                    'data-testid': 'things-table',
                    data: [],
                    columns: [],
                    getRowId: () => 'x',
                }}
            />,
        );
        expect(getByTestId('lonely-banner')).toBeInTheDocument();
    });
});

describe('DataTable — fillBody composes the flex-fill classes', () => {
    type Row = { id: string; name: string };
    const columns = createColumns<Row>([
        { accessorKey: 'name', header: 'Name' },
    ]);
    const data: Row[] = [{ id: '1', name: 'Alpha' }];

    it('without fillBody the table renders without the md flex classes (legacy default)', () => {
        const { container } = render(
            <DataTable
                data={data}
                columns={columns}
                data-testid="legacy-table"
            />
        );
        const wrap = container.querySelector('#legacy-table');
        expect(wrap).not.toBeNull();
        // The Table primitive's outer container should not have
        // gained the fillBody classes.
        const outerCard = wrap!.querySelector('.border-border-subtle');
        expect(outerCard?.className ?? '').not.toContain('md:flex-1');
    });

    it('with fillBody the outer container gets the flex-column + clip classes', () => {
        const { container } = render(
            <DataTable
                fillBody
                data={data}
                columns={columns}
                data-testid="filled-table"
            />
        );
        const wrap = container.querySelector('#filled-table');
        const outerCard = wrap!.querySelector('.border-border-subtle');
        const cls = outerCard?.className ?? '';
        expect(cls).toContain('md:flex');
        expect(cls).toContain('md:flex-col');
        expect(cls).toContain('md:min-h-0');
        expect(cls).toContain('md:overflow-hidden');
    });

    it('with fillBody the scroll wrapper gets max-h-full + min-h-0 + overflow-y-auto', () => {
        // Updated for content-sized cards — fillBody dropped flex-1
        // in favour of max-h-full so the wrapper can shrink to
        // content height (Evidence with 1 row, empty state) and
        // only grows up to its parent allocation.
        const { container } = render(
            <DataTable
                fillBody
                data={data}
                columns={columns}
                data-testid="filled-table-2"
            />
        );
        const wrap = container.querySelector('#filled-table-2');
        const scrollWrapper = wrap!.querySelector('.overflow-x-auto');
        expect(scrollWrapper).not.toBeNull();
        const cls = scrollWrapper!.className;
        expect(cls).toContain('md:max-h-full');
        expect(cls).toContain('md:min-h-0');
        expect(cls).toContain('md:overflow-y-auto');
        // Defensive: the legacy flex-1 must NOT be present anymore.
        expect(cls).not.toContain('md:flex-1');
    });
});
