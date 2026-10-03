/**
 * Epic 62 — `useCelebration` hook.
 *
 * The real `canvas-confetti` mounts a `<canvas>` and uses
 * `requestAnimationFrame`; under jsdom we don't actually want pixels
 * — we want to assert that the hook resolves the right preset
 * choreography and respects the dedupe it was handed.
 *
 * The test injects a stub via `__setConfettiForTest` so each preset's
 * call signature can be inspected without running the real library
 * loader. Sonner's `toast.success` is mocked at module level so
 * message assertions stay decoupled from the global Toaster mount.
 *
 * ## Two layers, on purpose
 *
 * The hook no longer imports its dedupe pair — `#3046` batch 2 inverted that
 * edge so shared UI stops importing `@/lib/celebrations`, whose storage key is
 * brand-prefixed. So the suite has two halves:
 *
 *   - **Injected dependencies** — a fake pair of spies. This is where each
 *     returned behaviour is covered, because a fake is the only way to assert
 *     WHICH key the hook reads and writes, and that it writes one at all.
 *   - **The real `celebrationDedupe`** — the exact object the three production
 *     call sites pass. This is the half that proves the live wiring still
 *     writes `inflect.celebrate:<key>` byte-for-byte, which a fake cannot.
 *
 * The keyed call shape (`celebrate('framework-100')`) is gone with the same
 * change: the hook took a closed union of this product's four milestones, so
 * no second product could call it. The registry now builds the object.
 */
/** @jest-environment jsdom */

import * as React from 'react';
import { act, render } from '@testing-library/react';

const toastSuccessMock = jest.fn();
jest.mock('sonner', () => ({
    toast: {
        success: (...args: unknown[]) => toastSuccessMock(...args),
    },
}));

import {
    useCelebration,
    __setConfettiForTest,
    type CelebrationDedupe,
} from '@/components/ui/hooks/use-celebration';
import {
    celebrationDedupe,
    celebrationDedupeKey,
    clearCelebrated,
    MILESTONES,
    scopedMilestone,
} from '@/lib/celebrations';

// ─── Test harness ───────────────────────────────────────────────────

interface HarnessProps {
    dedupe: CelebrationDedupe;
    onReady: (api: ReturnType<typeof useCelebration>) => void;
}

function Harness({ dedupe, onReady }: HarnessProps) {
    const api = useCelebration(dedupe);
    React.useEffect(() => {
        onReady(api);
    }, [api, onReady]);
    return null;
}

interface ConfettiCall {
    options: import('canvas-confetti').Options | undefined;
}

function makeConfettiStub() {
    const calls: ConfettiCall[] = [];
    const stub: (opts?: import('canvas-confetti').Options) => Promise<null> = (
        opts,
    ) => {
        calls.push({ options: opts });
        return Promise.resolve(null);
    };
    return { stub, calls };
}

/** A dedupe pair backed by a Set, so the suite can see every read + write. */
function makeFakeDedupe() {
    const marked = new Set<string>();
    const hasCelebrated = jest.fn((key: string) => marked.has(key));
    const markCelebrated = jest.fn((key: string) => {
        marked.add(key);
    });
    return { marked, dedupe: { hasCelebrated, markCelebrated } };
}

async function flush(ms = 0) {
    // The hook fires confetti after `loadConfetti()` resolves and
    // setTimeout-staggered presets need timers to advance. Use real
    // timers + microtask flushes — fake timers + dynamic-import
    // promise chains are awkward to coordinate.
    await act(async () => {
        await new Promise((r) => setTimeout(r, ms));
    });
}

function mount(dedupe: CelebrationDedupe) {
    let api!: ReturnType<typeof useCelebration>;
    const rendered = render(<Harness dedupe={dedupe} onReady={(a) => (api = a)} />);
    return { get api() { return api; }, rendered };
}

// ─── Injected dependencies — the returned behaviours ────────────────

