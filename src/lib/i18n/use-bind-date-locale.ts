'use client';

import { useLocale } from 'next-intl';

import { bindDateLocale } from '@inflect/ui/lib/format-date';

/**
 * Make the reader's UI language the language every date helper writes in.
 *
 * Called ONCE, by the app's root `<Providers>`, so the hundreds of
 * `formatDate(…)` / `<TimestampTooltip>` call sites need no locale argument.
 * It runs during render, not in an effect, on purpose: `<Providers>` renders
 * before anything below it, so every date in the same render — server and
 * client alike — is formatted in the same locale, and hydration compares
 * identical strings. See the FIX section of `format-date.ts` for how the
 * server keeps one request's locale out of another's.
 */
export function useBindDateLocale(): void {
    bindDateLocale(useLocale());
}
