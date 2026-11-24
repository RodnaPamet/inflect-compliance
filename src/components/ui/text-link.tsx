'use client';

/**
 * `<TextLink>` and `<TextButton>`: a STAND-ALONE small text link, with a
 * touch target a thumb can hit.
 *
 * A text link that stands on its own line — "Forgot password?", "See all",
 * "Back to workspaces", "View in the hub →" — is as tall as its text: 15-20px.
 * WCAG 2.5.8 exempts a link inside a sentence, because the sentence decides
 * where it sits; it does not exempt a link that IS the line, and on a phone
 * those were the smallest targets left in the product (mobile audit,
 * 2026-11-23: 20 pages).
 *
 * Both wear `TOUCH_HIT_AREA_CLASS`: a transparent `::after` centred on the
 * text, at least 44x44 on a coarse pointer and exactly the text's box
 * everywhere else. The text, the line and the layout do not move by a pixel;
 * only the area that answers a tap grows. So:
 *
 *   - Do NOT use them inside running prose. A sentence's link is exempt, and
 *     a 44px square around a word in a paragraph would answer for the lines
 *     above and below it. Use `textLinkVariants` (or a plain `<Link>`) there.
 *   - Give a neighbouring control room. The square reaches up to ~14px past
 *     a 16px line on each side; a link packed right under a field (`-mt-2`)
 *     would take that field's taps. Leave the normal field gap.
 *
 * `<TextLink>` navigates (Next `<Link>`, or a plain `<a>` with `external`).
 * `<TextButton>` does something in place ("Register", "Resend", "Change…")
 * and looks the same. The look is `textLinkVariants` from the typography
 * primitives; pick a `tone`, and set the text size with `className`.
 */

import Link from 'next/link';
import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes } from 'react';
import type { VariantProps } from 'class-variance-authority';
import { cn } from '@inflect/ui/lib/cn';
import { TOUCH_HIT_AREA_CLASS } from '@inflect/ui/components/ui/hit-area';
import { textLinkVariants } from '@inflect/ui/components/ui/typography';

/**
 * The hit area. `relative` because the `::after` positions against its
 * owner; the owner must not clip its overflow (no `truncate` on the link
 * itself: put it on a child span).
 */
export const TEXT_LINK_HIT_AREA = cn('relative', TOUCH_HIT_AREA_CLASS);

type Tone = VariantProps<typeof textLinkVariants>['tone'];

export interface TextLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
    href: string;
    tone?: Tone;
    /**
     * A plain `<a>`: for a URL outside the app, a download, or a page that
     * must load in full (an auth page reached before the client router).
     */
    external?: boolean;
}

export const TextLink = forwardRef<HTMLAnchorElement, TextLinkProps>(function TextLink(
    { href, tone = 'default', external = false, className, children, ...rest },
    ref,
) {
    const classes = cn(textLinkVariants({ tone }), TEXT_LINK_HIT_AREA, className);
    if (external) {
        return (
            <a ref={ref} href={href} className={classes} {...rest}>
                {children}
            </a>
        );
    }
    return (
        <Link ref={ref} href={href} className={classes} {...rest}>
            {children}
        </Link>
    );
});

export interface TextButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    tone?: Tone;
}

export const TextButton = forwardRef<HTMLButtonElement, TextButtonProps>(function TextButton(
    { tone = 'default', type = 'button', className, children, ...rest },
    ref,
) {
    return (
        <button
            ref={ref}
            type={type}
            className={cn(textLinkVariants({ tone }), TEXT_LINK_HIT_AREA, className)}
            {...rest}
        >
            {children}
        </button>
    );
});
