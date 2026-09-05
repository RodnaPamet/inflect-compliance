/**
 * AI Guard — deterministic input normalization.
 *
 * Attackers hide prompt-injection / exfil directives behind encoding and
 * unicode tricks so a naive substring match never sees them. Before the
 * pattern scanners (`injection-scanner.ts` / `egress-scanner.ts`) run, we
 * fold the text through six deterministic, pure passes so an obfuscated
 * payload collapses to the same canonical form a human would read:
 *
 *   1. Unicode NFKC normalization + homoglyph fold (Cyrillic / Greek / full-
 *      width look-alikes → ASCII) — defeats "іgnore previоus" style evasion.
 *   2. base64 decode of embedded blobs — a base64 chunk that decodes to
 *      printable text is appended so `aWdub3JlIGFsbA==` is scanned as
 *      "ignore all".
 *   3. hex decode of embedded `\x`/`0x`/bare hex runs — same idea for hex.
 *   4. zero-width / bidi control strip — removes U+200B..U+200F, U+2060,
 *      U+FEFF, etc. that split a keyword mid-token.
 *   5. whitespace collapse — runs of whitespace (incl. newlines/tabs) →
 *      single space so `ignore\n\n\tall` matches.
 *   6. case fold — lower-case for case-insensitive matching.
 *
 * The function is pure + deterministic (no I/O, no clock, no randomness) so
 * it is exhaustively unit-testable and safe to run on every AI-ingestion
 * path. It returns the FOLDED string; the scanners match against it. The
 * RAW text is never logged.
 */

// U+00AD SOFT HYPHEN, U+200B..U+200F, U+2060 WORD JOINER, U+FEFF BOM, and the
// bidi controls U+202A..U+202E / U+2066..U+2069. Built via the RegExp
// constructor from \u escapes so the source file carries no invisible chars.
const ZERO_WIDTH_RE = new RegExp(
    '[\\u00AD\\u200B-\\u200F\\u202A-\\u202E\\u2060\\u2066-\\u2069\\uFEFF]',
    'g',
);

// Homoglyph fold table — the common Cyrillic / Greek look-alikes used to
// smuggle Latin keywords past a literal match. Deliberately small: only the
// letters that appear in the injection/egress keyword set. Full-width ASCII
// is handled generically in foldHomoglyphs().
const HOMOGLYPHS: Record<string, string> = {
    // Cyrillic
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c',
    'х': 'x', 'у': 'y', 'ѕ': 's', 'і': 'i', 'ј': 'j',
    'һ': 'h', 'к': 'k', 'м': 'm', 'т': 't', 'в': 'b',
    // Greek
    'α': 'a', 'ο': 'o', 'ε': 'e', 'ρ': 'p', 'τ': 't',
    'ν': 'v', 'ι': 'i', 'κ': 'k', 'υ': 'u',
};

function foldHomoglyphs(input: string): string {
    let out = '';
    for (const ch of input) {
        const code = ch.codePointAt(0) ?? 0;
        // Full-width Latin/ASCII block (U+FF01..U+FF5E) → ASCII.
        if (code >= 0xff01 && code <= 0xff5e) {
            out += String.fromCharCode(code - 0xfee0);
            continue;
        }
        out += HOMOGLYPHS[ch] ?? ch;
    }
    return out;
}

/** True when a decoded buffer is "mostly printable text" worth re-scanning. */
function looksPrintable(s: string): boolean {
    if (s.length < 4) return false;
    let printable = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126)) printable++;
    }
    return printable / s.length > 0.85;
}

/**
 * Decode embedded base64 blobs and APPEND their printable decodings so the
 * scanner sees the plaintext. We append rather than replace so a partially
 * base64 payload still keeps its literal parts.
 */
function decodeBase64Blobs(input: string): string {
    const appended: string[] = [];
    const re = /[A-Za-z0-9+/]{16,}={0,2}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
        const blob = m[0];
        // A valid base64 payload length (minus padding) is never ≡ 1 (mod 4).
        if (blob.replace(/=+$/, '').length % 4 === 1) continue;
        try {
            const decoded = Buffer.from(blob, 'base64').toString('utf8');
            if (looksPrintable(decoded)) appended.push(decoded);
        } catch {
            // not valid base64 — ignore
        }
    }
    return appended.length ? `${input} ${appended.join(' ')}` : input;
}

/**
 * Decode embedded hex runs (`\x69\x67…`, `0x6967…`, or bare even-length hex
 * runs ≥ 8 chars) and append their printable decodings.
 */
function decodeHexBlobs(input: string): string {
    const appended: string[] = [];

    // \xHH or 0xHH escape sequences.
    const escaped = input.match(/(?:\\x|0x)[0-9a-fA-F]{2}(?:[\s,]*(?:\\x|0x)?[0-9a-fA-F]{2})*/g);
    if (escaped) {
        for (const run of escaped) {
            const bytes = run.match(/[0-9a-fA-F]{2}/g);
            if (!bytes || bytes.length < 3) continue;
            const decoded = bytes.map((b) => String.fromCharCode(parseInt(b, 16))).join('');
            if (looksPrintable(decoded)) appended.push(decoded);
        }
    }

    // Bare even-length hex runs.
    const bare = input.match(/\b[0-9a-fA-F]{8,}\b/g);
    if (bare) {
        for (const run of bare) {
            if (run.length % 2 !== 0) continue;
            const bytes = run.match(/[0-9a-fA-F]{2}/g);
            if (!bytes) continue;
            const decoded = bytes.map((b) => String.fromCharCode(parseInt(b, 16))).join('');
            if (looksPrintable(decoded)) appended.push(decoded);
        }
    }

    return appended.length ? `${input} ${appended.join(' ')}` : input;
}

/**
 * Fold untrusted text into its canonical, deobfuscated form for pattern
 * matching. Deterministic + pure. Returns the folded string only — the raw
 * input is never persisted or logged by this module.
 */
export function normalizeForScan(input: string): string {
    if (!input) return '';
    // (2)/(3) decode BEFORE stripping so an encoded blob's plaintext is added.
    let out = input;
    out = decodeBase64Blobs(out);
    out = decodeHexBlobs(out);
    // (1) unicode NFKC + homoglyph fold.
    out = out.normalize('NFKC');
    out = foldHomoglyphs(out);
    // (4) zero-width / bidi strip.
    out = out.replace(ZERO_WIDTH_RE, '');
    // (5) whitespace collapse — but NEWLINES SURVIVE.
    //
    // This collapsed `\s+` to a single space, which erased every newline before
    // any rule ran. Several rules are anchored to a line start (`(?:^|[\n>])`
    // in `inj.system_role.declared`, for one), so after the collapse they could
    // only ever match at position 0 of the scanned text. A `System:` line in the
    // middle of a description was unreachable — the rule was live in the table
    // and dead in practice.
    //
    // Horizontal runs still collapse to one space; a newline plus any
    // surrounding blank space collapses to a single newline. So the flattening
    // that made the rules robust is kept, and the one structural feature they
    // are written against is kept too.
    out = out.replace(/[^\S\n]+/g, ' ').replace(/ ?\n[\s]*/g, '\n').trim();
    // (6) case fold.
    out = out.toLowerCase();
    return out;
}
