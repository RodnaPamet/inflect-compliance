/**
 * AnimatedNumber — Epic 61 shared primitive for animated numeric
 * transitions across KPI cards, stat rows, progress cards, trend
 * cards, and portfolio metrics.
 *
 * Wraps `@number-flow/react` behind a stable, library-agnostic API
 * so callers don't import NumberFlow directly. The wrapper owns:
 *
 *   - Format presets (integer / decimal / percent / currency) plus
 *     a passthrough for arbitrary `Intl.NumberFormatOptions`.
 *   - Trend semantics surfaced as `data-trend` (consumers colour
 *     via CSS / tokens; the primitive stays token-agnostic).
 *   - A non-animating fallback (`animate={false}`) that renders the
 *     formatted value as plain text — same DOM shape, same
 *     accessible name. NumberFlow itself respects
 *     `prefers-reduced-motion` internally.
 *   - A11y: `aria-label` defaults to the resolved formatted string
 *     so screen readers announce a single coherent value rather
 *     than the per-digit visual structure.
 *
 * Percent convention: `{ kind: 'percent' }` expects the value
 * pre-multiplied (e.g. `75.3` → `"75.3%"`), matching every other
 * percent rendering in this codebase. We don't use Intl's
 * `style: 'percent'` (which divides by 100) to avoid contradicting
 * the existing convention.
 *
 * Non-finite guard: `NaN` / `±Infinity` NEVER reach the formatter.
 * `Intl.NumberFormat().format(NaN)` yields the literal `"NaN"`, and
 * NumberFlow's part-splitter drops the `nan` Intl part into its
 * symbol section — so a single upstream divide-by-zero used to
 * surface as `NaN%` or, once the surrounding gradient swallowed the
 * digits, as bare punctuation (`. %`). A non-finite value is "no
 * data", so it renders the same `—` placeholder a `null` would.
 *
 * ⚠️ Do NOT render an ANIMATED `<AnimatedNumber>` inside a
 * `bg-clip-text text-transparent` gradient wrapper. The animated
 * branch mounts the `<number-flow>` custom element, whose shadow
 * root sets `isolation: isolate` (and blends its symbols with
 * `mix-blend-mode: plus-lighter`); the ancestor's text-clipped
 * background is never painted into that isolated subtree, so the
 * glyphs stay `color: transparent` — i.e. invisible. Pass
 * `animate={false}` for gradient-clipped surfaces (the static branch
 * is ordinary text and clips correctly). Enforced by
 * `tests/guards/animated-number-gradient-clip.test.ts`.
 */
'use client';

import * as React from 'react';
import NumberFlow, { type Format } from '@number-flow/react';

// ─── Format presets ─────────────────────────────────────────────────

/**
 * Discriminated union covering the four common dashboard formats
 * plus an escape hatch for arbitrary `Intl.NumberFormatOptions`.
 *
 * Always pass `kind` so the type stays exhaustive — never widen to
 * `string` shorthands. Adding a new preset means adding a new
 * `kind` branch here AND a switch arm in `resolveFormat`.
 */
export type AnimatedNumberFormat =
    | { kind: 'integer' }
    | { kind: 'decimal'; fractionDigits?: number }
    | { kind: 'percent'; fractionDigits?: number }
    | { kind: 'currency'; currency: string; fractionDigits?: number }
    | { kind: 'intl'; options: Intl.NumberFormatOptions };

/** Trend semantic. Consumers colour via `[data-trend="..."]` selectors. */
export type AnimatedNumberTrend = 'up' | 'down' | 'neutral';

interface ResolvedFormat {
    /** `Intl.NumberFormatOptions` to feed both NumberFlow and the static fallback. */
    intl: Intl.NumberFormatOptions;
    /** Suffix appended after the formatted number (e.g. "%"). */
    suffix: string;
}

function resolveFormat(format: AnimatedNumberFormat): ResolvedFormat {
    switch (format.kind) {
        case 'integer':
            return {
                intl: { maximumFractionDigits: 0 },
                suffix: '',
            };
        case 'decimal': {
            const digits = format.fractionDigits ?? 1;
            return {
                intl: {
                    minimumFractionDigits: digits,
                    maximumFractionDigits: digits,
                },
                suffix: '',
            };
        }
        case 'percent': {
            const digits = format.fractionDigits ?? 1;
            return {
                intl: {
                    minimumFractionDigits: digits,
                    maximumFractionDigits: digits,
                },
                suffix: '%',
            };
        }
        case 'currency': {
            const digits = format.fractionDigits ?? 2;
            return {
                intl: {
                    style: 'currency',
                    currency: format.currency,
                    minimumFractionDigits: digits,
                    maximumFractionDigits: digits,
                },
                suffix: '',
            };
        }
        case 'intl':
            return { intl: format.options, suffix: '' };
    }
}

