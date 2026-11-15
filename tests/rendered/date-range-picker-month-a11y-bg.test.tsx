/** @jest-environment jsdom */

/**
 * Three date-picker defects (#5309):
 *
 *   - The range picker opens on the committed range, not today's month: the
 *     calendar used to ignore the `month` the range picker controls.
 *   - Inside a `FormField`, the label names and the error describes the
 *     TRIGGER — the injected `id` and `aria-describedby` used to land on the
 *     popover calendar, which is not in the document while closed — and an
 *     invalid range trigger is painted invalid.
 *   - The range picker's own words (Clear range, its placeholder, the preset
 *     labels) are in the reader's language.
 */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), refresh: jest.fn(), prefetch: jest.fn() }),
    usePathname: () => '/',
    useSearchParams: () => new URLSearchParams(),
}));

// The catalogue is swapped per suite: English, then Bulgarian.
const mockCatalogue: { messages: Record<string, unknown> } = {
    messages: require('../../messages/en.json'),
};
jest.mock('next-intl', () => {
    const walk = (root: unknown, path: string) =>
        path.split('.').reduce(
            (o: unknown, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
            root,
        );
    const make = (ns: string) => {
        const lookup = (key: string) => walk(mockCatalogue.messages, ns ? `${ns}.${key}` : key);
        const t = (key: string, values?: Record<string, unknown>) => {
            const v = lookup(key);
            if (typeof v !== 'string') return key;
            return v.replace(/\{(\w+)\}/g, (m, name) => (values && name in values ? String(values[name]) : m));
        };
        t.has = (key: string) => typeof lookup(key) === 'string';
        return t;
    };
    // Built per call, so it reads whichever catalogue is current.
    return { useTranslations: (ns = '') => make(ns), useLocale: () => 'en' };
});

import { DatePicker } from '@/components/ui/date-picker/date-picker';
import { DateRangePicker } from '@/components/ui/date-picker/date-range-picker';
import { selectDateRangePresets } from '@/components/ui/date-picker/presets-catalogue';
import { FormField } from '@/components/ui/form-field';

const EN = require('../../messages/en.json');
const BG = require('../../messages/bg.json');

const trigger = (container: HTMLElement) =>
    container.querySelector('[data-date-picker-trigger]') as HTMLButtonElement;

afterEach(() => {
    mockCatalogue.messages = EN;
});

describe('DateRangePicker opens on the committed range', () => {
    it('shows the stored period, years from today, when opened', () => {
        const { container } = render(
            <DateRangePicker
                value={{ from: new Date(Date.UTC(2019, 0, 15)), to: new Date(Date.UTC(2019, 2, 20)) }}
            />,
        );
        act(() => {
            fireEvent.click(trigger(container));
        });
        const calendar = screen.getByTestId('calendar');
        expect(calendar.querySelector('[data-day="2019-01-15"]')).not.toBeNull();
    });
});

describe('a FormField label names the date trigger', () => {
    it('DatePicker: the label points at the trigger, and the error describes it', () => {
        const { container } = render(
            <FormField label="Next review" error="Pick a date in the future">
                <DatePicker value={null} />
            </FormField>,
        );
        const button = trigger(container);
        const label = screen.getByText('Next review').closest('label')!;
        expect(button.id).not.toBe('');
        expect(label.getAttribute('for')).toBe(button.id);
        const describedBy = (button.getAttribute('aria-describedby') ?? '').split(' ');
        const error = screen.getByText('Pick a date in the future');
        expect(describedBy).toContain(error.id);
    });

    it('DateRangePicker: the same, and the trigger is painted invalid', () => {
        const { container } = render(
            <FormField label="Audit period" error="The period is required">
                <DateRangePicker />
            </FormField>,
        );
        const button = trigger(container);
        const label = screen.getByText('Audit period').closest('label')!;
        expect(label.getAttribute('for')).toBe(button.id);
        const error = screen.getByText('The period is required');
        expect((button.getAttribute('aria-describedby') ?? '').split(' ')).toContain(error.id);
        expect(button.className).toContain('border-border-error');
    });
});

describe('DateRangePicker in Bulgarian', () => {
    it('names its placeholder, presets and Clear in Bulgarian', () => {
        mockCatalogue.messages = BG;
        const presets = selectDateRangePresets(['last-quarter', 'year-to-date']);
        const { container } = render(
            <DateRangePicker
                presets={presets}
                value={{ from: new Date(Date.UTC(2019, 0, 15)), to: new Date(Date.UTC(2019, 2, 20)) }}
            />,
        );
        act(() => {
            fireEvent.click(trigger(container));
        });
        expect(screen.getByText(BG.common.calendar.presets['last-quarter'])).toBeTruthy();
        expect(screen.getByText(BG.common.calendar.presets['year-to-date'])).toBeTruthy();
        expect(screen.getByText(BG.common.calendar.clearRange)).toBeTruthy();
        expect(screen.queryByText('Last quarter')).toBeNull();
        expect(screen.queryByText('Clear range')).toBeNull();
    });

    it('the default placeholder is Bulgarian', () => {
        mockCatalogue.messages = BG;
        const { container } = render(<DateRangePicker />);
        expect(
            trigger(container).querySelector('[data-testid="date-picker-trigger-placeholder"]')?.textContent,
        ).toBe(BG.common.calendar.selectDateRange);
    });
});
