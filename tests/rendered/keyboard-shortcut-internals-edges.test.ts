/**
 * Epic 57 — edge-path tests for the shortcut parser / matcher.
 *
 * Companion to `keyboard-shortcut-parse.test.ts`, which covers the
 * happy grammar. This file covers the REFUSALS and FALLBACKS — the
 * paths that decide a keystroke must NOT fire a shortcut:
 *
 *   - non-string input rejected at registration time
 *   - a leading "+" binds to the key rather than opening an empty segment
 *   - platform detection when `navigator` is absent (server render) and
 *     when the UA string alone decides mod → meta vs mod → ctrl
 *   - a stray / missing Alt is a hard mismatch (the "don't hijack Alt+K"
 *     rule), symmetrically with meta and ctrl
 *   - an event with no `key` degrades to "no match" instead of throwing
 *
 * Every assertion is a value assertion: a regression flips a boolean or
 * changes a thrown message, and the test fails.
 *
 * Per-test timeout bump for the same reason as the sibling file (see its
 * header): jsdom boot under full-suite parallelism.
 *
 * Why a `.ts` file lives under `tests/rendered/` rather than `tests/unit/`:
 * the module under test is pure, but its inputs are not. `KeyboardEvent`
 * and `navigator` only exist under the jsdom project — the node project
 * has neither, and it excludes `tests/rendered/` outright. The sibling
 * happy-path suite `keyboard-shortcut-parse.test.ts` is a `.ts` here for
 * exactly the same reason.
 */
jest.setTimeout(90_000);

import {
    __setIsMacForTests,
    describePressedKey,
    isMacPlatform,
    matchShortcut,
    parseShortcut,
} from '@/lib/hooks/keyboard-shortcut-internals';

// ─── Typed helpers ─────────────────────────────────────────────────────

type Mods = Partial<Record<'meta' | 'ctrl' | 'alt' | 'shift', boolean>>;

function evt(key: string, mods: Mods = {}): KeyboardEvent {
    return new KeyboardEvent('keydown', {
        key,
        metaKey: !!mods.meta,
        ctrlKey: !!mods.ctrl,
        altKey: !!mods.alt,
        shiftKey: !!mods.shift,
    });
}

/**
 * `parseShortcut` is declared `(input: string)`, but its first guard is a
 * RUNTIME `typeof input !== 'string'` check — the registration-time net
 * for a prop that arrived as `undefined` from untyped JSX or a JS
 * consumer. Reaching it from TypeScript needs a deliberate cast, named
 * here so the intent is explicit and no `any` escapes into a test body.
 */
function parseUntyped(input: unknown): ReturnType<typeof parseShortcut> {
    return parseShortcut(input as string);
}

/**
 * A KeyboardEvent whose `key` is absent. `new KeyboardEvent(...)` always
 * materialises `key: ''`, so the `event.key ?? ''` guards in
 * `matchShortcut` / `describePressedKey` are only reachable through a
 * structural stand-in. The cast is deliberate and confined to this
 * helper.
 */
function keylessEvent(mods: Mods = {}): KeyboardEvent {
    return {
        metaKey: !!mods.meta,
        ctrlKey: !!mods.ctrl,
        altKey: !!mods.alt,
        shiftKey: !!mods.shift,
    } as unknown as KeyboardEvent;
}

/**
 * Swap `navigator.userAgent` for the duration of `fn`, then restore it.
 *
 * jsdom exposes `userAgent` as an accessor on `Navigator.prototype`, not
 * as an own property, so the restore has to DELETE the shadowing own
 * property rather than re-defining a descriptor that never existed —
 * otherwise the last UA set here leaks into every later test in the file.
 */
function withUserAgent(ua: string, fn: () => void): void {
    const original = Object.getOwnPropertyDescriptor(
        window.navigator,
        'userAgent',
    );
    Object.defineProperty(window.navigator, 'userAgent', {
        value: ua,
        configurable: true,
    });
    try {
        fn();
    } finally {
        if (original) {
            Object.defineProperty(window.navigator, 'userAgent', original);
        } else {
            delete (window.navigator as unknown as { userAgent?: string })
                .userAgent;
        }
    }
}

