'use client';

import { useLocale } from 'next-intl';
// Next's client-safe handle on its request stores: the real ones on the
// server, `undefined` stubs in the browser bundle (Next aliases the module to
// its `.browser` variant there). Next's own `usePathname` reads it the same way.
import { workAsyncStorage } from 'next/dist/client/components/server-async-storage';

import { bindDateLocale, setDateLocaleRenderScope } from '@inflect/ui/lib/format-date';

/**
 * The request a server render belongs to: Next's work store, which Next enters
 * around the WHOLE request — so it is the same object in every continuation
 * of the render, including a part React resumed from Next's flight-stream
 * reader. `undefined` in the browser and outside a request.
 */
export function nextRenderScope(): object | undefined {
    if (typeof window !== 'undefined') return undefined;
    return workAsyncStorage?.getStore() ?? undefined;
}

/**
 * Make the reader's UI language the language every date helper writes in.
 *
 * Called ONCE, by the app's root `<Providers>`, so the hundreds of
 * `formatDate(…)` / `<TimestampTooltip>` call sites need no locale argument.
 * It runs during render, not in an effect, on purpose: `<Providers>` renders
 * before anything below it, so every date in the same render — server and
 * client alike — is formatted in the same locale, and hydration compares
 * identical strings.
 *
 * On the server the binding is recorded against the request's render scope
 * rather than the current async context: a streamed render resumes parts of
 * the tree from contexts the binding never reached, and those parts were
 * rendered in English and hydrated in Bulgarian (React #418). See
 * `setDateLocaleRenderScope` in `format-date.ts`.
 */
export function useBindDateLocale(): void {
    setDateLocaleRenderScope(nextRenderScope);
    bindDateLocale(useLocale());
}
