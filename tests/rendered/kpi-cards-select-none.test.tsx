/**
 * KPI + filter cards are not text-selectable — the headline number/label
 * are filter affordances, not copyable content, so clicking shouldn't
 * highlight them. Locks `select-none` on both card chassis.
 */
import { render } from '@testing-library/react';
import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { MetricCard } from '@/components/ui/MetricCard';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

describe('KpiFilterCard is not text-selectable', () => {
    it('static card carries select-none', () => {
        const { container } = render(<KpiFilterCard label="Total" value={1} />);
        expect(container.querySelector('.select-none')).not.toBeNull();
    });
    it('clickable card carries select-none', () => {
        const { container } = render(
            <KpiFilterCard label="Total" value={1} onClick={() => {}} />,
        );
        expect(container.querySelector('.select-none')).not.toBeNull();
    });
});

describe('MetricCard (dashboard KPI chassis) is not text-selectable', () => {
    it('renders with select-none', () => {
        const { container } = render(
            <MetricCard eyebrow="Coverage">75%</MetricCard>,
        );
        expect(container.querySelector('.select-none')).not.toBeNull();
    });
    it('source pins select-none on the chassis', () => {
        const src = codeOf(fs.readFileSync(
            path.join(__dirname, '..', '..', 'src/components/ui/MetricCard.tsx'),
            'utf8',
        ));
        expect(src).toMatch(/select-none/);
    });
});
