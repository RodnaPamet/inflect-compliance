/**
 * `<SortOrder>` — the DataTable column-header sort indicator.
 *
 * Regression lock for the `<path d="undefined">` console error, from when
 * each path's `d` was morphed by framer-motion: every rendered path has a
 * valid `d`. The paths are static now (the order flips their group), and
 * the icon must stay free of the animation engine: it is exported from the
 * icons barrel, which the shell's primitives import, so an engine import
 * here is an engine in every route's first load.
 */
import { render } from '@testing-library/react';
import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { SortOrder } from '@inflect/ui/components/ui/icons/sort-order';

describe('SortOrder — no d="undefined" on mount', () => {
    it.each(['asc', 'desc', null] as const)(
        'order=%s renders two paths with a valid (M…) d, never "undefined"',
        (order) => {
            const { container } = render(<SortOrder order={order} />);
            const paths = container.querySelectorAll('path');
            expect(paths.length).toBe(2);
            paths.forEach((p) => {
                const d = p.getAttribute('d');
                expect(d).toBeTruthy();
                expect(d).not.toBe('undefined');
                expect(d).toMatch(/^M/);
            });
        },
    );

    it('ascending is the descending chevrons turned upside down; nothing else moves', () => {
        const flipped = (order: 'asc' | 'desc' | null) =>
            (render(<SortOrder order={order} />).container.querySelector('g') as SVGGElement)
                .style.transform;
        expect(flipped('asc')).toBe('scaleY(-1)');
        expect(flipped('desc')).toBe('');
        expect(flipped(null)).toBe('');
    });

    it('needs no animation engine: the icon is in every route through the icons barrel', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'packages/ui/src/components/ui/icons/sort-order.tsx'),
            'utf8',
        );
        expect(src).not.toMatch(/from ["']motion|from ["']framer-motion/);
    });
});