describe('useCelebration — injected dedupe', () => {
    beforeEach(() => {
        toastSuccessMock.mockClear();
    });

    it('celebrate fires the requested preset — burst is one call', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { dedupe } = makeFakeDedupe();

        const h = mount(dedupe);
        await act(async () => {
            h.api.celebrate({ preset: 'burst' });
        });
        await flush(0);
        expect(calls.length).toBe(1);
        expect(calls[0].options?.particleCount).toBeGreaterThan(0);
        expect(calls[0].options?.disableForReducedMotion).toBe(true);
    });

    it('celebrate fires three staggered bursts for rain, all from the top edge', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { dedupe } = makeFakeDedupe();

        const h = mount(dedupe);
        await act(async () => {
            h.api.celebrate({ preset: 'rain' });
        });
        await flush(1100);
        expect(calls.length).toBe(3);
        for (const c of calls) expect(c.options?.origin?.y).toBe(0);
    });

    it('celebrate fires three offset bursts for fireworks', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { dedupe } = makeFakeDedupe();

        const h = mount(dedupe);
        await act(async () => {
            h.api.celebrate({ preset: 'fireworks' });
        });
        await flush(700);
        expect(calls.length).toBe(3);
        expect(calls.every((c) => c.options?.disableForReducedMotion)).toBe(true);
    });

    it('celebrate reads AND writes the injected dedupe, with the key it was given', async () => {
        const { stub } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { marked, dedupe } = makeFakeDedupe();

        const h = mount(dedupe);
        await act(async () => {
            h.api.celebrate({ preset: 'burst', key: 'k-1' });
        });
        await flush(0);
        expect(dedupe.hasCelebrated).toHaveBeenCalledWith('k-1');
        expect(dedupe.markCelebrated).toHaveBeenCalledWith('k-1');
        expect([...marked]).toEqual(['k-1']);
    });

    it('celebrate short-circuits BOTH confetti and toast when the key is already marked', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { marked, dedupe } = makeFakeDedupe();
        marked.add('k-1');

        const h = mount(dedupe);
        await act(async () => {
            h.api.celebrate({ preset: 'burst', key: 'k-1', message: 'Nice!' });
        });
        await flush(0);
        expect(calls.length).toBe(0);
        expect(toastSuccessMock).not.toHaveBeenCalled();
        // And it did not re-mark — the write is downstream of the read.
        expect(dedupe.markCelebrated).not.toHaveBeenCalled();
    });

    it('celebrate without a key touches the dedupe not at all, and re-fires', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { dedupe } = makeFakeDedupe();

        const h = mount(dedupe);
        await act(async () => {
            h.api.celebrate({ preset: 'burst' });
        });
        await flush(0);
        const first = calls.length;
        await act(async () => {
            h.api.celebrate({ preset: 'burst' });
        });
        await flush(0);
        expect(calls.length).toBeGreaterThan(first);
        expect(dedupe.hasCelebrated).not.toHaveBeenCalled();
        expect(dedupe.markCelebrated).not.toHaveBeenCalled();
    });

    it('celebrate passes message + description to sonner, and skips the toast without a message', async () => {
        const { stub } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { dedupe } = makeFakeDedupe();

        const h = mount(dedupe);
        await act(async () => {
            h.api.celebrate({
                preset: 'burst',
                message: 'Pack ready',
                description: 'Frozen and shareable.',
            });
        });
        await flush(0);
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        const [title, opts] = toastSuccessMock.mock.calls[0] as [
            string,
            { description?: string },
        ];
        expect(title).toBe('Pack ready');
        expect(opts?.description).toBe('Frozen and shareable.');

        toastSuccessMock.mockClear();
        await act(async () => {
            h.api.celebrate({ preset: 'burst' });
        });
        await flush(0);
        expect(toastSuccessMock).not.toHaveBeenCalled();
    });

    it('the returned hasCelebrated IS the injected one — a pass-through, not a copy', () => {
        const { stub } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { marked, dedupe } = makeFakeDedupe();

        const h = mount(dedupe);
        expect(h.api.hasCelebrated).toBe(dedupe.hasCelebrated);
        expect(h.api.hasCelebrated('k-9')).toBe(false);
        marked.add('k-9');
        expect(h.api.hasCelebrated('k-9')).toBe(true);
    });

    it('celebrate keeps a stable identity across re-renders when the pair is stable', () => {
        const { stub } = makeConfettiStub();
        __setConfettiForTest(stub);
        const { dedupe } = makeFakeDedupe();

        // A caller passing a FRESH wrapper object each render must not get a
        // fresh `celebrate`: the three consumers list it in a `useEffect` dep
        // array, so a changing identity would re-run the effect every render.
        let api!: ReturnType<typeof useCelebration>;
        const onReady = (a: ReturnType<typeof useCelebration>) => (api = a);
        const { rerender } = render(
            <Harness dedupe={{ ...dedupe }} onReady={onReady} />,
        );
        const first = api.celebrate;
        rerender(<Harness dedupe={{ ...dedupe }} onReady={onReady} />);
        expect(api.celebrate).toBe(first);
    });
});

