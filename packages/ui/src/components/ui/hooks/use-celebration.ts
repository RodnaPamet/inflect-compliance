/**
 * Epic 62 — `useCelebration` hook.
 *
 * Returns a stable `celebrate()` callback that fires a confetti preset (and an
 * optional toast), with per-tab deduplication so a user who, say, refreshes a
 * page three times doesn't get bombed three times.
 *
 * ONE call shape — the caller supplies the preset, the dedupe key and the copy:
 *
 *   ```ts
 *   const { celebrate } = useCelebration(dedupe);
 *
 *   celebrate({ preset: 'burst', key: 'sandbox-demo', message: 'Nice!' });
 *   ```
 *
 * There used to be a second, keyed shape — `celebrate('some-milestone')` —
 * which looked the preset and the copy up in a registry of four product
 * milestones. The hook's input type was therefore a closed union of this
 * product's milestones, which no other product could extend or call. Every
 * production call site already passed an object, so dropping the keyed path
 * changed no call site; the registry stays where it belongs, in the app, and
 * builds the object it used to be looked up by.
 *
 * ## Dedupe is INJECTED, deliberately
 *
 * `hasCelebrated` / `markCelebrated` come in as arguments rather than living
 * here, because the storage key they build is brand-prefixed — it names the
 * product. Moving the pair into this file would have carried that key into
 * shared UI and left the file coupled on judgement even once it was clean
 * mechanically. Plain functions in, no context provider: one argument is
 * cheaper than a provider, and a provider is not earned by three call sites.
 *
 * SSR safety: every browser-touching code path is guarded with
 * `typeof window === 'undefined'`. The returned `celebrate` is a no-op on the
 * server and inside test environments without a window. The injected dedupe
 * functions are expected to be SSR-safe too.
 *
 * `prefers-reduced-motion`: every preset passes
 * `disableForReducedMotion: true` to canvas-confetti, which silently
 * suppresses the canvas when the user has opted out. The toast
 * still fires, so the user still gets the recognition without the
 * motion noise.
 */
import { useCallback, useRef } from 'react';
import { toast } from 'sonner';

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Visual style of the celebration — one of the choreographies defined below.
 *
 *   - `burst`     — a single centred burst. Default for "you finished
 *                   a thing" moments.
 *   - `rain`      — gentle particles falling across the top edge for a
 *                   couple of seconds. Best for an ongoing-good-state
 *                   moment (everything current).
 *   - `fireworks` — three offset bursts in succession, evoking a small
 *                   show. Reserve for the high-stakes ones.
 */
export type CelebrationPreset = 'burst' | 'rain' | 'fireworks';

/** Everything `celebrate()` needs, supplied by the caller. */
export interface CelebrateInput {
    preset: CelebrationPreset;
    /** Optional dedupe key. Omit to allow re-firing. */
    key?: string;
    /** Optional toast title. Skipped when omitted. */
    message?: string;
    /** Optional toast description shown under `message`. */
    description?: string;
}

/**
 * The per-tab "already celebrated?" pair. Injected because the key it builds
 * belongs to the host product, not to this package — see the header.
 */
export interface CelebrationDedupe {
    /** True when this key has already celebrated in this tab. SSR-safe. */
    hasCelebrated: (key: string) => boolean;
    /** Record this key as celebrated in this tab. Idempotent. SSR-safe. */
    markCelebrated: (key: string) => void;
}

export interface UseCelebrationResult {
    /** Trigger a celebration. */
    celebrate: (input: CelebrateInput) => void;
    /** Pass-through to the injected read-only dedupe check. */
    hasCelebrated: (key: string) => boolean;
}

// ─── Preset choreographies ─────────────────────────────────────────
//
// Each preset receives the canvas-confetti default export so the
// hook can stub it out in tests via DI without monkey-patching the
// module.

type ConfettiFn = (
    options?: import('canvas-confetti').Options,
) => Promise<null> | null;

const REDUCED_MOTION_DEFAULT = { disableForReducedMotion: true } as const;

