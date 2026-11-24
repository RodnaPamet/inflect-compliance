/**
 * The bare date helpers write in the ACTIVE locale, and on the server one
 * request's locale never leaks into another's.
 *
 * `<Providers>` binds the reader's language once per render
 * (`useBindDateLocale` → `bindDateLocale`), so the call sites take no locale.
 * On the server, with no render scope registered (as here), that binding lives
 * in an AsyncLocalStorage store entered for the request's render — the
 * fallback; in the app it is recorded against Next's request store, see
 * `date-locale-holds-in-resumed-ssr.test.ts`. If it were a module variable
 * instead, a Bulgarian
 * request and an English one rendering concurrently would format each other's
 * dates — and a client that hydrates with a different string than the server
 * sent is a hydration mismatch.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

type FormatDateModule = typeof import('@inflect/ui/lib/format-date');

/** Load the module fresh, as the server does: with Next's global AsyncLocalStorage present. */
function loadServerModule(): FormatDateModule {
    const g = globalThis as { AsyncLocalStorage?: unknown };
    const previous = g.AsyncLocalStorage;
    g.AsyncLocalStorage = AsyncLocalStorage;
    try {
        let mod: FormatDateModule | undefined;
        jest.isolateModules(() => {
            mod = jest.requireActual<FormatDateModule>('@inflect/ui/lib/format-date');
        });
        if (!mod) throw new Error('module did not load');
        return mod;
    } finally {
        g.AsyncLocalStorage = previous;
    }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('the active date locale', () => {
    it('is English where nothing bound one (jobs, API routes, PDFs)', () => {
        const mod = loadServerModule();
        expect(mod.activeDateLocale()).toBe('en');
        expect(mod.formatDate('2026-11-29T10:00:00Z')).toBe('29 Nov 2026');
    });

    it('follows the binding of the render it is called from', async () => {
        const mod = loadServerModule();
        await new AsyncLocalStorage().run(null, async () => {
            mod.bindDateLocale('bg');
            await tick();
            expect(mod.formatDate('2026-11-29T10:00:00Z')).toBe('29 ное 2026');
            expect(mod.formatMonthYear('2026-11-29T10:00:00Z')).toBe('Ноември 2026 г.');
        });
    });

    it('keeps two concurrent requests in their own languages', async () => {
        const mod = loadServerModule();
        const render = (locale: 'en' | 'bg', delays: number) =>
            new AsyncLocalStorage().run(null, async () => {
                mod.bindDateLocale(locale);
                const seen: string[] = [];
                // Interleave with the other request at every await, as
                // streamed renders resuming from suspense do.
                for (let i = 0; i < delays; i++) {
                    await tick();
                    seen.push(mod.formatDate('2026-04-16T08:00:00Z'));
                }
                return seen;
            });

        const [bg, en] = await Promise.all([render('bg', 5), render('en', 5)]);
        expect(new Set(bg)).toStrictEqual(new Set(['16 апр 2026']));
        expect(new Set(en)).toStrictEqual(new Set(['16 Apr 2026']));
    });

    it('resolves any tag to a supported locale', () => {
        const mod = loadServerModule();
        expect(mod.resolveDateLocale('bg-BG')).toBe('bg');
        expect(mod.resolveDateLocale('de')).toBe('en');
        expect(mod.resolveDateLocale(undefined)).toBe('en');
    });
});