// ─── The real pair the production call sites pass ───────────────────

describe('useCelebration — the live celebrationDedupe', () => {
    beforeEach(() => {
        window.sessionStorage.clear();
        toastSuccessMock.mockClear();
    });

    it('writes the brand-prefixed sessionStorage key, and dedupes on it', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);

        const h = mount(celebrationDedupe);
        await act(async () => {
            h.api.celebrate(scopedMilestone('framework-100', 'iso27001'));
        });
        await flush(700);
        const firstCount = calls.length;
        expect(firstCount).toBeGreaterThan(0);
        expect(
            window.sessionStorage.getItem(
                celebrationDedupeKey('framework-100:iso27001'),
            ),
        ).not.toBeNull();

        // Second call in the same tab is a no-op.
        await act(async () => {
            h.api.celebrate(scopedMilestone('framework-100', 'iso27001'));
        });
        await flush(700);
        expect(calls.length).toBe(firstCount);
    });

    it('clearing the dedupe entry lets the milestone fire again', async () => {
        const { stub, calls } = makeConfettiStub();
        __setConfettiForTest(stub);

        const h = mount(celebrationDedupe);
        const def = MILESTONES['first-control-mapped'];
        await act(async () => {
            h.api.celebrate(def);
        });
        await flush(0);
        const firstCount = calls.length;

        clearCelebrated('first-control-mapped');

        await act(async () => {
            h.api.celebrate(def);
        });
        await flush(0);
        expect(calls.length).toBeGreaterThan(firstCount);
    });

    it('a registry record carries its own toast copy through', async () => {
        const { stub } = makeConfettiStub();
        __setConfettiForTest(stub);

        const h = mount(celebrationDedupe);
        await act(async () => {
            h.api.celebrate(MILESTONES['framework-100']);
        });
        await flush(0);
        expect(toastSuccessMock).toHaveBeenCalledTimes(1);
        const [title, opts] = toastSuccessMock.mock.calls[0] as [
            string,
            { description?: string },
        ];
        expect(title).toContain('100% framework coverage');
        expect(opts?.description).toContain('Every applicable control');
    });

    it('hasCelebrated reflects sessionStorage through the live pair', async () => {
        const { stub } = makeConfettiStub();
        __setConfettiForTest(stub);

        const h = mount(celebrationDedupe);
        expect(h.api.hasCelebrated('framework-100')).toBe(false);
        await act(async () => {
            h.api.celebrate(MILESTONES['framework-100']);
        });
        await flush(0);
        expect(h.api.hasCelebrated('framework-100')).toBe(true);
    });
});

describe('useCelebration — barrel export', () => {
    it('is exported from @/components/ui/hooks', () => {
        const barrel = jest.requireActual('@/components/ui/hooks');
        expect(typeof barrel.useCelebration).toBe('function');
    });
});
