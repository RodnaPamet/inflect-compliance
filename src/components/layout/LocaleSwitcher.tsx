'use client';

/**
 * Language switcher — segmented control for the UI locale.
 *
 * Mounted inside `<UserMenu>` beside the theme toggle. Selecting a locale
 * persists it to the `inflect_locale` cookie CLIENT-SIDE (mirroring
 * `ThemeProvider.persistTheme`), then calls `router.refresh()` so every server
 * component re-renders with the new next-intl catalog (the cookie is read
 * server-side in `src/i18n.ts`).
 *
 * Why a client-side cookie and not a Server Action: the cookie is not
 * HttpOnly, so `document.cookie` can write it directly. Using a Server Action
 * (the previous implementation) coupled the switch to a build-specific action
 * ID — after a deploy, an already-open tab held a stale ID and the POST failed
 * with `UnrecognizedActionError` (a 404 on the current route). Writing the
 * cookie in the browser has no such coupling and is immune to deploy skew.
 *
 * Options show the SHORT CODE ("EN" / "БГ") because the control sits in a
 * 240px popover row beside the theme toggle, where the full endonyms
 * ("English" / "Български") crowd it. The endonym is not dropped — it is
 * rendered `sr-only` so it remains the ACCESSIBLE NAME of each radio;
 * `<ToggleGroupOption>` has no per-option aria-label, and the accessible name
 * of a `role="radio"` is computed from its contents, so a bare short code
 * would otherwise leave screen readers announcing "EN".
 *
 * Both strings are interpolated from constants rather than written as literal
 * JSX text. A literal `>English<` text node would newly trip the i18n
 * adoption ratchet, which this file is (correctly) not baselined in.
 */

import { useLocale } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { ToggleGroup } from '@/components/ui/toggle-group';
import {
    SUPPORTED_LOCALES,
    LOCALE_LABELS,
    LOCALE_SHORT_LABELS,
    LOCALE_COOKIE,
    resolveLocale,
} from '@/lib/locale-constants';

export interface LocaleSwitcherProps {
    className?: string;
}

const OPTIONS = SUPPORTED_LOCALES.map((locale) => ({
    value: locale,
    label: (
        <>
            <span aria-hidden="true">{LOCALE_SHORT_LABELS[locale]}</span>
            <span className="sr-only">{LOCALE_LABELS[locale]}</span>
        </>
    ),
}));

/** 1 year — mirrors the theme cookie + the old server-action `max-age`. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Persist the locale to the server-readable `inflect_locale` cookie. */
function persistLocale(locale: string) {
    try {
        const secure = window.location?.protocol === 'https:' ? '; secure' : '';
        document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax${secure}`;
    } catch {
        // document.cookie may be unavailable — ignore.
    }
}

export function LocaleSwitcher({ className }: LocaleSwitcherProps) {
    // Active locale from the NextIntlClientProvider (driven by the cookie).
    const current = resolveLocale(useLocale());
    const router = useRouter();
    const [pending, startTransition] = useTransition();

    const onSelect = (next: string) => {
        if (next === current || pending) return;
        // Coerce to a supported locale before persisting so a tampered option
        // can never write a cookie pointing the request-config `import()` at a
        // missing catalog (defence in depth — `OPTIONS` is already closed).
        persistLocale(resolveLocale(next));
        startTransition(() => {
            // Server components (incl. the whole app tree) re-read the cookie.
            router.refresh();
        });
    };

    return (
        <ToggleGroup
            size="sm"
            options={OPTIONS}
            selected={current}
            selectAction={onSelect}
            ariaLabel="Language"
            className={className}
        />
    );
}
