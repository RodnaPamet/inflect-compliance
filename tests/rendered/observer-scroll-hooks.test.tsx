/**
 * Epic 60 — viewport / observer / scroll hook cluster.
 *
 * jsdom ships without `IntersectionObserver` or `ResizeObserver`, so
 * each test installs a triggerable stub before rendering and asserts:
 *
 *   - initial mount state matches the documented default
 *   - observer fires → hook state updates
 *   - unmount → observer disconnect() ran (no leak)
 *   - missing browser API → hook no-ops without throwing
 *
 * Running under `tests/rendered/` (jsdom) because the hooks legitimately
 * depend on React state + effect semantics; a pure-unit harness would
 * have to replicate both.
 */

import React from 'react';
import { act, render, renderHook } from '@testing-library/react';

import {
    useInViewport,
    useIntersectionObserver,
    useResizeObserver,
    useScroll,
    useScrollProgress,
} from '@/components/ui/hooks';

// ── Triggerable observer stubs ─────────────────────────────────────────

type IOCallback = (entries: IntersectionObserverEntry[], obs: IntersectionObserver) => void;
type ROCallback = (entries: ResizeObserverEntry[], obs: ResizeObserver) => void;

class MockIntersectionObserver {
    static instances: MockIntersectionObserver[] = [];
    callback: IOCallback;
    options: IntersectionObserverInit | undefined;
    observed: Element[] = [];
    disconnected = false;
    root = null;
    rootMargin = '';
    thresholds: readonly number[] = [];
    constructor(cb: IOCallback, options?: IntersectionObserverInit) {
        this.callback = cb;
        this.options = options;
        MockIntersectionObserver.instances.push(this);
    }
    observe(el: Element) { this.observed.push(el); }
    unobserve(el: Element) {
        this.observed = this.observed.filter((x) => x !== el);
    }
    disconnect() { this.disconnected = true; this.observed = []; }
    takeRecords(): IntersectionObserverEntry[] { return []; }
    trigger(entry: Partial<IntersectionObserverEntry> & { isIntersecting: boolean }) {
        this.callback([entry as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    static last(): MockIntersectionObserver {
        return this.instances[this.instances.length - 1];
    }
    static reset() { this.instances = []; }
}

class MockResizeObserver {
    static instances: MockResizeObserver[] = [];
    callback: ROCallback;
    observed: Element[] = [];
    disconnected = false;
    constructor(cb: ROCallback) {
        this.callback = cb;
        MockResizeObserver.instances.push(this);
    }
    observe(el: Element) { this.observed.push(el); }
    unobserve(el: Element) {
        this.observed = this.observed.filter((x) => x !== el);
    }
    disconnect() { this.disconnected = true; this.observed = []; }
    trigger(entry: Partial<ResizeObserverEntry>) {
        this.callback([entry as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    static last(): MockResizeObserver {
        return this.instances[this.instances.length - 1];
    }
    static reset() { this.instances = []; }
}

beforeEach(() => {
    MockIntersectionObserver.reset();
    MockResizeObserver.reset();
    (globalThis as unknown as { IntersectionObserver: typeof IntersectionObserver })
        .IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver })
        .ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
});

// ── useIntersectionObserver ────────────────────────────────────────────

describe('useIntersectionObserver', () => {
    it('returns undefined until an observer entry fires, then the entry', () => {
        const ref = { current: document.createElement('div') };
        const { result } = renderHook(() => useIntersectionObserver(ref));
        expect(result.current).toBeUndefined();

        act(() => {
            MockIntersectionObserver.last().trigger({ isIntersecting: true });
        });
        expect(result.current?.isIntersecting).toBe(true);
    });

    it('disconnects the observer on unmount', () => {
        const ref = { current: document.createElement('div') };
        const { unmount } = renderHook(() => useIntersectionObserver(ref));
        const observer = MockIntersectionObserver.last();
        expect(observer.disconnected).toBe(false);
        unmount();
        expect(observer.disconnected).toBe(true);
    });

    it('freezeOnceVisible: disconnects after first intersecting entry, keeps last entry', () => {
        const ref = { current: document.createElement('div') };
        const { result } = renderHook(() =>
            useIntersectionObserver(ref, { freezeOnceVisible: true }),
        );
        act(() => {
            MockIntersectionObserver.last().trigger({ isIntersecting: true });
        });
        // Observer from the first-visible state is replaced / torn down
        const activeOnRerender = MockIntersectionObserver.instances.filter(
            (o) => !o.disconnected,
        );
        expect(activeOnRerender.length).toBe(0);
        expect(result.current?.isIntersecting).toBe(true);
    });

    it('no-op when IntersectionObserver is unavailable', () => {
        const original = globalThis.IntersectionObserver;
        (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;

        const ref = { current: document.createElement('div') };
        const { result } = renderHook(() => useIntersectionObserver(ref));
        expect(result.current).toBeUndefined();
        expect(MockIntersectionObserver.instances.length).toBe(0);

        (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = original;
    });
});

// ── useInViewport ──────────────────────────────────────────────────────

describe('useInViewport', () => {
    it('returns defaultValue until IO fires, then reflects isIntersecting', () => {
        const ref = { current: document.createElement('div') };
        const { result } = renderHook(() =>
            useInViewport(ref, { defaultValue: false }),
        );
        expect(result.current).toBe(false);

        act(() => {
            MockIntersectionObserver.last().trigger({ isIntersecting: true });
        });
        expect(result.current).toBe(true);

        act(() => {
            MockIntersectionObserver.last().trigger({ isIntersecting: false });
        });
        expect(result.current).toBe(false);
    });

    it('disconnects observer on unmount and registers no extra event listeners', () => {
        const addSpy = jest.spyOn(window, 'addEventListener');
        const ref = { current: document.createElement('div') };
        const { unmount } = renderHook(() => useInViewport(ref));
        // Observe but DON'T subscribe to scroll/resize (the refactor removed those)
        expect(addSpy).not.toHaveBeenCalledWith('scroll', expect.anything());
        expect(addSpy).not.toHaveBeenCalledWith('resize', expect.anything());

        const observer = MockIntersectionObserver.last();
        unmount();
        expect(observer.disconnected).toBe(true);
        addSpy.mockRestore();
    });
});

// ── useResizeObserver ──────────────────────────────────────────────────

describe('useResizeObserver', () => {
    it('returns undefined until first entry fires, then the entry', () => {
        const ref = { current: document.createElement('div') };
        const { result } = renderHook(() => useResizeObserver(ref));
        expect(result.current).toBeUndefined();

        act(() => {
            MockResizeObserver.last().trigger({
                contentRect: { width: 200, height: 100 } as DOMRectReadOnly,
            });
        });
        expect(result.current?.contentRect.width).toBe(200);
    });

    it('disconnects on unmount', () => {
        const ref = { current: document.createElement('div') };
        const { unmount } = renderHook(() => useResizeObserver(ref));
        const observer = MockResizeObserver.last();
        unmount();
        expect(observer.disconnected).toBe(true);
    });

    it('no-op when ResizeObserver is unavailable', () => {
        const original = globalThis.ResizeObserver;
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
        const ref = { current: document.createElement('div') };
        const { result } = renderHook(() => useResizeObserver(ref));
        expect(result.current).toBeUndefined();
        expect(MockResizeObserver.instances.length).toBe(0);
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = original;
    });
});

// ── useScroll ──────────────────────────────────────────────────────────

describe('useScroll', () => {
    it('flips to true once window.scrollY passes threshold and back to false below', () => {
        const { result } = renderHook(() => useScroll(50));
        expect(result.current).toBe(false);

        act(() => {
            Object.defineProperty(window, 'scrollY', { value: 100, configurable: true });
            window.dispatchEvent(new Event('scroll'));
        });
        expect(result.current).toBe(true);

        act(() => {
            Object.defineProperty(window, 'scrollY', { value: 10, configurable: true });
            window.dispatchEvent(new Event('scroll'));
        });
        expect(result.current).toBe(false);
    });

    it('uses the container ref when provided', () => {
        const div = document.createElement('div');
        Object.defineProperty(div, 'scrollTop', { value: 0, writable: true });
        const ref = { current: div };
        const { result } = renderHook(() => useScroll(40, { container: ref }));
        expect(result.current).toBe(false);

        act(() => {
            (div as unknown as { scrollTop: number }).scrollTop = 200;
            div.dispatchEvent(new Event('scroll'));
        });
        expect(result.current).toBe(true);
    });

    it('removes the scroll listener on unmount', () => {
        const removeSpy = jest.spyOn(window, 'removeEventListener');
        const { unmount } = renderHook(() => useScroll(20));
        unmount();
        expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
        removeSpy.mockRestore();
    });
});

// ── useScrollProgress ──────────────────────────────────────────────────

describe('useScrollProgress', () => {
    /**
     * Run the frame the hook queued.
     *
     * `updateScrollProgress` only SCHEDULES the measurement — it collapses an
     * event storm to one rAF so a scroll gesture cannot thrash layout or
     * commit a render per event. The consequence for tests is that progress
     * reflects a call on the NEXT frame, not the same tick, so every
     * assertion below flushes one first.
     */
    const flushFrame = async () => {
        await act(async () => {
            await new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
            );
        });
    };

    function makeScrollableRef(opts: {
        scrollTop?: number;
        scrollHeight?: number;
        clientHeight?: number;
    }) {
        const el = document.createElement('div');
        Object.defineProperty(el, 'scrollTop', { value: opts.scrollTop ?? 0, writable: true });
        Object.defineProperty(el, 'scrollHeight', { value: opts.scrollHeight ?? 100, writable: true });
        Object.defineProperty(el, 'clientHeight', { value: opts.clientHeight ?? 100, writable: true });
        Object.defineProperty(el, 'scrollLeft', { value: 0, writable: true });
        Object.defineProperty(el, 'scrollWidth', { value: 100, writable: true });
        Object.defineProperty(el, 'clientWidth', { value: 100, writable: true });
        return { current: el };
    }

    it('returns 1 for a non-scrollable container', () => {
        const ref = makeScrollableRef({ scrollHeight: 100, clientHeight: 100 });
        const { result } = renderHook(() => useScrollProgress(ref));
        // Initial state is 1; a ResizeObserver trigger with identical
        // dims still computes 1.
        expect(result.current.scrollProgress).toBe(1);
    });

    it('updateScrollProgress computes 0..1 progress', async () => {
        const ref = makeScrollableRef({
            scrollTop: 0,
            scrollHeight: 500,
            clientHeight: 100,
        });
        const { result } = renderHook(() => useScrollProgress(ref));

        // Initial mount: scrollTop=0 / (scrollHeight-clientHeight=400) = 0
        // but the ResizeObserver hasn't fired yet so state is still 1
        // (the documented SSR-safe default). After manual update:
        act(() => result.current.updateScrollProgress());
        await flushFrame();
        expect(result.current.scrollProgress).toBe(0);

        act(() => {
            (ref.current as unknown as { scrollTop: number }).scrollTop = 200;
            result.current.updateScrollProgress();
        });
        await flushFrame();
        expect(result.current.scrollProgress).toBe(0.5);

        act(() => {
            (ref.current as unknown as { scrollTop: number }).scrollTop = 400;
            result.current.updateScrollProgress();
        });
        await flushFrame();
        expect(result.current.scrollProgress).toBe(1);
    });

    it('clamps progress to [0, 1] for overscroll / negative scroll', async () => {
        const ref = makeScrollableRef({
            scrollTop: -50,
            scrollHeight: 500,
            clientHeight: 100,
        });
        const { result } = renderHook(() => useScrollProgress(ref));
        act(() => result.current.updateScrollProgress());
        await flushFrame();
        expect(result.current.scrollProgress).toBe(0);

        act(() => {
            (ref.current as unknown as { scrollTop: number }).scrollTop = 9999;
            result.current.updateScrollProgress();
        });
        await flushFrame();
        expect(result.current.scrollProgress).toBe(1);
    });

    it('direction: "horizontal" reads scrollLeft / scrollWidth', async () => {
        const el = document.createElement('div');
        Object.defineProperty(el, 'scrollLeft', { value: 100, writable: true });
        Object.defineProperty(el, 'scrollWidth', { value: 500, writable: true });
        Object.defineProperty(el, 'clientWidth', { value: 100, writable: true });
        Object.defineProperty(el, 'scrollTop', { value: 0, writable: true });
        Object.defineProperty(el, 'scrollHeight', { value: 100, writable: true });
        Object.defineProperty(el, 'clientHeight', { value: 100, writable: true });
        const ref = { current: el };
        const { result } = renderHook(() =>
            useScrollProgress(ref, { direction: 'horizontal' }),
        );
        act(() => result.current.updateScrollProgress());
        await flushFrame();
        // 100 / (500 - 100) = 0.25
        expect(result.current.scrollProgress).toBe(0.25);
    });

    // ── #104: the batching itself ──────────────────────────────────────

    it('collapses an event storm within one frame to a SINGLE layout read', async () => {
        // Counts the LAYOUT READS, not the renders.
        //
        // Render count is the wrong assertion here and would pass against the
        // unbatched hook: React 18 auto-batches every setState inside one
        // act()/event scope, so twenty synchronous commits still yield one
        // render. What batching actually buys is that the hook stops
        // MEASURING per event — each measure reads scrollTop/scrollHeight/
        // clientHeight while the consumer writes the result back out as an
        // inline opacity, so an unbatched storm interleaves read/write/read
        // /write within one frame. That is the layout thrash, and it is
        // visible only in the read count.
        let reads = 0;
        const el = document.createElement('div');
        Object.defineProperty(el, 'scrollTop', {
            get() {
                reads += 1;
                return 300;
            },
        });
        Object.defineProperty(el, 'scrollHeight', { value: 500 });
        Object.defineProperty(el, 'clientHeight', { value: 100 });
        const ref = { current: el };

        const { result } = renderHook(() => useScrollProgress(ref));
        reads = 0;

        act(() => {
            for (let i = 0; i < 20; i += 1) result.current.updateScrollProgress();
        });
        await flushFrame();

        // One measurement for the whole storm, carrying the final position.
        expect(reads).toBe(1);
        expect(result.current.scrollProgress).toBe(0.75);
    });

    it('commits nothing when the progress delta is below the epsilon', async () => {
        const ref = makeScrollableRef({
            scrollTop: 200,
            scrollHeight: 500,
            clientHeight: 100,
        });
        let renders = 0;
        const { result } = renderHook(() => {
            renders += 1;
            return useScrollProgress(ref);
        });
        act(() => result.current.updateScrollProgress());
        await flushFrame();
        expect(result.current.scrollProgress).toBe(0.5);
        const settled = renders;

        // 0.5 -> 0.5001. The value drives an opacity of 1 - p², so this is
        // two orders of magnitude below anything visible — exactly the
        // sub-pixel churn a momentum scroll produces.
        act(() => {
            (ref.current as unknown as { scrollTop: number }).scrollTop = 200.04;
            result.current.updateScrollProgress();
        });
        await flushFrame();

        expect(result.current.scrollProgress).toBe(0.5);
        expect(renders).toBe(settled);
    });

    it('still commits at the ends of travel, however small the step', async () => {
        const ref = makeScrollableRef({
            scrollTop: 400,
            scrollHeight: 500,
            clientHeight: 100,
        });
        const { result } = renderHook(() => useScrollProgress(ref));
        act(() => result.current.updateScrollProgress());
        await flushFrame();
        expect(result.current.scrollProgress).toBe(1);

        // A sub-epsilon step AWAY from the boundary is suppressed, but the
        // boundary itself must always land — otherwise the fade settles at a
        // residual opacity instead of disappearing at the bottom.
        act(() => {
            (ref.current as unknown as { scrollTop: number }).scrollTop = 399.99;
            result.current.updateScrollProgress();
        });
        await flushFrame();
        expect(result.current.scrollProgress).toBe(1);

        act(() => {
            (ref.current as unknown as { scrollTop: number }).scrollTop = 0;
            result.current.updateScrollProgress();
        });
        await flushFrame();
        expect(result.current.scrollProgress).toBe(0);
    });

    it('cancels a queued frame on unmount so it cannot set state after teardown', async () => {
        const ref = makeScrollableRef({
            scrollTop: 200,
            scrollHeight: 500,
            clientHeight: 100,
        });
        const { result, unmount } = renderHook(() => useScrollProgress(ref));

        const errors: unknown[] = [];
        const spy = jest.spyOn(console, 'error').mockImplementation((...a) => {
            errors.push(a);
        });
        act(() => result.current.updateScrollProgress());
        unmount();
        await flushFrame();
        spy.mockRestore();

        // React warns "state update on an unmounted component" if the frame
        // survived the teardown.
        expect(errors).toEqual([]);
    });

    it('tears down its resize observer on unmount', () => {
        const ref = makeScrollableRef({});
        const { unmount } = renderHook(() => useScrollProgress(ref));
        const observer = MockResizeObserver.last();
        unmount();
        expect(observer.disconnected).toBe(true);
    });
});

// ── Smoke render ────────────────────────────────────────────────────────

describe('viewport/scroll hook cluster — smoke render', () => {
    it('mounts and unmounts cleanly from a real React tree', () => {
        function Harness() {
            const ref1 = React.useRef<HTMLDivElement>(null);
            const ref2 = React.useRef<HTMLDivElement>(null);
            useIntersectionObserver(ref1);
            useInViewport(ref1);
            useResizeObserver(ref2);
            useScroll(20);
            useScrollProgress(ref2);
            return (
                <div>
                    <div ref={ref1} />
                    <div ref={ref2} />
                </div>
            );
        }
        const { unmount } = render(<Harness />);
        expect(() => unmount()).not.toThrow();
        // All observers should be disconnected post-unmount
        const allIO = MockIntersectionObserver.instances;
        const allRO = MockResizeObserver.instances;
        for (const o of allIO) expect(o.disconnected).toBe(true);
        for (const o of allRO) expect(o.disconnected).toBe(true);
    });
});