function fireBurst(confetti: ConfettiFn): void {
    void confetti({
        ...REDUCED_MOTION_DEFAULT,
        particleCount: 120,
        spread: 70,
        origin: { x: 0.5, y: 0.6 },
        ticks: 200,
    });
}

function fireRain(confetti: ConfettiFn): void {
    // Three short bursts spread across the top, evenly spaced over
    // ~1.5 s. Reads as gentle "stuff falling" rather than a punch.
    [0.2, 0.5, 0.8].forEach((x, i) => {
        setTimeout(() => {
            void confetti({
                ...REDUCED_MOTION_DEFAULT,
                particleCount: 40,
                startVelocity: 25,
                spread: 60,
                gravity: 0.6,
                ticks: 300,
                origin: { x, y: 0 },
            });
        }, i * 500);
    });
}

function fireFireworks(confetti: ConfettiFn): void {
    // Three full-spread bursts staggered by ~250 ms from offset
    // origins — feels like a small show without dominating the page.
    [
        { x: 0.25, y: 0.5 },
        { x: 0.5, y: 0.45 },
        { x: 0.75, y: 0.5 },
    ].forEach((origin, i) => {
        setTimeout(() => {
            void confetti({
                ...REDUCED_MOTION_DEFAULT,
                particleCount: 80,
                startVelocity: 45,
                spread: 100,
                ticks: 250,
                origin,
            });
        }, i * 250);
    });
}

const PRESET_RUNNERS: Record<CelebrationPreset, (c: ConfettiFn) => void> = {
    burst: fireBurst,
    rain: fireRain,
    fireworks: fireFireworks,
};

// ─── Module-level cached confetti loader ────────────────────────────
//
// canvas-confetti pulls in a small canvas runtime; loading lazily on
// the first celebration keeps it out of the main bundle for users who
// never trigger one.

let cachedConfetti: ConfettiFn | null = null;

async function loadConfetti(): Promise<ConfettiFn> {
    if (cachedConfetti) return cachedConfetti;
    const mod = await import('canvas-confetti');
    cachedConfetti = mod.default as unknown as ConfettiFn;
    return cachedConfetti;
}

// Test-only seam — call this with a stub before invoking the hook to
// avoid pulling in the real library under jsdom. NOT exported via the
// barrel; tests reach in directly.
export function __setConfettiForTest(stub: ConfettiFn | null): void {
    cachedConfetti = stub;
}

// ─── Hook ───────────────────────────────────────────────────────────

export function useCelebration(dedupe: CelebrationDedupe): UseCelebrationResult {
    // Hold the latest cancellation-aware ref so unmounting between
    // the firing of the celebration and the toast settle doesn't
    // trip a setState-on-unmounted warning. Toast itself is fire-
    // and-forget; we just want a stable identity for the callback.
    const aliveRef = useRef(true);

    // Destructured so the callback depends on the two FUNCTIONS, not on the
    // container object. A caller writing `useCelebration({ hasCelebrated,
    // markCelebrated })` builds a fresh object every render; depending on it
    // would change `celebrate`'s identity every render and re-run every
    // consumer `useEffect` that lists it.
    const { hasCelebrated, markCelebrated } = dedupe;

    const celebrate = useCallback(
        (input: CelebrateInput) => {
            if (typeof window === 'undefined') return;

            // Dedupe — only when a key was provided.
            if (input.key && hasCelebrated(input.key)) return;
            if (input.key) markCelebrated(input.key);

            // Fire confetti async (lazy import). Toast can fire
            // immediately so the message lands without waiting on the
            // chunk load.
            if (input.message) {
                toast.success(input.message, {
                    description: input.description,
                });
            }

            void loadConfetti().then((confetti) => {
                if (!aliveRef.current) return;
                PRESET_RUNNERS[input.preset](confetti);
            });
        },
        [hasCelebrated, markCelebrated],
    );

    return { celebrate, hasCelebrated };
}