beforeEach(() => {
    // Never inherit a platform override from a sibling test.
    __setIsMacForTests(null);
});

afterEach(() => {
    __setIsMacForTests(null);
});

// ─── Registration-time refusals ────────────────────────────────────────

describe('parseShortcut — refusals', () => {
    it('rejects a non-string input with the empty-input message', () => {
        // Regression class: a shortcut prop that arrives `undefined` must
        // blow up at registration, not silently register a binding that
        // can never match.
        expect(() => parseUntyped(undefined)).toThrow(
            '[useKeyboardShortcut] empty shortcut input',
        );
        expect(() => parseUntyped(null)).toThrow(
            '[useKeyboardShortcut] empty shortcut input',
        );
        expect(() => parseUntyped(42)).toThrow(
            '[useKeyboardShortcut] empty shortcut input',
        );
    });

    it('names the offending token AND the whole expression when a modifier is unknown', () => {
        // The message is the only debugging aid an author gets, so its
        // content is part of the contract.
        expect(() => parseShortcut('hyper+shift+k')).toThrow(
            '[useKeyboardShortcut] unknown modifier "hyper" in "hyper+shift+k". ' +
                'Valid modifiers: meta, cmd, command, ctrl, control, alt, opt, option, shift, mod.',
        );
    });

    it('validates only the modifier positions — the final token is the key', () => {
        expect(parseShortcut('hyper').key).toBe('hyper');
    });
});

// ─── `+` as separator vs `+` as literal ────────────────────────────────

describe('parseShortcut — the "+" ambiguity', () => {
    it('binds a LEADING "+" to the key rather than opening an empty segment', () => {
        const p = parseShortcut('+');
        expect(p.key).toBe('+');
        expect(p.modifiers).toEqual({
            meta: false,
            ctrl: false,
            alt: false,
            shift: false,
        });
        expect(p.usesMod).toBe(false);
    });

    it('preserves the raw expression for the palette / telemetry', () => {
        expect(parseShortcut('Mod+K').raw).toBe('Mod+K');
        expect(parseShortcut('mod++').raw).toBe('mod++');
    });

    it('maps the "space" aliases onto the literal space key', () => {
        // `event.key` for the spacebar is " ", so the alias is what makes
        // `useKeyboardShortcut('space', …)` work at all.
        expect(parseShortcut('space').key).toBe(' ');
        expect(parseShortcut('Spacebar').key).toBe(' ');
        expect(matchShortcut(evt(' '), parseShortcut('space'))).toBe(true);
        expect(matchShortcut(evt('s'), parseShortcut('space'))).toBe(false);
    });

    it('maps "esc" onto the same key as "Escape"', () => {
        expect(parseShortcut('esc').key).toBe(parseShortcut('Escape').key);
        expect(matchShortcut(evt('Escape'), parseShortcut('esc'))).toBe(true);
    });
});

// ─── Platform detection ────────────────────────────────────────────────

describe('isMacPlatform', () => {
    it('returns false when there is no navigator at all (server render)', () => {
        const original = Object.getOwnPropertyDescriptor(
            globalThis,
            'navigator',
        );
        Object.defineProperty(globalThis, 'navigator', {
            value: undefined,
            configurable: true,
        });
        try {
            // Must not throw on `navigator.userAgent` — this module is
            // imported by a 'use client' file that is still evaluated
            // during SSR.
            expect(isMacPlatform()).toBe(false);
        } finally {
            if (original) {
                Object.defineProperty(globalThis, 'navigator', original);
            } else {
                // Inherited from Window.prototype — drop the shadow so
                // the real accessor is visible again for later tests.
                delete (globalThis as unknown as { navigator?: Navigator })
                    .navigator;
            }
        }
    });

    it('reads the platform off the user-agent when no override is set', () => {
        withUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            () => expect(isMacPlatform()).toBe(true),
        );
        withUserAgent(
            'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
            () => expect(isMacPlatform()).toBe(true),
        );
        withUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            () => expect(isMacPlatform()).toBe(false),
        );
        withUserAgent(
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
            () => expect(isMacPlatform()).toBe(false),
        );
    });

    it('resolves `mod` off the user-agent end-to-end, with no test override', () => {
        const p = parseShortcut('mod+k');
        withUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            () => {
                expect(matchShortcut(evt('k', { meta: true }), p)).toBe(true);
                expect(matchShortcut(evt('k', { ctrl: true }), p)).toBe(false);
            },
        );
        withUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            () => {
                expect(matchShortcut(evt('k', { ctrl: true }), p)).toBe(true);
                expect(matchShortcut(evt('k', { meta: true }), p)).toBe(false);
            },
        );
    });

    it('lets an explicit override beat the user-agent in both directions', () => {
        withUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            () => {
                __setIsMacForTests(true);
                expect(isMacPlatform()).toBe(true);
                // `false` is a real override, not "unset" — the module
                // stores `null` for unset precisely so this works.
                __setIsMacForTests(false);
                expect(isMacPlatform()).toBe(false);
            },
        );
        withUserAgent(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            () => {
                __setIsMacForTests(false);
                expect(isMacPlatform()).toBe(false);
            },
        );
    });
});

