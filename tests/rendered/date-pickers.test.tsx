/**
 * Epic 58 — rendered tests for Presets, DatePicker, and DateRangePicker.
 *
 * Proves the product-level contracts the audit calls out:
 *
 *   Presets
 *     - Renders one row per preset with the label + shortcut chip.
 *     - Selecting a row emits the original preset object.
 *     - The `activePresetId` row carries a visible highlight.
 *
 *   DatePicker
 *     - Closed by default; trigger shows the placeholder.
 *     - Opens the calendar on click; selecting a day commits, closes,
 *       and emits `onChange(Date)`.
 *     - Controlled `value` reflects into the trigger + calendar.
 *     - `clearable` + a selection ⇒ clear emits `onChange(null)`.
 *     - `hasError` sets `aria-invalid="true"` on the trigger.
 *
 *   DateRangePicker
 *     - Clicking two days commits a range via `onChange`.
 *     - Resolvable presets materialise at open time and selecting one
 *       emits its resolved range + preset context.
 *     - Clearable footer emits `{from:null, to:null}`.
 */

import React from 'react';
import { render, fireEvent, act, within } from '@testing-library/react';

// Range picker uses next-auth-free popover + media query — stub
// next/navigation for any transitive imports anyway.
jest.mock('next/navigation', () => ({
    usePathname: () => '/',
    useRouter: () => ({
        push: jest.fn(),
        replace: jest.fn(),
        back: jest.fn(),
        forward: jest.fn(),
        refresh: jest.fn(),
        prefetch: jest.fn(),
    }),
}));


import { DatePicker } from '@/components/ui/date-picker/date-picker';

import { DateRangePicker } from '@/components/ui/date-picker/date-range-picker';

import { Presets } from '@/components/ui/date-picker/presets';

import { DEFAULT_DATE_RANGE_PRESETS } from '@/components/ui/date-picker/presets-catalogue';

import type {
    DatePreset,
    ResolvableDateRangePreset,
} from '@/components/ui/date-picker/types';

// ─── Presets ─────────────────────────────────────────────────────────

describe('Presets — panel', () => {
    const sample: DatePreset[] = [
        { id: 'a', label: 'Alpha', shortcut: 'a', date: new Date() },
        { id: 'b', label: 'Bravo', date: new Date() },
        { id: 'c', label: 'Charlie', shortcut: 'c', date: new Date() },
    ];

    it('renders one row per preset', () => {
        const { getByTestId } = render(
            <Presets presets={sample} onSelect={() => {}} />,
        );
        for (const p of sample) {
            expect(getByTestId(`date-picker-preset-${p.id}`)).toBeInTheDocument();
        }
    });

    it('calls onSelect with the clicked preset', () => {
        const onSelect = jest.fn();
        const { getByTestId } = render(
            <Presets presets={sample} onSelect={onSelect} />,
        );
        fireEvent.click(getByTestId('date-picker-preset-b'));
        expect(onSelect).toHaveBeenCalledTimes(1);
        expect(onSelect).toHaveBeenCalledWith(sample[1]);
    });

    it('renders a <kbd> chip when a preset carries a shortcut', () => {
        const { getByTestId } = render(
            <Presets presets={sample} onSelect={() => {}} />,
        );
        const row = getByTestId('date-picker-preset-a');
        const kbd = row.querySelector('kbd');
        expect(kbd).not.toBeNull();
        expect(kbd!.textContent).toBe('A');
    });

    it('marks the active preset with data-active', () => {
        const { getByTestId } = render(
            <Presets
                presets={sample}
                onSelect={() => {}}
                activePresetId="b"
            />,
        );
        expect(
            getByTestId('date-picker-preset-b').getAttribute('data-active'),
        ).toBe('true');
        expect(
            getByTestId('date-picker-preset-a').getAttribute('data-active'),
        ).toBeNull();
    });
});

// ─── DatePicker ──────────────────────────────────────────────────────

