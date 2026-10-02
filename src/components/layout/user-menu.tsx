'use client';

/**
 * Roadmap-14 PR-5 — `<UserMenu>` — right-slot avatar + dropdown.
 *
 * Mounts to the right of every workspace-aware top-bar surface
 * (tenant or org variant). Provides the canonical home for
 * account-scoped verbs:
 *
 *   • Theme toggle (light / dark)
 *   • Sign out
 *
 * Future PRs may extend with Profile, Account settings, Keyboard
 * shortcuts (already exists, triggered by `?` key). PR-5 keeps the
 * menu intentionally small — adding items the user can't reach via
 * a real route would be misleading.
 *
 * The avatar trigger replaces the sidebar's "log-out icon at the
 * bottom" affordance as the global account-actions home; the
 * sidebar's existing identity panel + log-out icon stay in place
 * until R14-PR12 mobile unification, when they're consolidated
 * here.
 *
 * Data: `useSession()` for the display name. Falls back to
 * "Account" when name is unset (legitimate state for unauth-during-
 * hydration; the menu itself never renders unauthed because
 * `<AppShell>` doesn't mount).
 *
 * Visual: 32×32 round avatar with the user's initials over a
 * brand-subtle fill. Hover brightens (motion-language safe). The
 * dropdown opens to `align="end"` so it hugs the right edge of the
 * viewport and never overflows.
 */

import { useCallback, useState, type ReactNode } from 'react';


import { useTranslations } from 'next-intl';

import { Popover } from '@/components/ui/popover';
import { InitialsAvatar } from '@/components/ui/initials-avatar';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { LocaleSwitcher } from './LocaleSwitcher';
import { NAV_BAR_SLOT_PRESS } from './nav-bar';
import { HIT_AREA_CLASS } from '@/components/ui/hit-area';

// ─── Props ────────────────────────────────────────────────────────

export interface UserMenuProps {
    /**
     * Display name + email threaded from the server-side layout.
     * Replaces the R14-PR5 `useSession()` call that violated the
     * project's no-SessionProvider convention. `null` is the
     * legitimate "unset" state (rendered as "Account" fallback).
     */
    displayName: string | null;
    displayEmail: string | null;
    /**
     * Profile-photo URL — OAuth `User.image` written at sign-in OR
     * the in-app serve URL from the avatar upload flow. Surfaced in
     * the avatar trigger; initials remain the fallback layer. Avatar
     * roadmap P4. JWT-lag note: after a fresh upload, this lags until
     * the next JWT re-mint, but the member list (DB-backed) updates
     * immediately.
     */
    displayImage: string | null;
    /**
     * Extra rows, rendered after the built-in ones. T08 (#3003).
     *
     * WHERE THE LINE IS, because "content-free" needs a definition rather
     * than a gesture. What stays built in is everything assembled from this
     * repo's own shared primitives and the props above: the identity header
     * (it paints `displayName`/`displayEmail`/`displayImage`), the theme row
     * (`<ThemeToggle>`) and the language row (`<LocaleSwitcher>`). None of
     * those name a product, a route or an auth library, and every consumer of
     * this chrome wants all three — pushing them into the slot would make each
     * consumer re-wire the same three rows.
     *
     * What LEFT are the two that did name those things: a `<Link>` to
     * `/account/security`, which is a route only this product has, and a
     * sign-out button importing `signOut` from `next-auth/react`, which is a
     * dependency a vendoring product should not inherit from a menu component.
     *
     * A render prop rather than a node because a row almost always needs to
     * close the menu when it fires — `close` is the menu's own state and the
     * consumer cannot reach it otherwise.
     */
    items?: (props: { close: () => void }) => ReactNode;
    /**
     * Controlled open state. Omit both and the menu owns its own — which is
     * what every call site does today, so this is additive. Supplied, it lets
     * a consumer open the menu from elsewhere (a shortcut, a tour step)
     * without reaching inside.
     */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /**
     * Render the built-in language row. Defaults to `true`.
     *
     * The row persists the choice to a cookie and refreshes, which is only
     * the whole story where that cookie IS the preference. A host that keeps
     * the preference on the user record and re-seeds the cookie from it on
     * every request would see the row flip the page and then flip it straight
     * back on the next navigation: a control that visibly does nothing. Such a
     * host hides the row until it can persist the choice, rather than ship it
     * broken or fork the menu.
     */
    showLanguage?: boolean;
}

// ─── Recipe ────────────────────────────────────────────────────────

