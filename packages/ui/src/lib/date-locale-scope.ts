/**
 * date-locale-scope.ts — the server half of the active date locale.
 *
 * `format-date.ts` owns the locale a bare helper (`formatDate`, …) writes
 * in. In the browser that is a module value: a tab has one locale. On the
 * server it is THIS request's, kept here so two concurrent requests in
 * different languages cannot see each other's locale. Outside any binding
 * (jobs, API routes, PDFs, tests) it is English.
 *
 * WHY A MODULE OF ITS OWN, REQUIRED ONLY ON THE SERVER. `format-date.ts`
 * is imported by most client components, and webpack's split-chunk rule
 * (Next sets `minSize: 20000`) reads a module's size before minification,
 * comments included. At 19 KB it travels inside the page and shared chunks
 * that use it. When this code sat in it, or beside it in the browser graph
 * (a module only it imports shares its chunks, so the two are sized as one),
 * the pair passed 20 KB, webpack gave them a chunk of their own, and the
 * rest of the partition moved with it: up to 5 KB more First Load JS on some
 * routes and 4 KB less on others, for no code the browser runs (#5903). So
 * `format-date.ts` requires this module behind `typeof window`, which keeps
 * it out of the browser bundle altogether.
 */
import type { DateLocale } from './format-date';

/** The subset of Node's AsyncLocalStorage this module uses. */
interface LocaleStore {
    getStore(): DateLocale | undefined;
    enterWith(value: DateLocale): void;
}

/**
 * Names the request being server-rendered — any object that is the SAME for
 * every part of one request's render and different between requests — or
 * `undefined` outside a render.
 */
export type DateLocaleRenderScope = () => object | undefined;

let renderScope: DateLocaleRenderScope | null = null;

/** Each render scope's bound locale. Weak, so a finished request's entry goes with it. */
const scopedLocales = new WeakMap<object, DateLocale>();

/**
 * Tell the server side which request is rendering, so a binding made at the
 * root still holds wherever in that render a date is formatted.
 *
 * WHY THIS AND NOT AN AsyncLocalStorage ALONE. A store entered with
 * `enterWith()` during `<Providers>`' render holds only for the async work
 * that render goes on to start. A streamed SSR render does not continue only
 * from there: React resumes a suspended part of the tree when the thing it
 * waited for settles, in the async context of whoever settled it. For a
 * client component under a server component that is Next's flight-stream
 * reader, which began reading before React rendered anything — so the
 * resumed part rendered with no locale bound, in English, and the browser
 * hydrated it in Bulgarian: React error #418 on every Bulgarian page whose
 * dates sat below such a boundary, never on an English one. (The flight
 * client's chunks are thenables it settles itself, synchronously, from that
 * reader; a native promise would have carried the binding along.)
 *
 * The scope is entered by the framework AROUND the whole request (Next's
 * work store), so every continuation of the render can name it, wherever it
 * resumed from. The app registers it next to the binding
 * (`useBindDateLocale`); this module stays framework-free.
 */
export function setDateLocaleRenderScope(getScope: DateLocaleRenderScope | null): void {
    renderScope = getScope;
}

function currentRenderScope(): object | undefined {
    if (!renderScope) return undefined;
    try {
        return renderScope() ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * The server's fallback store, for a render with no registered scope.
 * Next.js puts Node's `AsyncLocalStorage` on `globalThis` for its own
 * request scoping, which keeps `node:async_hooks` out of this module's
 * import graph — it is bundled for the browser too. `null` in the browser
 * and wherever the global is absent (Jest, edge): the active locale then
 * falls back to English on the server side.
 */
const serverStore: LocaleStore | null = (() => {
    if (typeof window !== 'undefined') return null;
    const Ctor = (globalThis as { AsyncLocalStorage?: new () => LocaleStore }).AsyncLocalStorage;
    return typeof Ctor === 'function' ? new Ctor() : null;
})();

/** Bind `locale` to the request being rendered (`bindDateLocale`, server side). */
export function bindServerDateLocale(locale: DateLocale): void {
    const scope = currentRenderScope();
    if (scope) {
        scopedLocales.set(scope, locale);
        return;
    }
    if (serverStore && serverStore.getStore() !== locale) serverStore.enterWith(locale);
}

/** The locale bound to the request being rendered; English when none is. */
export function serverDateLocale(): DateLocale {
    const scope = currentRenderScope();
    const scoped = scope ? scopedLocales.get(scope) : undefined;
    return scoped ?? serverStore?.getStore() ?? 'en';
}
