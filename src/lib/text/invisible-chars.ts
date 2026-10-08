/**
 * Invisible-character stripping, shared by the AI Guard and identity reconciliation.
 *
 * ‾‾‾ WHY THIS IS SHARED AND THE REST OF THAT MODULE IS NOT ‾‾‾
 *
 * It was a private constant in `src/app-layer/ai/guard/normalize.ts`. Identity
 * reconciliation needs exactly this one step of that module and MUST NOT have the
 * others, so the step moved here rather than the caller reaching across:
 *
 *   - `foldHomoglyphs` maps Cyrillic `в` to `b` and `р` to `p`. That is right for
 *     catching `іgnore previоus` smuggled past a literal match, and it DESTROYS
 *     real names: `Иванов` becomes `Иbaнob`, which is neither the name nor a
 *     transliteration of it. Reconciliation transliterates instead, and records
 *     which scheme produced each variant.
 *   - `decodeBase64Blobs` / `decodeHexBlobs` APPEND decoded payloads to the text.
 *     A normaliser that can lengthen its input is unusable as a matching key.
 *
 * So this file is deliberately one concern. Importing more of the guard's
 * normaliser into the identity path would be the defect, not a convenience.
 *
 * ‾‾‾ WHAT IS STRIPPED ‾‾‾
 *
 * U+00AD SOFT HYPHEN, U+200B..U+200F, U+2060 WORD JOINER, U+FEFF BOM, and the bidi
 * controls U+202A..U+202E / U+2066..U+2069. Characters that are invisible on screen
 * and so can make two different strings present identically — to a scanner looking
 * for a keyword, and to a person deciding whether two accounts are one human.
 *
 * Built through the `RegExp` constructor from `\u` escapes so this source file
 * carries no invisible characters of its own. That is not fastidiousness: a literal
 * U+2028 inside a regex literal is a line terminator and makes the literal
 * unterminated, and a literal zero-width space in a character class is impossible
 * to review in a diff.
 */

/** The invisible characters both callers remove. Global; callers own `lastIndex`. */
const INVISIBLE_RE = new RegExp('[\u00AD\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]', 'g');

/**
 * Remove invisible characters. Byte-identical to the private constant this
 * replaced, which `tests/unit/invisible-chars-extraction.test.ts` pins.
 */
export function stripInvisible(input: string): string {
    return input.replace(INVISIBLE_RE, '');
}

/** Whether a string carries any of them. Reconciliation refuses rather than strips. */
export function hasInvisible(input: string): boolean {
    // A fresh regex: the shared one is global, and `test` on a global regex
    // advances `lastIndex`, so consecutive calls on the same input disagree.
    return new RegExp('[\u00AD\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]').test(input);
}