// Wraps the shared `<InitialsAvatar size="md">` (which owns the
// circle's fill, sizing, and initials styling). The button class
// supplies the click target, hover lift, focus ring, and press
// motion — visual styles the avatar primitive deliberately does not
// carry.
const AVATAR_BUTTON_CLASS =
    // `HIT_AREA_CLASS`: 14% of this 22px avatar circle's box rendered as
    // avatar but did not answer to `:hover`. See `hit-area.ts`. That fixes
    // the DEAD ZONE inside the box; it does not change the box, so the
    // control was still 22x22 against WCAG 2.5.5's 44. T08 (#3003) adds the
    // `pointer-coarse:` floor — the same shortfall as the hamburger, in the
    // same bar, and the two are fixed together rather than one looking odd
    // beside its unchanged neighbour.
    `relative inline-flex h-[22px] w-[22px] pointer-coarse:min-h-11 pointer-coarse:min-w-11 items-center justify-center rounded-full transition-[filter] duration-150 ease-out hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-bg-page ${NAV_BAR_SLOT_PRESS} ${HIT_AREA_CLASS}`;

/**
 * Exported since T08 (#3003) so rows supplied through `items` are visually
 * identical to the built-in ones. Without it a consumer re-types the recipe
 * and the two drift — the menu would show its own rows and the host's in
 * subtly different paddings, which is worse than not having the slot.
 */
export const USER_MENU_ROW_CLASS =
    'flex w-full cursor-pointer select-none items-center gap-compact rounded-md px-2.5 py-1.5 text-left text-sm text-content-default transition-colors duration-100 ease-out hover:bg-bg-muted hover:text-content-emphasis focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]';

export function UserMenu({
    displayName,
    displayEmail,
    displayImage,
    items,
    open: controlledOpen,
    onOpenChange,
    showLanguage = true,
}: UserMenuProps) {
    const t = useTranslations('common');
    const tNav = useTranslations('nav');
    // Uncontrolled unless BOTH are supplied. A consumer that passes `open`
    // without `onOpenChange` would otherwise get a menu that cannot be shut —
    // the component would read their value and have nowhere to report a close.
    const isControlled = controlledOpen !== undefined && onOpenChange !== undefined;
    const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
    const open = isControlled ? controlledOpen : uncontrolledOpen;
    const setOpen = useCallback(
        (next: boolean) => {
            if (isControlled) onOpenChange(next);
            else setUncontrolledOpen(next);
        },
        [isControlled, onOpenChange],
    );
    const close = useCallback(() => setOpen(false), [setOpen]);

    // Trim + fallback. `null` or whitespace-only renders as
    // `nav.account` ("Account") so the chrome never shows an empty trigger.
    const resolvedName = displayName?.trim() ?? '';
    const effectiveName =
        resolvedName.length > 0 ? resolvedName : tNav('account');

    return (
        <Popover
            openPopover={open}
            setOpenPopover={setOpen}
            align="end"
            side="bottom"
            sideOffset={8}
            popoverContentClassName="w-[240px] p-1"
            content={
                <Popover.Menu aria-label={tNav('accountMenu')}>
                    {/* Identity header — name + email at the top.
                        Quiet typography so the eye reads the
                        actionable items below, not the header. */}
                    <div className="px-2.5 pt-1.5 pb-2">
                        <p
                            className="truncate text-sm font-medium text-content-emphasis"
                            data-testid="user-menu-display-name"
                        >
                            {effectiveName}
                        </p>
                        {displayEmail && (
                            <p
                                className="truncate text-xs text-content-muted"
                                data-testid="user-menu-display-email"
                            >
                                {displayEmail}
                            </p>
                        )}
                    </div>

                    <Popover.Separator />

                    {/* Theme toggle. Mounted INSIDE the menu so the
                        sidebar can retire its own toggle in
                        R14-PR12. ThemeToggle handles its own
                        keyboard story + persists to localStorage. */}
                    <div
                        className="px-2.5 py-1.5 flex items-center justify-between text-sm text-content-default"
                        data-testid="user-menu-theme-row"
                    >
                        <span>{t('theme')}</span>
                        <ThemeToggle id="user-menu-theme-toggle" />
                    </div>

                    {/* Language switcher — persists to the inflect_locale
                        cookie + refreshes so server components re-render in
                        the chosen locale. Its separators go with it, so a
                        menu without the row does not stack two hairlines
                        above the host's rows. */}
                    {showLanguage ? (
                        <>
                            <Popover.Separator />
                            <div
                                className="px-2.5 py-1.5 flex items-center justify-between gap-compact text-sm text-content-default"
                                data-testid="user-menu-language-row"
                            >
                                <span>{t('language')}</span>
                                <LocaleSwitcher />
                            </div>
                            <Popover.Separator />
                        </>
                    ) : null}

                    {items ? (
                        <>
                            <Popover.Separator />
                            {items({ close })}
                        </>
                    ) : null}
                </Popover.Menu>
            }
        >
            <button
                type="button"
                className={AVATAR_BUTTON_CLASS}
                aria-label={tNav('accountMenuFor', { name: effectiveName })}
                aria-expanded={open}
                aria-haspopup="menu"
                data-testid="top-chrome-user-menu"
            >
                <InitialsAvatar
                    value={effectiveName}
                    size="nav"
                    imageUrl={displayImage}
                />
            </button>
        </Popover>
    );
}