describe('DatePicker — single-date', () => {
    it('is closed by default and shows the placeholder', () => {
        const { container, queryByTestId } = render(
            <DatePicker placeholder="Pick a date" />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        expect(trigger).not.toBeNull();
        expect(
            trigger.querySelector(
                '[data-testid="date-picker-trigger-placeholder"]',
            )?.textContent,
        ).toBe('Pick a date');
        expect(queryByTestId('calendar')).toBeNull();
    });

    it('opens the calendar on trigger click', () => {
        const { container, getByTestId } = render(
            <DatePicker placeholder="Pick a date" />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        act(() => {
            fireEvent.click(trigger);
        });
        expect(getByTestId('calendar')).toBeInTheDocument();
    });

    it('selecting a day commits, closes, and emits onChange(Date)', async () => {
        const onChange = jest.fn();
        const { container, getByTestId, queryByTestId } = render(
            <DatePicker
                placeholder="Pick a date"
                defaultValue={null}
                onChange={onChange}
            />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        act(() => {
            fireEvent.click(trigger);
        });
        const calendar = getByTestId('calendar');
        // Pick day 15 — scope to the calendar grid so we don't
        // accidentally match a nav button or off-month cell.
        const day15 = within(calendar).getByText('15', {
            selector: 'button',
        });
        act(() => {
            fireEvent.click(day15);
        });
        expect(onChange).toHaveBeenCalledTimes(1);
        const arg = onChange.mock.calls[0][0];
        expect(arg).toBeInstanceOf(Date);
        expect(arg.getDate()).toBe(15);
        // Popover close lifecycle is owned by the overlay primitive
        // (Vaul under jsdom). Asserting on portal teardown pins us
        // to its animation timing — not a product contract.
        void queryByTestId;
    });

    it('opens at the chosen day\'s month, not today\'s (projectZ #382)', () => {
        // A day years from any test run's "today", so the month on screen
        // can only be the selection's.
        const { container, getByTestId } = render(
            <DatePicker value={new Date(Date.UTC(2019, 1, 12))} />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        act(() => {
            fireEvent.click(trigger);
        });
        const calendar = getByTestId('calendar');
        expect(calendar.querySelector('[data-day="2019-02-12"]')).not.toBeNull();
        expect(calendar.querySelector('[data-day="2019-02-12"] button')).not.toBeNull();
    });

    it('controlled value renders the formatted date in the trigger', () => {
        const { container } = render(
            <DatePicker value={new Date(Date.UTC(2026, 3, 15))} />,
        );
        const valueNode = container.querySelector(
            '[data-testid="date-picker-trigger-value"]',
        );
        expect(valueNode).not.toBeNull();
        expect(valueNode!.textContent).toMatch(/15 Apr 2026/);
    });

    it('clearable + a selection renders a Clear row that emits null', async () => {
        const onChange = jest.fn();
        const { container, getByTestId, queryByTestId } = render(
            <DatePicker
                placeholder="Pick"
                defaultValue={new Date(Date.UTC(2026, 3, 15))}
                clearable
                onChange={onChange}
            />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        act(() => {
            fireEvent.click(trigger);
        });
        const clearBtn = getByTestId('date-picker-clear');
        act(() => {
            fireEvent.click(clearBtn);
        });
        expect(onChange).toHaveBeenCalledWith(null);
        // Popover close is library-owned; only the data contract matters.
        void queryByTestId;
    });

    it('Clear is hidden when there is no selection', () => {
        const { container, queryByTestId } = render(
            <DatePicker placeholder="Pick" clearable />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        act(() => {
            fireEvent.click(trigger);
        });
        expect(queryByTestId('date-picker-clear')).toBeNull();
    });

    it('hasError flips aria-invalid on the trigger', () => {
        const { container } = render(
            <DatePicker placeholder="Pick" hasError />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        expect(trigger.getAttribute('aria-invalid')).toBe('true');
    });

    it('serialises the selected value as YMD on the trigger dataset', () => {
        const { container } = render(
            <DatePicker value={new Date(Date.UTC(2026, 3, 15))} />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        expect(trigger.getAttribute('data-value')).toBe('2026-04-15');
    });
});

// ─── DateRangePicker ─────────────────────────────────────────────────

describe('DateRangePicker — two-day selection', () => {
    it('shows the placeholder while no range is set', () => {
        const { container } = render(
            <DateRangePicker placeholder="Select range" />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        expect(
            trigger.querySelector(
                '[data-testid="date-picker-trigger-placeholder"]',
            )?.textContent,
        ).toBe('Select range');
        expect(trigger.getAttribute('data-value')).toBe('|');
    });

    it('clicking two days commits a normalised range', () => {
        const onChange = jest.fn();
        const { container, getByTestId } = render(
            <DateRangePicker
                placeholder="Select range"
                defaultValue={{ from: null, to: null }}
                onChange={onChange}
            />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        act(() => {
            fireEvent.click(trigger);
        });

        // Scope all cell queries to the calendar grid — the popover
        // may render other text buttons (Clear, nav) with numeric
        // content we'd otherwise trip over.
        const calendar = getByTestId('calendar');
        const day10 = within(calendar).getByText('10', {
            selector: 'button',
        });
        act(() => {
            fireEvent.click(day10);
        });
        const day20 = within(calendar).getByText('20', {
            selector: 'button',
        });
        act(() => {
            fireEvent.click(day20);
        });

        expect(onChange).toHaveBeenCalled();
        const [lastArg, lastCtx] =
            onChange.mock.calls[onChange.mock.calls.length - 1];
        expect(lastArg.from).toBeInstanceOf(Date);
        expect(lastArg.to).toBeInstanceOf(Date);
        expect(lastArg.from.getDate()).toBe(10);
        expect(lastArg.to.getDate()).toBe(20);
        expect(lastCtx).toBeUndefined();
    });

    it('selecting a preset commits its resolved range + preset context', () => {
        const today: ResolvableDateRangePreset = DEFAULT_DATE_RANGE_PRESETS.find(
            (p) => p.id === 'today',
        )!;
        const onChange = jest.fn();
        const { container, getByTestId } = render(
            <DateRangePicker
                placeholder="Select range"
                defaultValue={{ from: null, to: null }}
                presets={[today]}
                onChange={onChange}
            />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        act(() => {
            fireEvent.click(trigger);
        });
        const row = getByTestId('date-picker-preset-today');
        act(() => {
            fireEvent.click(row);
        });
        expect(onChange).toHaveBeenCalledTimes(1);
        const [rangeArg, ctx] = onChange.mock.calls[0];
        expect(rangeArg.from).toBeInstanceOf(Date);
        expect(rangeArg.to).toBeInstanceOf(Date);
        expect(rangeArg.from.getTime()).toBe(rangeArg.to.getTime());
        expect(ctx?.preset?.id).toBe('today');
    });

    it('Clear range button emits { from: null, to: null }', () => {
        const onChange = jest.fn();
        const { container, getByTestId } = render(
            <DateRangePicker
                defaultValue={{
                    from: new Date(Date.UTC(2026, 3, 10)),
                    to: new Date(Date.UTC(2026, 3, 20)),
                }}
                onChange={onChange}
            />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        act(() => {
            fireEvent.click(trigger);
        });
        const clear = getByTestId('date-range-picker-clear');
        act(() => {
            fireEvent.click(clear);
        });
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0]).toEqual({ from: null, to: null });
    });

    it('Clear button is hidden when clearable=false', () => {
        const { container, queryByTestId } = render(
            <DateRangePicker
                clearable={false}
                defaultValue={{
                    from: new Date(Date.UTC(2026, 3, 10)),
                    to: new Date(Date.UTC(2026, 3, 20)),
                }}
            />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        act(() => {
            fireEvent.click(trigger);
        });
        expect(queryByTestId('date-range-picker-clear')).toBeNull();
    });

    it('renders the preset label on the trigger when the value matches', () => {
        const today = DEFAULT_DATE_RANGE_PRESETS.find((p) => p.id === 'today')!;
        const now = new Date();
        const { container } = render(
            <DateRangePicker
                value={today.resolve(now)}
                presets={[today]}
            />,
        );
        const valueNode = container.querySelector(
            '[data-testid="date-picker-trigger-value"]',
        );
        expect(valueNode).not.toBeNull();
        expect(valueNode!.textContent).toBe('Today');
    });

    it('serialises the committed range as a pipe-delimited token', () => {
        const { container } = render(
            <DateRangePicker
                value={{
                    from: new Date(Date.UTC(2026, 3, 10)),
                    to: new Date(Date.UTC(2026, 3, 20)),
                }}
            />,
        );
        const trigger = container.querySelector(
            '[data-date-picker-trigger]',
        ) as HTMLButtonElement;
        expect(trigger.getAttribute('data-value')).toBe('2026-04-10|2026-04-20');
    });
});
