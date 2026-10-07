/**
 * `<SortOrder>` — the DataTable column-header sort indicator.
 *
 * Regression lock for the `<path d="undefined">` console error: each
 * `<motion.path>` must carry an `initial={{ d }}` seed so framer-motion
 * never morphs `d` from the element's empty mount state (which set
 * `d="undefined"` and logged an SVG error for every sortable column on
 * every list page). Both a behavioural check (rendered paths have a valid
 * `d`) and a structural lock (the source keeps `initial={{ d`).
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

    it('source seeds initial={{ d }} on both motion paths', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'packages/ui/src/components/ui/icons/sort-order.tsx'),
            'utf8',
        );
        const initials = src.match(/initial=\{\{\s*d:/g) ?? [];
        expect(initials.length).toBeGreaterThanOrEqual(2);
    });
});
