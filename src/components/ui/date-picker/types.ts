/**
 * Epic 58 — date-picker type system.
 *
 * Foundation layer every surface in the picker platform builds
 * against: single-date pickers, range pickers, the preset catalogue,
 * and the later URL / filter / form integrations. This file is
 * organised in three tiers:
 *
 *   1. **Domain primitives** — `DateValue`, `DateRangeValue`,
 *      `DateConstraints`. The typed currency the platform trades in.
 *
 *   2. **Preset shapes** — both the legacy concrete-value form
 *      (`DatePreset.date`, `DateRangePreset.dateRange`) that the
 *      vendored picker UI renders today, and the resolvable form
 *      (`ResolvableDatePreset.resolve(now)`, likewise for ranges)
 *      that reporting catalogues use. A `materializePreset()` helper
 *      in `./date-utils.ts` converts between them.
 *
 *   3. **UI prop shapes** — `CalendarProps`, `PickerProps`. Strictly
 *      for the calendar + popover surface.
 *
 * Nullable-by-design:
 *   - `DateValue = Date | null` and `DateRangeValue.{from,to} = Date | null`.
 *   - `null` means "no selection"; `undefined` is kept only where
 *     react-day-picker insists on it (the `DateRange` alias below).
 */

import type { Locale } from 'date-fns';
import type { ReactNode } from 'react';
import type { Matcher } from 'react-day-picker';
import type { PopoverProps } from '../popover';

// ─── 1. Domain primitives ─────────────────────────────────────────────

/** A single date, or no selection. */
export type DateValue = Date | null;

/**
 * A date range. Either side may be `null` to represent an
 * open-ended range ("from 2026-01-01 onwards" or "up to today").
 */
export interface DateRangeValue {
    from: DateValue;
    to: DateValue;
}

/**
 * Constraints shared by every picker surface. All bounds are
 * inclusive; `disabledDays` delegates to react-day-picker's matcher
 * grammar so arbitrary predicates (weekends, specific days) compose.
 */
export interface DateConstraints {
    /** Earliest selectable day, inclusive. */
    min?: Date;
    /** Latest selectable day, inclusive. */
    max?: Date;
    /** Arbitrary disabled-day predicate(s). */
    disabledDays?: Matcher | Matcher[];
}

// ─── Controlled / uncontrolled patterns ───────────────────────────────

/**
 * Controlled + uncontrolled props for a single-date picker. Follows
 * the same `value` / `defaultValue` / `onChange` pattern React's
 * native input primitives use so form authors don't have to learn a
 * new convention.
 */
export interface ControlledDateValueProps {
    value?: DateValue;
    defaultValue?: DateValue;
    /** Fires on every selection. Called with `null` on clear. */
    onChange?: (next: DateValue) => void;
}

/** Controlled + uncontrolled props for a range picker. */
export interface ControlledDateRangeProps {
    value?: DateRangeValue;
    defaultValue?: DateRangeValue;
    onChange?: (next: DateRangeValue) => void;
}

// ─── 2. Preset shapes ─────────────────────────────────────────────────

/**
 * Shared metadata for every preset shape — the fields the panel UI
 * renders regardless of whether the preset carries a concrete value
 * or a `resolve` function.
 */
export interface PresetMeta {
    id: string;
    label: string;
    /** Optional keyboard-shortcut hint — single key, e.g. "l", "m", "7". */
    shortcut?: string;
    /** Optional description rendered as a tooltip next to the label. */
    tooltipContent?: ReactNode;
}

/**
 * Date range used by the vendored calendar renderer (react-day-picker
 * native shape with `from` + optional `to`, both possibly undefined).
 * Kept distinct from `DateRangeValue` because react-day-picker insists
 * on `undefined` rather than `null`. Convert at boundaries with
 * `toDateRangeValue` / `fromDateRangeValue` in `./date-utils.ts`.
 */
export type DateRange = {
    from: Date | undefined;
    to?: Date | undefined;
};

/**
 * Legacy base — present for back-compat with the upstream presets
 * renderer this picker was adapted from. `requiresUpgrade` is a
 * plan-gating flag from that upstream; ignore it in product code.
 */
export interface Preset extends PresetMeta {
    requiresUpgrade?: boolean;
}

/**
 * Preset carrying a concrete date (e.g. a fixed anniversary).
 * The existing `<Presets>` renderer uses `"date" in preset` to
 * distinguish variants; keep the `.date` key.
 */
export interface DatePreset extends Preset {
    date: Date;
}

/** Preset carrying a concrete date range. */
export interface DateRangePreset extends Preset {
    dateRange: DateRange;
}

/**
 * Preset that resolves a concrete `DateValue` from a reference "now".
 * Used by reporting catalogues ("Today") so the preset stays
 * accurate regardless of when the user opens the picker, and so
 * tests can pass a frozen `now` without patching the clock.
 */
export interface ResolvableDatePreset extends PresetMeta {
    resolve: (now: Date) => DateValue;
}

/** Preset that resolves a concrete `DateRangeValue` from "now". */
export interface ResolvableDateRangePreset extends PresetMeta {
    resolve: (now: Date) => DateRangeValue;
}

// ─── 3. Calendar + picker UI props ────────────────────────────────────

/**
 * Calendar surface props — the thin wrapper around react-day-picker
 * that every picker variant mounts.
 */
export interface CalendarProps {
    fromYear?: number;
    toYear?: number;
    fromMonth?: Date;
    toMonth?: Date;
    fromDay?: Date;
    toDay?: Date;
    fromDate?: Date;
    toDate?: Date;
    locale?: Locale;
}

/**
 * Base props every picker variant (single + range) accepts on top of
 * its value/onChange pair. Accessibility and identification live here.
 */
export interface PickerProps extends CalendarProps {
    className?: string;
    disabled?: boolean;
    disabledDays?: Matcher | Matcher[] | undefined;
    required?: boolean;
    showTimePicker?: boolean;
    placeholder?: string;
    showYearNavigation?: boolean;
    disableNavigation?: boolean;
    hasError?: boolean;
    id?: string;
    align?: PopoverProps['align'];
    'aria-invalid'?: boolean;
    'aria-label'?: string;
    'aria-labelledby'?: string;
    'aria-required'?: boolean;
}
