/**
 * A number with no explicit locale is written in the READER's language —
 * the locale the root `<Providers>` binds for every date helper — never in
 * the runtime's default.
 *
 * The runtime default is a different fact on each side of hydration: the
 * server process's locale during SSR, the browser's on the client. When
 * they disagree the server writes `50,0%`, the browser `50.0%`, and React
 * logs a hydration mismatch (#5921). The bound locale is the same on both
 * sides, by construction.
 *
 * The test pins that by making the runtime default DIFFERENT from the bound
 * locale — it swaps `Intl.NumberFormat` and `Number.prototype.toLocaleString`
 * for versions whose `undefined` locale means a chosen tag, as a server
 * started with another `LANG` would — and asserting the bound one wins. A
 * component that fell back to `undefined` would print the runtime's output
 * and fail.
 */
/** @jest-environment jsdom */

import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('@number-flow/react', () => {
    // Passthrough for the `<number-flow>` custom element jsdom cannot run.
    // It formats exactly as NumberFlow does — with the `locales` it is
    // handed — so the animated branch is checked through what it passes.
    function MockNumberFlow({
        value,
        format,
        locales,
        prefix,
        suffix,
    }: {
        value: number;
        format?: Intl.NumberFormatOptions;
        locales?: Intl.LocalesArgument;
        prefix?: string;
        suffix?: string;
    }) {
        const body = new Intl.NumberFormat(locales, format).format(value);
        return (
            <span data-testid="number-flow">
                {prefix ?? ''}
                {body}
                {suffix ?? ''}
            </span>
        );
    }
    return { __esModule: true, default: MockNumberFlow };
});

import { bindDateLocale } from '@inflect/ui/lib/format-date';
import { AnimatedNumber } from '@/components/ui/animated-number';
import KpiCard from '@/components/ui/KpiCard';
import { PaginationControls } from '@/components/ui/table/pagination-controls';

const NBSP = ' ';

const RealNumberFormat = Intl.NumberFormat;
const realToLocaleString = Number.prototype.toLocaleString;

/** Make `tag` what an absent locale resolves to, as a differently configured runtime would. */
function simulateRuntimeDefault(tag: string): void {
    function NumberFormatWithDefault(
        locales?: Intl.LocalesArgument,
        options?: Intl.NumberFormatOptions,
    ): Intl.NumberFormat {
        return new RealNumberFormat(locales ?? tag, options);
    }
    NumberFormatWithDefault.prototype = RealNumberFormat.prototype;
    NumberFormatWithDefault.supportedLocalesOf = RealNumberFormat.supportedLocalesOf;
    Intl.NumberFormat = NumberFormatWithDefault as unknown as typeof Intl.NumberFormat;
    Number.prototype.toLocaleString = function toLocaleStringWithDefault(
        this: number,
        locales?: Intl.LocalesArgument,
        options?: Intl.NumberFormatOptions,
    ) {
        return realToLocaleString.call(this, locales ?? tag, options);
    };
}

afterEach(() => {
    Intl.NumberFormat = RealNumberFormat;
    Number.prototype.toLocaleString = realToLocaleString;
    bindDateLocale('en');
});

describe('the runtime-default simulation bites', () => {
    // Without this, every assertion below could pass for the wrong reason:
    // a simulation that changed nothing would leave the runtime and the
    // bound locale agreeing.
    it('an absent locale formats in the simulated runtime language', () => {
        simulateRuntimeDefault('de-DE');
        expect(new Intl.NumberFormat(undefined, { minimumFractionDigits: 1 }).format(50)).toBe('50,0');
        expect((12345).toLocaleString()).toBe('12.345');
    });
});

describe('AnimatedNumber with no locale prop writes the bound reader locale', () => {
    it('English reader on a runtime whose default is German: 50.0%, not 50,0%', () => {
        simulateRuntimeDefault('de-DE');
        bindDateLocale('en');
        render(<AnimatedNumber value={50} format={{ kind: 'percent' }} animate={false} />);
        expect(screen.getByLabelText('50.0%').textContent).toBe('50.0%');
    });

    it('Bulgarian reader on an English runtime: Bulgarian decimal and group separators', () => {
        simulateRuntimeDefault('en-US');
        bindDateLocale('bg');
        const { container } = render(
            <AnimatedNumber value={12345.6} format={{ kind: 'decimal' }} animate={false} />,
        );
        // Read the attribute raw: label queries fold the no-break space into a space.
        const number = container.querySelector('[data-animated-number]');
        expect(number?.getAttribute('aria-label')).toBe(`12${NBSP}345,6`);
        expect(number?.textContent).toBe(`12${NBSP}345,6`);
    });

    it('the animated branch hands NumberFlow the bound locale too', () => {
        simulateRuntimeDefault('en-US');
        bindDateLocale('bg');
        render(<AnimatedNumber value={50} format={{ kind: 'percent' }} />);
        // The accessible name and the digits come from two formatters;
        // both must agree with the server's, which used the same binding.
        expect(screen.getByLabelText('50,0%')).toBeTruthy();
        expect(screen.getByTestId('number-flow').textContent).toBe('50,0%');
    });

    it('an explicit locale prop still wins over the binding', () => {
        bindDateLocale('bg');
        render(<AnimatedNumber value={50} format={{ kind: 'percent' }} locale="en-US" animate={false} />);
        expect(screen.getByLabelText('50.0%')).toBeTruthy();
    });
});

describe('shared UI that formats counts follows the bound reader locale', () => {
    it('KpiCard (no provider mounted) writes its value in the reader language', () => {
        simulateRuntimeDefault('en-US');
        bindDateLocale('bg');
        const { container } = render(<KpiCard label="Controls" value={50} format="percent" />);
        expect(container.querySelector('.bg-clip-text')?.textContent).toBe('50,0%');
    });

    it('PaginationControls writes its range and total in the reader language', () => {
        simulateRuntimeDefault('de-DE');
        bindDateLocale('bg');
        render(
            <PaginationControls page={2} pageSize={10000} totalCount={123456} onPageChange={() => undefined} />,
        );
        const text = screen.getByTestId('pagination-controls').textContent ?? '';
        expect(text).toContain(`10${NBSP}001–20${NBSP}000`);
        expect(text).toContain(`123${NBSP}456`);
        // The German runtime would have written "10.001" and "123.456".
        expect(text).not.toContain('123.456');
    });
});
