/**
 * KpiFilterCard accent (gradient headline value) — the dashboard KpiCard
 * colour pattern ported to the filter cards, and the Asset-page adoption.
 */
import { render } from '@testing-library/react';
import * as React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { KpiFilterCard } from '@/components/ui/kpi-filter-card';
import { KPI_ACCENTS } from '@/components/ui/kpi-accent';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// String literals are KEPT, so assertions that harvest codes or ids from source
// still see them. Every path this file reads is a TypeScript-alike, re-derived
// per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

describe('KpiFilterCard accent', () => {
    it('wraps the value in the accent gradient (bg-clip-text text-transparent) when accent is set', () => {
        const { container } = render(
            <KpiFilterCard label="Total assets" value={42} accent="indigo" />,
        );
        const grad = container.querySelector('.bg-clip-text.text-transparent');
        expect(grad).not.toBeNull();
        expect(grad!.className).toContain(KPI_ACCENTS.indigo.gradient.split(' ')[0]); // from-indigo-500
        expect(grad!.textContent).toBe('42');
    });

    it('renders no gradient span without an accent', () => {
        const { container } = render(<KpiFilterCard label="Total assets" value={42} />);
        expect(container.querySelector('.bg-clip-text.text-transparent')).toBeNull();
    });

    it('each accent applies its own from-gradient', () => {
        for (const [name, def] of Object.entries(KPI_ACCENTS)) {
            const { container } = render(
                <KpiFilterCard label="X" value={1} accent={name as keyof typeof KPI_ACCENTS} />,
            );
            const grad = container.querySelector('.bg-clip-text.text-transparent');
            expect(grad).not.toBeNull();
            expect(grad!.className).toContain(def.gradient.split(' ')[0]);
        }
    });
});

describe('AssetsClient adoption of the accent pattern', () => {
    const src = codeOf(fs.readFileSync(
        path.join(__dirname, '..', '..', 'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx'),
        'utf8',
    ));
    it('all four asset KPI cards carry a distinct accent', () => {
        // R-filter-gear (#3, 2026-06-07): the KPI grid is data-driven, so the
        // accents live in a per-id config object (`accent: 'indigo'`) and flow
        // through `accent={c.accent}` — accept the prop or the config form.
        for (const accent of ['indigo', 'emerald', 'rose', 'slate']) {
            expect(src).toMatch(
                new RegExp(`accent(="|:\\s*')${accent}('|")`),
            );
        }
    });
    it('drops the old flat tone / explicit sparklineVariant on the KPI cards', () => {
        expect(src).not.toMatch(/tone="success"/);
        expect(src).not.toMatch(/tone="attention"/);
        expect(src).not.toMatch(/sparklineVariant=/);
    });
});
