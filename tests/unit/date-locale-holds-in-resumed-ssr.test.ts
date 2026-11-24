/**
 * A date the server renders in a part of the tree React RESUMED is still in
 * the reader's language.
 *
 * `<Providers>` binds the request's locale once, at the root
 * (`useBindDateLocale`), and the bare helpers (`formatDate`, …) read it. A
 * streamed SSR render does not continue only from that root: when a
 * suspended part of the tree can go on, React resumes it in the async context
 * of whatever settled the thing it waited for. In Next that is the flight
 * client, whose chunks are thenables it settles itself — synchronously, from
 * a stream reader that began reading before React rendered anything. A
 * binding that lives only in the async context `<Providers>` rendered in
 * (an `enterWith`) never reaches that reader, so the resumed part rendered
 * in English, the browser hydrated it in Bulgarian, and every Bulgarian page
 * with a date below such a boundary logged React error #418. English pages
 * never did: English is also the unbound default.
 *
 * This renders the real hook and the real helpers with React's real server
 * renderer, inside Next's real request store, and resumes the dated part
 * from a flight-style thenable settled outside the render — the shape that
 * broke. It compares what the server wrote with what the client would write
 * for the same tree (the helpers bound to the same locale explicitly).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Writable } from 'node:stream';

// next-intl's `useLocale` answers from the request being rendered, as the
// real one does through its provider, so concurrent requests stay apart.
jest.mock('next-intl', () => ({
    useLocale: () =>
        (
            jest.requireActual('next/dist/server/app-render/work-async-storage.external')
                .workAsyncStorage.getStore() as { locale: string }
        ).locale,
}));

type FormatDateModule = typeof import('@inflect/ui/lib/format-date');
type HookModule = typeof import('@/lib/i18n/use-bind-date-locale');
type ReactModule = typeof import('react');
type ServerModule = typeof import('react-dom/server');
interface WorkStorage {
    run<R>(store: object, fn: () => R): R;
}

interface Loaded {
    React: ReactModule;
    server: ServerModule;
    dates: FormatDateModule;
    hook: HookModule;
    /** The store Next's app renderer enters around each request. */
    workAsyncStorage: WorkStorage;
}

/**
 * Load the graph fresh, as the server does: with Node's AsyncLocalStorage on
 * `globalThis`, which both Next's request stores and the date module read at
 * load time.
 */
function loadServerGraph(): Loaded {
    const g = globalThis as { AsyncLocalStorage?: unknown };
    const previous = g.AsyncLocalStorage;
    g.AsyncLocalStorage = AsyncLocalStorage;
    try {
        let loaded: Loaded | undefined;
        jest.isolateModules(() => {
            loaded = {
                React: jest.requireActual('react'),
                server: jest.requireActual('react-dom/server'),
                dates: jest.requireActual('@inflect/ui/lib/format-date'),
                hook: jest.requireActual('@/lib/i18n/use-bind-date-locale'),
                workAsyncStorage: jest.requireActual(
                    'next/dist/server/app-render/work-async-storage.external',
                ).workAsyncStorage,
            };
        });
        if (!loaded) throw new Error('graph did not load');
        return loaded;
    } finally {
        g.AsyncLocalStorage = previous;
    }
}

/** A flight-client chunk: a thenable that calls its listeners itself. */
function flightChunk() {
    const listeners: Array<(v: unknown) => void> = [];
    const chunk = {
        status: 'pending' as 'pending' | 'fulfilled',
        value: undefined as unknown,
        then(onFulfilled: (v: unknown) => void) {
            if (chunk.status === 'fulfilled') onFulfilled(chunk.value);
            else listeners.push(onFulfilled);
        },
        settle() {
            chunk.status = 'fulfilled';
            chunk.value = true;
            for (const l of listeners.splice(0)) l(true);
        },
    };
    return chunk;
}

const DATE = '2026-11-29T10:00:00Z';

/**
 * Server-render one request: `<Providers>` binds the locale, one date renders
 * straight away and one only after a flight chunk settles from OUTSIDE the
 * render. Returns the two dates as the server wrote them.
 */
function renderRequest(g: Loaded, locale: string): Promise<{ immediate: string; resumed: string }> {
    const { React, server, dates, hook, workAsyncStorage } = g;
    const h = React.createElement;

    function Providers({ children }: { children?: React.ReactNode }) {
        hook.useBindDateLocale();
        return h(React.Fragment, null, children);
    }
    function Dated({ part }: { part: string }) {
        return h('time', { 'data-part': part }, dates.formatDate(DATE));
    }
    const chunk = flightChunk();
    function Streamed() {
        // React reads `status` / `value` off any thenable, as it does off a flight chunk.
        React.use(chunk as unknown as PromiseLike<unknown>);
        return h(Dated, { part: 'resumed' });
    }

    return new Promise((resolve, reject) => {
        // Everything below runs inside the request store, as Next's app
        // renderer runs a request: the chunk is settled from this frame (the
        // flight reader's), never from inside React's render.
        workAsyncStorage.run({ locale }, () => {
            let html = '';
            const sink = new Writable({
                write(c, _enc, done) {
                    html += String(c);
                    done();
                },
            });
            sink.on('finish', () => {
                const read = (part: string) =>
                    new RegExp(`data-part="${part}"[^>]*>([^<]*)<`).exec(html)?.[1] ?? '(missing)';
                resolve({ immediate: read('immediate'), resumed: read('resumed') });
            });
            const app = h(
                Providers,
                null,
                h(Dated, { part: 'immediate' }),
                h(React.Suspense, { fallback: h('span', null, '…') }, h(Streamed)),
            );
            const stream = server.renderToPipeableStream(app, {
                onAllReady: () => stream.pipe(sink),
                onError: reject,
            });
            setTimeout(() => chunk.settle(), 5);
        });
    });
}

describe('the date locale in a streamed server render', () => {
    it('holds in a part React resumed from outside the render', async () => {
        const g = loadServerGraph();
        // What the browser writes for the same tree in Bulgarian.
        const client = g.dates.dateFormattersFor('bg').formatDate(DATE);
        expect(client).toBe('29 ное 2026');

        const served = await renderRequest(g, 'bg');
        expect(served).toStrictEqual({ immediate: client, resumed: client });
    });

    it('keeps concurrent requests in their own languages when both resume', async () => {
        const g = loadServerGraph();
        const [bg, en, bg2] = await Promise.all([
            renderRequest(g, 'bg'),
            renderRequest(g, 'en'),
            renderRequest(g, 'bg'),
        ]);
        expect(bg).toStrictEqual({ immediate: '29 ное 2026', resumed: '29 ное 2026' });
        expect(en).toStrictEqual({ immediate: '29 Nov 2026', resumed: '29 Nov 2026' });
        expect(bg2).toStrictEqual(bg);
    });

    it('is English outside any render, as jobs and API routes expect', () => {
        const g = loadServerGraph();
        g.dates.setDateLocaleRenderScope(g.hook.nextRenderScope);
        expect(g.dates.activeDateLocale()).toBe('en');
        expect(g.dates.formatDate(DATE)).toBe('29 Nov 2026');
    });
});
