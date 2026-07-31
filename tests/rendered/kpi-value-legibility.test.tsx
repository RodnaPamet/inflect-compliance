/** @jest-environment jsdom */
/**
 * The KPI headline value is legible — regression cover for the dashboard
 * CONTROLS tile that shipped rendering bare punctuation (`. %`) where
 * `11.2%` belonged.
 *
 * Two independent defects produced it, and this suite pins both:
 *
 * 1. **The clipped gradient swallowed the animated number.** KpiCard
 *    paints the value by clipping a gradient to the text
 *    (`bg-clip-text` + `text-transparent`). The ANIMATED branch of
 *    `<AnimatedNumber>` mounts `@number-flow/react`, which renders the
 *    `<number-flow>` custom element; its shadow root sets
 *    `isolation: isolate` and blends symbols with
 *    `mix-blend-mode: plus-lighter`, making the subtree its own paint
 *    group. An ancestor's text-clipped background is never painted into
 *    an isolated group, so the glyphs kept `color: transparent`. Verified
 *    in a real Chrome render: the number is invisible; engines that paint
 *    the un-clipped punctuation but not the transformed digit stacks show
 *    only the separators — the reported `. %`. The value slot must
 *    therefore use the STATIC branch (`animate={false}`), which is
 *    ordinary text and clips correctly.
 *
 * 2. **Non-finite values reached the formatter.** `isEmpty` only tested
 *    `null`/`undefined`, so a `NaN` (a collapsed ratio upstream) printed
 *    `NaN%` — or, once defect 1 hid the letters, punctuation again.
 *
 * jsdom cannot evaluate `background-clip: text`, so defect 1 is pinned
 * structurally: the element carrying the clip must contain the STATIC
 * `data-animated-number` marker, never the animated one. The paint
 * behaviour itself is a browser fact, not a testable jsdom fact — the
 * companion ratchet
 * `tests/guards/animated-number-gradient-clip.test.ts` keeps the rule
 * enforced across every future call site.
 */
import * as React from 'react';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';

import KpiCard from '@/components/ui/KpiCard';
import { HeroMetric } from '@/components/ui/HeroMetric';
import { AnimatedNumber } from '@/components/ui/animated-number';

describe('KpiCard — the gradient-clipped value is never the animated element', () => {
    it('renders the percent value inside the clipped gradient as static text', () => {
        const { container } = render(
            <KpiCard label="Controls" value={11.2} format="percent" />,
        );

        const clipped = container.querySelector('.bg-clip-text');
        expect(clipped).not.toBeNull();

        const number = clipped!.querySelector('[data-animated-number]');
        expect(number).not.toBeNull();
        // "static" = the plain-text branch. "animated" = the custom
        // element whose shadow DOM the clipped gradient cannot reach.
        expect(number).toHaveAttribute('data-animated-number', 'static');
        expect(clipped!.textContent).toBe('11.2%');
    });

    it('does not mount the number-flow custom element under the clip', () => {
        const { container } = render(
            <KpiCard label="Controls" value={11.2} format="percent" />,
        );
        const clipped = container.querySelector('.bg-clip-text');
        // The jsdom mock for `@number-flow/react` marks itself with this
        // test id; its presence under the clip is the bug.
        expect(clipped!.querySelector('[data-testid="number-flow"]')).toBeNull();
    });

    it('still renders integer KPI values legibly', () => {
        const { container } = render(<KpiCard label="Risks" value={42} />);
        expect(container.querySelector('.bg-clip-text')!.textContent).toBe('42');
    });

    it('leaves the trend indicator animated — it is not gradient-clipped', () => {
        const { container } = render(
            <KpiCard label="Controls" value={11.2} format="percent" delta={2.4} />,
        );
        const indicator = container.querySelector('[data-kpi-trend-row]');
        expect(indicator).not.toBeNull();
        expect(
            indicator!.querySelector('[data-animated-number="animated"]'),
        ).not.toBeNull();
    });
});

describe('KpiCard — non-finite values read as "no data", not as punctuation', () => {
    it.each([
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
        ['null', null],
        ['undefined', undefined],
    ])('renders "—" for %s', (_label, value) => {
        const { container } = render(
            <KpiCard label="Controls" value={value} format="percent" />,
        );
        expect(container.textContent).toContain('—');
        expect(container.textContent).not.toContain('NaN');
        expect(container.textContent).not.toContain('∞');
        // No formatter output at all — not even a stray separator.
        expect(container.querySelector('[data-animated-number]')).toBeNull();
    });

    it('renders a real zero as 0.0%, NOT as the empty placeholder', () => {
        // Zero coverage is a fact about the tenant, not missing data — a
        // fresh tenant with no implemented controls must see 0.0%.
        const { container } = render(
            <KpiCard label="Controls" value={0} format="percent" />,
        );
        expect(container.querySelector('.bg-clip-text')!.textContent).toBe('0.0%');
        expect(container.textContent).not.toContain('—');
    });

    it('suppresses the trend indicator when the value is non-finite', () => {
        const { container } = render(
            <KpiCard
                label="Controls"
                value={NaN}
                format="percent"
                previousValue={10}
            />,
        );
        expect(container.querySelector('[data-kpi-trend-row]')).toBeNull();
    });
});

describe('HeroMetric — the 72px masthead applies the same rule', () => {
    it.each([
        ['NaN', NaN],
        ['Infinity', Infinity],
    ])('renders "—" for %s rather than the formatter leftovers', (_l, value) => {
        const { container } = render(
            <HeroMetric eyebrow="Controls" value={value} format="percent" />,
        );
        const slot = container.querySelector('[data-hero-metric-value]');
        expect(slot!.textContent).toBe('—');
    });

    it('renders a finite value normally', () => {
        const { container } = render(
            <HeroMetric eyebrow="Controls" value={11.2} format="percent" />,
        );
        expect(
            container.querySelector('[data-hero-metric-value]')!.textContent,
        ).toBe('11.2%');
    });
});

describe('AnimatedNumber — the primitive rejects non-finite input', () => {
    it.each([
        ['NaN', NaN],
        ['Infinity', Infinity],
        ['-Infinity', -Infinity],
    ])('renders the placeholder for %s in both branches', (_l, value) => {
        for (const animate of [true, false]) {
            const { container } = render(
                <AnimatedNumber
                    value={value}
                    format={{ kind: 'percent' }}
                    animate={animate}
                />,
            );
            const el = container.querySelector('[data-animated-number]');
            expect(el).toHaveAttribute('data-animated-number', 'empty');
            expect(el!.textContent).toBe('—');
            // The accessible name must not announce "NaN%" either.
            expect(el).toHaveAttribute('aria-label', '—');
        }
    });

    it('formats a finite percent unchanged', () => {
        const { container } = render(
            <AnimatedNumber value={11.2} format={{ kind: 'percent' }} animate={false} />,
        );
        expect(container.textContent).toBe('11.2%');
    });
});
