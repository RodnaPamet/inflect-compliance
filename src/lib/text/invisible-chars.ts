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

/**
 * ‾‾‾ THE SYNC NORMALISER, AND WHY IT IS ONE FUNCTION (#3278) ‾‾‾
 *
 * Two sync write seams carried their own copy of this, and the copies had
 * DIFFERENT character classes — neither a superset of the other. Measured:
 *
 *   codepoint                 identity-sync    hris-sync
 *   U+00AD  SOFT HYPHEN       not stripped     stripped
 *   U+2028  LINE SEPARATOR    stripped         not stripped
 *   U+2061..U+2064 invisible  stripped         not stripped
 *   U+2066..U+2069 ISOLATES   not stripped     stripped
 *
 * The last row is the one that matters. `RLI`/`LRI`/`FSI` are the modern bidi
 * override mechanism and do to a rendered string exactly what `RLO`/`LRO` do —
 * so directory login names, the column the original issue held up as the
 * PROTECTED one, were the ones missing the current spelling of the attack.
 *
 * That is what a duplicated helper costs: not drift in a comment, divergence in
 * a security boundary, invisible in both diffs because each file looked
 * internally consistent. The class below is the UNION, and both seams delegate.
 *
 * ‾‾‾ WHAT IT DOES NOT DO ‾‾‾
 *
 * It does not fold, transliterate, or case-normalise. `legalName` is COMPARED,
 * not just displayed, and `employeeNumber` is a link-strength match signal: a
 * normaliser that changed a real value into a different real value would turn a
 * display concern into a wrong join. Stripping and capping only.
 *
 * Empty-after-stripping returns NULL, never `''`. A control-character-only
 * `employeeNumber` must clear the column rather than store a blank that reads as
 * a value — the rule the HRIS seam already carried and the one a shared helper
 * must not lose.
 *
 * Escapes go through the `RegExp` constructor, doubled, for the reason the
 * constant above gives: a literal U+2028 would terminate the expression, and a
 * literal zero-width space in a character class cannot be reviewed in a diff.
 */
const UNTRUSTED_SYNC_CONTROL = new RegExp(
    '[\\x00-\\x1F\\x7F-\\x9F\\u00AD\\u200B-\\u200F\\u2028\\u2029' +
        '\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]',
    'g',
);

/** The cap both seams used independently, kept identical. */
export const UNTRUSTED_SYNC_TEXT_MAX = 256;

/**
 * Normalise a string arriving from a customer-configured upstream — a directory
 * or an HRIS — for storage: strip control and invisible characters, trim, cap,
 * and return `null` rather than an empty string.
 */
export function normaliseUntrustedSyncText(
    value: string | null | undefined,
    max: number = UNTRUSTED_SYNC_TEXT_MAX,
): string | null {
    if (value == null) return null;
    const stripped = value.replace(UNTRUSTED_SYNC_CONTROL, '').trim();
    if (stripped === '') return null;
    return stripped.slice(0, max);
}
