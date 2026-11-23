/**
 * No status badge and no eyebrow label renders under 12 px.
 *
 * Owner decision (2026-11-23, #5871 / #5872): small text goes to 12 px
 * everywhere, desktop included. `<StatusBadge size="sm">` was 10 px and the
 * KPIStat / MetaStrip eyebrow labels were 11 px — the shared causes of most of
 * the "text under 12 px" pages a phone audit found.
 *
 * jsdom computes no Tailwind, so each element's font-size UTILITY is read off
 * its class list and converted to pixels: Tailwind's named scale, or an
 * arbitrary `text-[Npx]` / `text-[Nrem]`. An element with no size utility
 * fails too — it would inherit, and a floor nobody set is not a floor.
 */
import { render, screen } from '@testing-library/react';
import * as React from 'react';

import { StatusBadge } from '@/components/ui/status-badge';
import { KPIStat } from '@/components/ui/metric';
import { MetaStrip } from '@/components/ui/meta-strip';

const NAMED_PX: Record<string, number> = {
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    '2xl': 24,
    '3xl': 30,
};

function fontSizePx(el: Element): number | null {
    const sizes: number[] = [];
    for (const cls of Array.from(el.classList)) {
        // Only unprefixed utilities set the base size.
        if (cls.includes(':')) continue;
        const named = /^text-(xs|sm|base|lg|xl|2xl|3xl)$/.exec(cls);
        if (named) sizes.push(NAMED_PX[named[1]]);
        const px = /^text-\[(\d+(?:\.\d+)?)px\]$/.exec(cls);
        if (px) sizes.push(Number(px[1]));
        const rem = /^text-\[(\d+(?:\.\d+)?)rem\]$/.exec(cls);
        if (rem) sizes.push(Number(rem[1]) * 16);
    }
    if (sizes.length === 0) return null;
    // With conflicting utilities the CSS winner is order-dependent; judge the
    // smallest, so a stray small class cannot hide behind a large one.
    return Math.min(...sizes);
}

function expectAtLeast12(el: Element) {
    const px = fontSizePx(el);
    expect({ className: el.className, px }).toEqual({
        className: el.className,
        px: expect.any(Number),
    });
    expect(px).toBeGreaterThanOrEqual(12);
}

describe('small text floor: 12 px', () => {
    it('the reader itself: 10 px and 11 px are under the floor, text-xs is on it', () => {
        const el = document.createElement('span');
        el.className = 'px-1.5 text-[10px]';
        expect(fontSizePx(el)).toBe(10);
        el.className = 'text-[11px] uppercase';
        expect(fontSizePx(el)).toBe(11);
        el.className = 'text-xs md:text-[10px]';
        expect(fontSizePx(el)).toBe(12);
        el.className = 'uppercase';
        expect(fontSizePx(el)).toBeNull();
    });

    it.each(['sm', 'md'] as const)('StatusBadge size=%s renders at 12 px or more', (size) => {
        render(
            <StatusBadge size={size} variant="success">
                Implemented
            </StatusBadge>,
        );
        const badge = screen.getByText('Implemented');
        expectAtLeast12(badge);
    });

    it('StatusBadge with no size (the default) renders at 12 px or more', () => {
        render(<StatusBadge variant="warning">Draft</StatusBadge>);
        expectAtLeast12(screen.getByText('Draft'));
    });

    it.each(['sm', 'md'] as const)('the KPIStat eyebrow label (size=%s) is 12 px or more', (size) => {
        render(<KPIStat label="Open risks" value={7} size={size} />);
        expectAtLeast12(screen.getByText('Open risks'));
    });

    it('every MetaStrip label, and its status badge, is 12 px or more', () => {
        render(
            <MetaStrip
                items={[
                    { label: 'Owner', value: 'Jane Smith' },
                    { kind: 'status', label: 'Status', value: 'Published', variant: 'success' },
                    { kind: 'metric', label: 'Coverage', value: '82%' },
                ]}
            />,
        );
        for (const label of ['Owner', 'Status', 'Coverage', 'Published']) {
            expectAtLeast12(screen.getByText(label));
        }
    });
});
