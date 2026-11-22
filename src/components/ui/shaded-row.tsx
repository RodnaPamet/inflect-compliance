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
 * Neutral rows only. A row box that carries a STATE (a success / warning /
 * error tone, a selected or active emphasis, a health ring) keeps its own
 * tone and does not use this primitive: the shade says "one of a set", not
 * "this one is different".
 *
 * No `'use client'`: the component renders a plain element and holds no
 * state, so server and client components can both use it, and
 * `shadedRowVariants` is callable at SSR time.
 *
 * Policed by `local/shaded-list-rows` (eslint-rules/rules/shaded-list-rows.js):
 * a hand-rolled `rounded border border-border-subtle|default` box returned
 * from a `.map(...)`, or on any `<li>`, fails lint.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@inflect/ui/lib/cn';

/** The shaded, outlined surface shared by list rows and the detail-page tab bar. */
export const SHADED_SURFACE_CLASS = 'rounded-lg border border-border-strong bg-bg-shaded';

export const shadedRowVariants = cva(SHADED_SURFACE_CLASS, {
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
    },
    defaultVariants: {
        padding: 'md',
    },
});

type ShadedRowElement = 'li' | 'div' | 'section' | 'article';

export type ShadedRowProps<E extends ShadedRowElement = 'div'> = {
    /** The element to render. `li` inside a `ul`/`ol`; `div` otherwise. */
    as?: E;
} & VariantProps<typeof shadedRowVariants> &
    Omit<React.ComponentPropsWithoutRef<E>, 'as'>;

export function ShadedRow<E extends ShadedRowElement = 'div'>({
    as,
    padding,
    className,
    ...rest
}: ShadedRowProps<E>) {
    const Tag = (as ?? 'div') as React.ElementType;
    return (
        <Tag
            data-shaded-row=""
            className={cn(shadedRowVariants({ padding }), className)}
            {...rest}
        />
    );
}