// ─── Props ──────────────────────────────────────────────────────────

/**
 * Placeholder rendered when `value` is not a finite number. Matches the
 * `—` every other "no data" surface in the product uses (KpiCard,
 * HeroMetric, TenantCoverageList), so a broken metric reads as "no
 * value" rather than as a formatting artefact.
 */
export const ANIMATED_NUMBER_EMPTY = '—';

export interface AnimatedNumberProps {
    /**
     * Target value to animate to (or render statically when
     * `animate={false}`). Non-finite input (`NaN`, `±Infinity`, and —
     * for untyped callers — `null`/`undefined`) renders the
     * `ANIMATED_NUMBER_EMPTY` placeholder instead of reaching the
     * formatter.
     */
    value: number;
    /** Format preset or Intl options. Defaults to `{ kind: 'integer' }`. */
    format?: AnimatedNumberFormat;
    /** BCP-47 locale tag(s). Defaults to the runtime/browser default. */
    locale?: Intl.LocalesArgument;
    /**
     * Optional semantic hint surfaced as `data-trend`. The primitive
     * stays token-agnostic — consumers select on the data attribute
     * (e.g. KpiCard's existing semantic-token bag) to apply colour.
     */
    trend?: AnimatedNumberTrend;
    /**
     * Disable animation. NumberFlow already honours
     * `prefers-reduced-motion`; this flag is for cases where the
     * caller wants a static render unconditionally (snapshot tests,
     * print/PDF surfaces, etc.).
     */
    animate?: boolean;
    /** Optional class on the wrapper `<span>`. */
    className?: string;
    /** Optional id on the wrapper `<span>`. */
    id?: string;
    /** Optional prefix prepended in front of the number (e.g. "≈"). */
    prefix?: string;
    /**
     * Optional suffix appended after the number. Concatenated with
     * the format's own suffix (e.g. percent's `%`), so a caller can
     * say `suffix=" / yr"` on a percent without losing the `%`.
     */
    suffix?: string;
    /**
     * Override the announced accessible name. Defaults to the
     * locale-formatted value (with prefix + suffix). Override only
     * when surrounding context already names the metric and a bare
     * number sounds less confusing.
     */
    'aria-label'?: string;
}

// ─── Component ──────────────────────────────────────────────────────

export function AnimatedNumber({
    value,
    format = { kind: 'integer' },
    locale,
    trend,
    animate = true,
    className,
    id,
    prefix,
    suffix,
    'aria-label': ariaLabel,
}: AnimatedNumberProps) {
    const { intl, suffix: presetSuffix } = resolveFormat(format);
    const composedSuffix = `${presetSuffix}${suffix ?? ''}`;
    // `Number.isFinite` (not the global `isFinite`) so a stray
    // string/null/undefined from an untyped payload is rejected rather
    // than coerced — a metric that arrived as `null` must not print `0`.
    const isFinite = Number.isFinite(value);
    const formatted = React.useMemo(() => {
        if (!Number.isFinite(value)) return ANIMATED_NUMBER_EMPTY;
        const body = new Intl.NumberFormat(locale, intl).format(value);
        return `${prefix ?? ''}${body}${composedSuffix}`;
        // The Intl options object is rebuilt every render but its
        // shape is content-equivalent across renders for the same
        // `format`; the deps below cover the same surface.
    }, [value, locale, prefix, composedSuffix, intl]);

    const a11yLabel = ariaLabel ?? formatted;

    // Non-finite → static placeholder. Never hand `NaN`/`Infinity` to
    // NumberFlow: its part-splitter has no digit parts to render, so the
    // element degrades to whatever punctuation the locale emitted.
    if (!isFinite) {
        return (
            <span
                id={id}
                className={className}
                data-trend={trend}
                data-animated-number="empty"
                aria-label={a11yLabel}
            >
                {ANIMATED_NUMBER_EMPTY}
            </span>
        );
    }

    if (!animate) {
        return (
            <span
                id={id}
                className={className}
                data-trend={trend}
                data-animated-number="static"
                aria-label={a11yLabel}
            >
                {formatted}
            </span>
        );
    }

    return (
        <span
            id={id}
            className={className}
            data-trend={trend}
            data-animated-number="animated"
            aria-label={a11yLabel}
        >
            <NumberFlow
                value={value}
                locales={locale}
                // NumberFlow's `Format` is a narrower subset of
                // `Intl.NumberFormatOptions` (no scientific /
                // engineering notation, etc.). Our preset resolver
                // never produces those, and the `intl` passthrough
                // preset's caller is already typed against
                // `Intl.NumberFormatOptions` — so the runtime is
                // safe; we just narrow the type for the library.
                format={intl as Format}
                prefix={prefix}
                suffix={composedSuffix}
            />
        </span>
    );
}

export default AnimatedNumber;
