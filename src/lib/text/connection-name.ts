/**
 * Which characters an integration connection's NAME may not contain (#5317).
 *
 * ‾‾‾ WHY ‾‾‾
 *
 * A connection's name is a label, and it travels: into the integrations page,
 * the audit trail, and an agent-recertification pack, which writes it through
 * `JSON.stringify`. JSON escapes a control character as `\u00XX`, six bytes for
 * one character, so a label made of them can push a preparation run past its
 * sealed-context cap. A lone surrogate is not text at all: it is half of a
 * character, and UTF-8 encoders turn it into U+FFFD or refuse it.
 *
 * Owner decision, 2026-11-15, recorded on #5317: SAVING a connection refuses a
 * name carrying any of them, with a 400. A label already stored is left alone —
 * no migration and no backfill — so an update that does not send the name
 * still succeeds.
 *
 * ‾‾‾ WHAT IS REFUSED ‾‾‾
 *
 *   C0 controls   U+0000..U+001F (tab and newline included: a name is one line)
 *   DEL           U+007F
 *   C1 controls   U+0080..U+009F
 *   a lone surrogate — a UTF-16 code unit in D800..DFFF that is not half of a
 *   valid high-then-low pair (a reversed pair is two lone halves).
 *
 * A valid surrogate pair — an emoji, any astral character — is one code point
 * above U+FFFF and passes. So do Cyrillic, accented Latin and every other
 * printable character.
 *
 * This module is pure and imports nothing, because the client form reads the
 * refusal code from it.
 */

/** The stable code a refused name answers with: the Zod issue message, and the usecase's `reason`. */
export const CONNECTION_NAME_INVALID_CHARACTERS = 'CONNECTION_NAME_INVALID_CHARACTERS' as const;

function isForbiddenCodePoint(cp: number): boolean {
    return (
        cp <= 0x1f || // C0
        (cp >= 0x7f && cp <= 0x9f) || // DEL + C1
        (cp >= 0xd800 && cp <= 0xdfff) // a surrogate standing alone
    );
}

/**
 * Whether a connection name carries a character it may not be saved with.
 *
 * Iterates by CODE POINT (`for…of` on a string): a valid pair arrives as one
 * code point above U+FFFF, and a surrogate arrives on its own only when it is
 * not part of one.
 */
export function connectionNameHasInvalidCharacters(name: string): boolean {
    for (const ch of name) {
        if (isForbiddenCodePoint(ch.codePointAt(0) as number)) return true;
    }
    return false;
}

/**
 * A connection name the SERVER builds from text it does not control (another
 * organisation's agent card, for one), made savable rather than refused: every
 * forbidden code point is dropped, the result is trimmed, and it is cut to at
 * most `max` UTF-16 units without splitting a pair.
 *
 * A plain `.slice(0, max)` is what this replaces where it is used: cutting
 * through an emoji leaves a lone high surrogate at the end, which the save
 * would then refuse.
 */
export function savableConnectionName(raw: string, max: number): string {
    let out = '';
    for (const ch of raw) {
        if (isForbiddenCodePoint(ch.codePointAt(0) as number)) continue;
        out += ch;
    }
    out = out.trim();
    if (out.length <= max) return out;
    let cut = '';
    for (const ch of out) {
        if (cut.length + ch.length > max) break;
        cut += ch;
    }
    return cut.trimEnd();
}
