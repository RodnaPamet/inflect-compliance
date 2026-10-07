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
 *
 * The group's own name is `common.language`, read in the viewer's locale:
 * the word `<UserMenu>` prints beside the switch. It was the literal
 * "Language", which a screen reader announced in English on a Bulgarian
 * page (#3201). A host that copies this file needs the key in each of its
 * catalogues.
 */

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { ToggleGroup } from '@/components/ui/toggle-group';
import {
    SUPPORTED_LOCALES,
    LOCALE_LABELS,
    LOCALE_SHORT_LABELS,
    LOCALE_COOKIE,
    resolveLocale,
    type Locale,
} from '@/lib/locale-constants';

export interface LocaleSwitcherProps {
    className?: string;
    /**
     * Persist the choice somewhere the cookie is not the whole story. Called
     * with the chosen locale BEFORE the cookie is written and the tree is
     * refreshed, and awaited; another choice made while it runs is ignored.
     *
     * Without it the cookie IS the preference, which is today's behaviour.
     * A host that keeps the preference on the user record, and re-seeds the
     * cookie from that record on every request, could not use this control
     * at all: the switch flipped the page and the next request flipped it
     * straight back. That is why `UserMenu` grew `showLanguage`. With this
     * hook the host writes its record first, and the cookie and the refresh
     * then agree with it.
     *
     * If it rejects, the switch is abandoned: no cookie, no refresh, and the
     * old locale stays selected. Telling the user is the host's job, since the
     * hook is the host's code and knows what failed.
     */
    onLocaleChange?: (locale: Locale) => Promise<void> | void;
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

export function LocaleSwitcher({ className, onLocaleChange }: LocaleSwitcherProps) {
    // Active locale from the NextIntlClientProvider (driven by the cookie).
    const current = resolveLocale(useLocale());
    const t = useTranslations('common');
    const router = useRouter();
    const [pending, startTransition] = useTransition();

    const onSelect = (next: string) => {
        if (next === current || pending) return;
        // Coerce to a supported locale before persisting so a tampered option
        // can never write a cookie pointing the request-config `import()` at a
        // missing catalog (defence in depth — `OPTIONS` is already closed).
        const locale = resolveLocale(next);
        if (!onLocaleChange) {
            persistLocale(locale);
            startTransition(() => {
                // Server components (incl. the whole app tree) re-read the cookie.
                router.refresh();
            });
            return;
        }
        // An async transition, so `pending` holds through the host's write
        // too and a second tap cannot race the first one's record.
        startTransition(async () => {
            try {
                await onLocaleChange(locale);
            } catch {
                return;
            }
            persistLocale(locale);
            router.refresh();
        });
    };

    return (
        <ToggleGroup
            size="sm"
            options={OPTIONS}
            selected={current}
            selectAction={onSelect}
            ariaLabel={t('language')}
            className={className}
        />
    );
}
