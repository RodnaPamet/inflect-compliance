/**
 * Keyboard shortcut internals — string parsing and event matching.
 *
 * The public surface is the `useKeyboardShortcut` hook (see
 * `use-keyboard-shortcut.tsx`). This file holds the pure helpers so
 * they can be unit-tested without mounting React.
 *
 *   parseShortcut("mod+k")    →  { key: "k", mods: {…}, usesMod: true }
 *   matchShortcut(event, p)   →  boolean — does the keyboard event satisfy p
 *
 * Shortcut grammar:
 *   "<mod>+...+<key>"
 *       mod  : meta | cmd | command | ctrl | control | alt | opt | option
 *              | shift | mod   ("mod" resolves to meta on Mac, ctrl elsewhere)
 *       key  : a single printable char (case-insensitive) or a named key
 *              ("Escape", "Enter", "Tab", "ArrowUp", etc.)
 *
 * Matching rules:
 *   - meta/ctrl/alt are matched *exactly*: if the author didn't ask for
 *     the modifier, an event with that modifier pressed does NOT match.
 *     (Accidentally swallowing Cmd+Shift+K when the author only registered
 *     "k" would be a nasty surprise.)
 *   - shift is the exception: the author may write "?" meaning Shift+/,
 *     so we only enforce shift when it was explicitly requested.
 *     `event.key` is already the shifted character ("?", "K"), so the
 *     key-token comparison still does the right thing for case.
 *   - `event.key` and the parsed key are compared case-insensitively.
 */

export interface ParsedShortcut {
    /** The primary key, lower-cased. `"Escape"` → `"escape"`, `"K"` → `"k"`. */
    key: string;
    modifiers: {
        meta: boolean;
        ctrl: boolean;
        alt: boolean;
        shift: boolean;
    };
    /** `true` if the user wrote `mod+…`. Resolved to meta/ctrl at match time. */
    usesMod: boolean;
    /** Original author-provided string, preserved for logs / the palette. */
    raw: string;
}

const ALIASES: Record<string, string> = {
    cmd: 'meta',
    command: 'meta',
    opt: 'alt',
    option: 'alt',
    control: 'ctrl',
    esc: 'escape',
    return: 'enter',
    space: ' ',
    spacebar: ' ',
};

const MODIFIER_TOKENS = new Set(['meta', 'ctrl', 'alt', 'shift', 'mod']);

function normaliseToken(token: string): string {
    const lower = token.trim().toLowerCase();
    return ALIASES[lower] ?? lower;
}

/**
 * Detect whether the current platform uses ⌘ (Mac) or Ctrl.
 *
 * Branches on `navigator.userAgent` because `navigator.platform` is
 * deprecated and lies on Apple Silicon (reports `"MacIntel"` even in
 * Chromium translation of Windows-era check). Tests can override this
 * via the exported `__setIsMacForTests` helper.
 */
let _isMacOverride: boolean | null = null;

export function __setIsMacForTests(value: boolean | null): void {
    _isMacOverride = value;
}

export function isMacPlatform(): boolean {
    if (_isMacOverride !== null) return _isMacOverride;
    if (typeof navigator === 'undefined') return false;
    return /mac|iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * Parse a shortcut expression. Throws on empty / unrecognised input so
 * mistakes surface at registration time, not when the user actually
 * presses the key.
 */
export function parseShortcut(input: string): ParsedShortcut {
    if (typeof input !== 'string' || input.length === 0) {
        throw new Error(`[useKeyboardShortcut] empty shortcut input`);
    }
    // `+` is both the separator and a legal key literal ("mod++" would
    // mean mod plus the `+` key). Use a char-level parse so a trailing
    // `+` binds to the key, not to an empty separator.
    const raw = input;
    const parts: string[] = [];
    let buf = '';
    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === '+' && buf.length > 0 && i < input.length - 1) {
            parts.push(buf);
            buf = '';
        } else {
            buf += ch;
        }
    }
    if (buf.length > 0) parts.push(buf);
    if (parts.length === 0) {
        throw new Error(`[useKeyboardShortcut] invalid shortcut "${raw}"`);
    }

    const modifiers = { meta: false, ctrl: false, alt: false, shift: false };
    let usesMod = false;

    const keyToken = parts.pop() as string;
    for (const token of parts) {
        const n = normaliseToken(token);
        if (!MODIFIER_TOKENS.has(n)) {
            throw new Error(
                `[useKeyboardShortcut] unknown modifier "${token}" in "${raw}". ` +
                    `Valid modifiers: meta, cmd, command, ctrl, control, alt, opt, option, shift, mod.`,
            );
        }
        if (n === 'mod') usesMod = true;
        else (modifiers as Record<string, boolean>)[n] = true;
    }

    const key = normaliseToken(keyToken);
    return { key, modifiers, usesMod, raw };
}

