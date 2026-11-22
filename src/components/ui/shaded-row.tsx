/**
 * `<ShadedRow>` — one row of a card's boxed list, drawn as its own shaded box.
 *
 * Owner request, 2026-11-22: "each option needs its own shaded box for
 * contrast and clarity", for every card that lists two or more boxed rows,
 * through ONE shared style, and the same look as the detail-page tab bar —
 * the shade (`--bg-shaded`: warm grey in light, cool blue tint in dark) with
 * the strong outline (`border-border-strong`). The faint `border-border-subtle`
 * outline with no shade that rows carried before did not separate one row
 * from the next on either theme.
 *
 * `SHADED_SURFACE_CLASS` is the shared look, and the tab bar in
 * `EntityDetailLayout` takes its band classes from it too, so the two cannot
 * drift apart. A row adds only its padding (`padding`, default `md` = `p-3`)
 * and whatever layout the site needs through `className`.
 *
 * Option cards too (owner decision, 2026-11-22): a radio / checkbox choice box
 * is a `<ShadedRow as="label" interactive selected={checked}>`. Every option
 * is shaded; the chosen one swaps ONLY its border to the site's existing
 * selected tone (`selectedTone`: `emphasis` or `brand`), so it still stands
 * out. Any other row box that carries a STATE (a success / warning / error
 * tone, a health ring) keeps its own tone and does not use this primitive.
 *
 * No `'use client'`: the component renders a plain element and holds no
 * state, so server and client components can both use it, and
 * `shadedRowVariants` is callable at SSR time.
 *
 * Policed by `local/shaded-list-rows` (eslint-rules/rules/shaded-list-rows.js):
 * a hand-rolled `rounded border border-border-subtle|default` box returned
 * from a `.map(...)`, on any `<li>`, or on a `<label>` wrapping a radio or
 * checkbox, fails lint.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@inflect/ui/lib/cn';

/** The shaded, outlined surface shared by list rows and the detail-page tab bar. */
export const SHADED_SURFACE_CLASS = 'rounded-lg border border-border-strong bg-bg-shaded';

/**
 * The look, split so a SELECTED option can swap only its border tone: the
 * radius, the outline width and the shade are fixed; the border colour is the
 * strong outline unless the row is selected.
 */
export const shadedRowVariants = cva('rounded-lg border bg-bg-shaded', {
    variants: {
        padding: {
            // `none` for a site whose spacing is not uniform (`px-4 py-3`,
            // `p-compact`, …): it passes its own through `className`.
            none: '',
            sm: 'p-2',
            md: 'p-3',
            lg: 'p-4',
            xl: 'p-5',
        },
        /**
         * An OPTION card that is chosen. It keeps the shade; only the border
         * changes, to `selectedTone`.
         */
        selected: {
            false: 'border-border-strong',
            true: '',
        },
        /** The selected border: the emphasis outline, or the brand outline. */
        selectedTone: {
            emphasis: '',
            brand: '',
        },
        /**
         * A clickable option. Hover thickens the strong outline with a 1px
         * ring in the same tone, which shows on the shade in both themes —
         * the old `hover:bg-bg-muted` would be invisible in light, where the
         * shade IS `--bg-muted`. A selected option takes no hover.
         */
        interactive: {
            true: 'cursor-pointer transition-[border-color,box-shadow] duration-150 ease-out',
            false: '',
        },
    },
    compoundVariants: [
        { selected: true, selectedTone: 'emphasis', class: 'border-border-emphasis' },
        { selected: true, selectedTone: 'brand', class: 'border-[var(--brand-default)]' },
        { interactive: true, selected: false, class: 'hover:ring-1 hover:ring-border-strong' },
    ],
    defaultVariants: {
        padding: 'md',
        selected: false,
        selectedTone: 'emphasis',
        interactive: false,
    },
});

type ShadedRowElement = 'li' | 'div' | 'section' | 'article' | 'label' | 'button';

export type ShadedRowProps<E extends ShadedRowElement = 'div'> = {
    /**
     * The element to render: `li` inside a `ul`/`ol`; `label` for an option
     * card wrapping its radio / checkbox; `button` for a choice that is one;
     * `div` otherwise.
     */
    as?: E;
} & VariantProps<typeof shadedRowVariants> &
    Omit<React.ComponentPropsWithoutRef<E>, 'as'>;

export function ShadedRow<E extends ShadedRowElement = 'div'>({
    as,
    padding,
    selected,
    selectedTone,
    interactive,
    className,
    ...rest
}: ShadedRowProps<E>) {
    const Tag = (as ?? 'div') as React.ElementType;
    return (
        <Tag
            data-shaded-row=""
            data-selected={selected ? '' : undefined}
            className={cn(
                shadedRowVariants({ padding, selected, selectedTone, interactive }),
                className,
            )}
            {...rest}
        />
    );
}
