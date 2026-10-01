/**
 * The jsdom shims tldraw 3.15.6 needs in order to mount.
 *
 * ── Why this exists ──────────────────────────────────────────────────
 *
 * #2961 replaces the canvas renderer, and nothing had ever mounted tldraw in
 * this repo's test environment. The shape layer (#2994), the binding layer
 * (#2998) and the serializer (#3009) all shipped **unit-tested against plain
 * objects** — correct, but never once exercised by a live editor. The first
 * thing the surface swap needs is the ability to ask "does this work under a
 * mounted editor", and that was blocked on four missing browser APIs.
 *
 * Each was found by mounting and reading the error, in this order:
 *
 *   1. `image.decode is not a function`      → icon preloading
 *   2. `window.fetch is not a function`      → LicenseManager
 *   3. `document.fonts is not iterable`      → font readiness
 *   4. `FontFace is not defined`             → font registration
 *   5. `structuredClone is not defined`      → dagre, via auto-layout
 *
 * ── What this is NOT ─────────────────────────────────────────────────
 *
 * **Not a substitute for a browser.** jsdom still has no
 * `HTMLCanvasElement.prototype.getContext`, and mounting logs its
 * "Not implemented" notice — non-fatal, but it means every measurement tldraw
 * would take from a real canvas is absent here. So this harness answers
 * *mount, registration, wiring and serializer* questions. It cannot answer
 * *geometry, hit-testing, or visual* ones; those belong in Playwright, where
 * all four of these APIs are real.
 *
 * Stated plainly because a harness that mounts successfully invites more trust
 * than it has earned. A green jsdom test here is evidence the wiring is right,
 * never that the canvas draws correctly.
 *
 * ── Usage ────────────────────────────────────────────────────────────
 *
 * Call `installTldrawJsdomShims()` at module scope, BEFORE importing anything
 * from `tldraw` — the license manager reaches for `fetch` during module
 * evaluation, so a call inside `beforeEach` is already too late.
 */
import * as v8 from 'node:v8';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Installed once per module registry; calling twice is a no-op. */
let installed = false;

export function installTldrawJsdomShims(): void {
    if (installed) return;
    installed = true;

    // 1. Icon preloading calls `decode()` on every sprite it warms.
    if (typeof (HTMLImageElement.prototype as any).decode !== 'function') {
        (HTMLImageElement.prototype as any).decode = () => Promise.resolve();
    }

    // 2. `LicenseManager` fetches during initialisation. Resolving rather than
    //    rejecting keeps the editor on its normal path: an unlicensed build is
    //    a WATERMARKED build, not a broken one, and the watermark is the thing
    //    this repo's 3.x licence position depends on.
    if (typeof (window as any).fetch !== 'function') {
        (window as any).fetch = () =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({}),
                text: () => Promise.resolve(''),
            });
    }

    // 3. A constructible FontFace, needed before `document.fonts` is touched.
    /**
     * `structuredClone`, for dagre.
     *
     * Node has had this since 17 and the `node` test environment gets it for
     * free, which is why the auto-layout engine's own unit tests never needed
     * it. jsdom's global does not expose it, so the moment a JSDOM test runs a
     * layout — which is the only way to exercise the tldraw host adapter
     * against a real store — dagre throws from inside `order()`.
     *
     * Implemented with `v8.serialize` rather than a JSON round trip. JSON is
     * lossy in ways that matter to a graph library: `undefined` members
     * vanish, `Date` becomes a string, `Map` and `Set` become `{}`, and a cycle
     * throws. v8's pair gives real structured-clone semantics, so a shim that
     * happens to be enough for dagre today does not quietly become the reason
     * some other library misbehaves tomorrow.
     */
    if (typeof (globalThis as any).structuredClone !== 'function') {
        (globalThis as any).structuredClone = <T>(value: T): T =>
            v8.deserialize(v8.serialize(value)) as T;
    }

    if (typeof (globalThis as any).FontFace !== 'function') {
        (globalThis as any).FontFace = class FontFaceShim {
            family: string;
            constructor(family: string) {
                this.family = family;
            }
            load() {
                return Promise.resolve(this);
            }
        };
    }

    // 4. jsdom's FontFaceSet is not iterable, and tldraw spreads it.
    const fonts = (document as any).fonts;
    if (!fonts || typeof fonts[Symbol.iterator] !== 'function') {
        Object.defineProperty(document, 'fonts', {
            configurable: true,
            value: {
                ready: Promise.resolve(),
                add: () => {},
                delete: () => {},
                forEach: () => {},
                load: () => Promise.resolve([]),
                check: () => true,
                addEventListener: () => {},
                removeEventListener: () => {},
                [Symbol.iterator]: function* () {},
            },
        });
    }
}
