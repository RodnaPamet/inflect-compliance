/**
 * `<ShadedRow>` rendered tests.
 *
 * The owner's request (2026-11-22) is a LOOK — every boxed list row is its own
 * shaded box, in the tab bar's shade with the tab bar's strong outline — so the
 * contract is the classes the row renders with, on every element it can be:
 *
 *   - the shade (`bg-bg-shaded`, i.e. `--bg-shaded`) and the strong outline
 *     (`border` + `border-border-strong`) on a rounded box;
 *   - the tab bar reads the same constant, so the two cannot drift;
 *   - `as` picks the element and keeps the list semantics (`li` in a `ul`);
 *   - `padding` defaults to the rows' common `p-3` and a site's own spacing
 *     replaces it rather than stacking on it;
 *   - every other prop reaches the element.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

import { EntityDetailLayout } from '@/components/layout/EntityDetailLayout';
import { SHADED_SURFACE_CLASS, ShadedRow, shadedRowVariants } from '@/components/ui/shaded-row';

const tokens = (el: HTMLElement) => el.className.split(/\s+/).filter(Boolean);

describe('ShadedRow — the look', () => {
    it('is a rounded box with the shade and the strong outline', () => {
        render(<ShadedRow data-testid="row">v1</ShadedRow>);
        const row = screen.getByTestId('row');
        const cls = tokens(row);
        expect(cls).toContain('bg-bg-shaded');
        expect(cls).toContain('border');
        expect(cls).toContain('border-border-strong');
        expect(cls).toContain('rounded-lg');
        // Not the faint outline the hand-rolled rows used, and no second
        // background competing with the shade.
        expect(cls).not.toContain('border-border-subtle');
        expect(cls).not.toContain('border-border-default');
        expect(cls.filter((c) => c.startsWith('bg-'))).toEqual(['bg-bg-shaded']);
    });

    it('the shared surface constant is exactly the shade, the outline and the radius', () => {
        expect(SHADED_SURFACE_CLASS.split(' ').sort()).toEqual(
            ['bg-bg-shaded', 'border', 'border-border-strong', 'rounded-lg'].sort(),
        );
    });

    it('the detail-page tab bar draws its band from the same constant', () => {
        render(
            <EntityDetailLayout
                title="T"
                tabs={[
                    { key: 'a', label: 'A' },
                    { key: 'b', label: 'B' },
                ]}
                activeTab="a"
                onTabChange={() => undefined}
            >
                <div>body</div>
            </EntityDetailLayout>,
        );
        const bar = tokens(screen.getByTestId('entity-detail-tabs'));
        for (const c of SHADED_SURFACE_CLASS.split(' ')) expect(bar).toContain(c);
    });
});

describe('ShadedRow — element, padding and props', () => {
    it('renders a div by default and the element `as` names', () => {
        render(
            <>
                <ShadedRow data-testid="d">d</ShadedRow>
                <ul>
                    <ShadedRow as="li" data-testid="l">l</ShadedRow>
                </ul>
                <ShadedRow as="section" data-testid="s">s</ShadedRow>
            </>,
        );
        expect(screen.getByTestId('d').tagName).toBe('DIV');
        expect(screen.getByTestId('l').tagName).toBe('LI');
        expect(screen.getAllByRole('listitem')).toHaveLength(1);
        expect(screen.getByTestId('s').tagName).toBe('SECTION');
    });

    it('pads p-3 by default; a padding step replaces it, `none` leaves the site its own', () => {
        render(
            <>
                <ShadedRow data-testid="md">a</ShadedRow>
                <ShadedRow padding="lg" data-testid="lg">b</ShadedRow>
                <ShadedRow padding="none" className="px-4 py-3" data-testid="none">c</ShadedRow>
            </>,
        );
        expect(tokens(screen.getByTestId('md'))).toContain('p-3');
        const lg = tokens(screen.getByTestId('lg'));
        expect(lg).toContain('p-4');
        expect(lg).not.toContain('p-3');
        const none = tokens(screen.getByTestId('none'));
        expect(none.filter((c) => /^p[xy]?-/.test(c)).sort()).toEqual(['px-4', 'py-3']);
    });

    it('keeps the site layout classes and passes every other prop through', () => {
        render(
            <ShadedRow
                as="li"
                id="row-1"
                data-testid="row"
                className="flex items-center gap-compact"
                aria-label="Row one"
            >
                x
            </ShadedRow>,
        );
        const row = screen.getByTestId('row');
        expect(row.id).toBe('row-1');
        expect(row.getAttribute('aria-label')).toBe('Row one');
        expect(tokens(row)).toEqual(expect.arrayContaining(['flex', 'items-center', 'gap-compact', 'bg-bg-shaded']));
    });

    it('the variant function is callable without React (server-safe)', () => {
        expect(shadedRowVariants()).toContain('bg-bg-shaded');
        expect(shadedRowVariants({ padding: 'sm' })).toContain('p-2');
    });
});