// ─── Alt is matched exactly, in both directions ────────────────────────

describe('matchShortcut — Alt strictness', () => {
    it('refuses a bare key while Alt is held', () => {
        // Alt+K produces an accented character on several layouts; a
        // global "k" binding stealing it would eat the keystroke.
        expect(matchShortcut(evt('k', { alt: true }), parseShortcut('k'))).toBe(
            false,
        );
    });

    it('refuses an Alt shortcut when Alt is NOT held', () => {
        expect(matchShortcut(evt('k'), parseShortcut('alt+k'))).toBe(false);
        expect(
            matchShortcut(evt('k', { alt: true }), parseShortcut('alt+k')),
        ).toBe(true);
    });

    it('requires every declared modifier simultaneously', () => {
        const p = parseShortcut('meta+alt+shift+k');
        expect(
            matchShortcut(evt('k', { meta: true, alt: true, shift: true }), p),
        ).toBe(true);
        expect(matchShortcut(evt('k', { alt: true, shift: true }), p)).toBe(false);
        expect(matchShortcut(evt('k', { meta: true, shift: true }), p)).toBe(false);
        expect(matchShortcut(evt('k', { meta: true, alt: true }), p)).toBe(false);
        // …and refuses the extra modifier the author did not ask for.
        expect(
            matchShortcut(
                evt('k', { meta: true, alt: true, shift: true, ctrl: true }),
                p,
            ),
        ).toBe(false);
    });

    it('ignores a stray Shift when the author did not declare it', () => {
        // Asymmetry with meta/ctrl/alt, and it is deliberate: "?" is
        // Shift+/ on a US layout.
        expect(matchShortcut(evt('k', { shift: true }), parseShortcut('k'))).toBe(
            true,
        );
    });
});

// ─── Events with no `key` ──────────────────────────────────────────────

describe('matchShortcut / describePressedKey — absent `event.key`', () => {
    it('returns false instead of throwing when the event carries no key', () => {
        // A regression here is a TypeError raised inside the global
        // keydown listener, which would kill EVERY shortcut for the
        // session, not just this one.
        expect(matchShortcut(keylessEvent(), parseShortcut('k'))).toBe(false);
        expect(
            matchShortcut(keylessEvent({ meta: true }), parseShortcut('meta+k')),
        ).toBe(false);
    });

    it('describes a keyless event as its modifiers alone', () => {
        expect(describePressedKey(keylessEvent())).toBe('');
        expect(describePressedKey(keylessEvent({ ctrl: true }))).toBe('ctrl+');
    });
});

describe('describePressedKey — modifier serialisation', () => {
    it('emits the bare key when no modifier is held', () => {
        expect(describePressedKey(evt('a'))).toBe('a');
        expect(describePressedKey(evt('ArrowUp'))).toBe('arrowup');
    });

    it('emits ctrl and alt, which the happy-path test never exercises', () => {
        expect(
            describePressedKey(evt('ArrowUp', { ctrl: true, alt: true })),
        ).toBe('ctrl+alt+arrowup');
    });

    it('keeps the canonical meta→ctrl→alt→shift order with all four held', () => {
        expect(
            describePressedKey(
                evt('K', { meta: true, ctrl: true, alt: true, shift: true }),
            ),
        ).toBe('meta+ctrl+alt+shift+k');
    });
});