/**
 * The PHYSICAL code a single letter or digit sits on, or null for anything else.
 *
 * `event.key` carries what the layout PRODUCES. On a Bulgarian layout the key
 * labelled K produces 'к' (Cyrillic ka), so `'к' === 'k'` is false and every
 * letter shortcut in the app silently stopped working for that user —
 * `mod+k` opened nothing. `event.code` carries WHICH KEY was pressed, which is
 * what a shortcut like "Ctrl+K" actually means.
 *
 * NAMED keys and PUNCTUATION are deliberately excluded and keep matching on
 * `event.key`. '/' , '?' and ',' live on different physical keys across layouts,
 * so a code-based match would fire them from wherever the US layout happens to
 * put them — the opposite of the fix.
 *
 * The trade-off, stated rather than hidden: a Dvorak user pressing the key in
 * the QWERTY 'K' POSITION now triggers `mod+k`, even though their layout prints
 * 'v' there. That is the same rule every native application uses, and it is the
 * cost of making the shortcut mean a key rather than a glyph.
 *
 * Numpad digits are NOT matched: `Digit0`-`Digit9` only, so `Numpad1` does not
 * fire a '1' shortcut while somebody is typing figures.
 */
export function physicalCodeFor(key: string): string | null {
    if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    return null;
}

export function matchShortcut(event: KeyboardEvent, parsed: ParsedShortcut): boolean {
    const { modifiers, usesMod, key } = parsed;

    const expectMeta = modifiers.meta || (usesMod && isMacPlatform());
    const expectCtrl = modifiers.ctrl || (usesMod && !isMacPlatform());

    // Strict match on meta/ctrl/alt — a stray ⌘ or Ctrl must not hijack
    // an unmodified shortcut (e.g. "k" while Cmd is held should NOT fire).
    if (event.metaKey !== expectMeta) return false;
    if (event.ctrlKey !== expectCtrl) return false;
    if (event.altKey !== modifiers.alt) return false;
    // Loose match on shift — "?" is Shift+/ on a US layout. Only require
    // shift when the author explicitly asked for it.
    if (modifiers.shift && !event.shiftKey) return false;

    // Letters and digits match the PHYSICAL key; everything else matches what
    // the layout produced. See `physicalCodeFor`.
    const physical = physicalCodeFor(key);
    if (physical) {
        // `event.code` is absent on synthetic events that predate this change
        // and in some older test fixtures. Falling back to `event.key` keeps
        // those working rather than silently matching nothing — a shortcut that
        // stops firing is the failure this whole change is about.
        if (event.code) return event.code === physical;
    }

    const eventKey = (event.key ?? '').toLowerCase();
    return eventKey === key;
}

// Exposed so the public hook can format a pressed event back into
// our canonical notation (useful for telemetry + the palette).
export function describePressedKey(event: KeyboardEvent): string {
    const parts: string[] = [];
    if (event.metaKey) parts.push('meta');
    if (event.ctrlKey) parts.push('ctrl');
    if (event.altKey) parts.push('alt');
    if (event.shiftKey) parts.push('shift');
    parts.push((event.key ?? '').toLowerCase());
    return parts.join('+');
}
