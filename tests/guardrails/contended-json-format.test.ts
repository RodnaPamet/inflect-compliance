/**
 * Contended JSON files keep their own serialisation format (#3290).
 *
 * THE DEFECT
 * ──────────
 * Several JSON files are edited by multiple branches at once and each has its
 * own format, with nothing asserting it. A writer that guesses — a conflict
 * resolver's default indent, a `json.dumps` kwarg, a formatter-on-save —
 * rewrites the whole file while the intended change is one line. The merge is
 * CLEAN, nothing is flagged, and every branch behind it now conflicts on lines
 * nobody meant to touch.
 *
 * Three incidents in one day, all caught by a habit rather than a control:
 *
 *   1. `ci-checks-unreachable-before-merge.json` — adding ONE registry entry
 *      with `json.dumps(..., sort_keys=True)` gave 35 insertions / 30 deletions,
 *      because `sort_keys` also reorders each entry's inner keys. Caught only by
 *      checking the diff was purely additive; redone as +5/-0.
 *   2. `doc-classification.json` — a resolver defaulted to 2-space against the
 *      file's 4 and turned a 3-line change into a whole-file rewrite, on a file
 *      THREE branches were editing. It would have merged cleanly.
 *   3. `messages/en.json` + `bg.json` — caught pre-commit by reading
 *      `git diff --numstat`, specifically because of incident 2.
 *
 * "Look at the diffstat before committing" is a habit, not a control. This is
 * the control.
 *
 * WHY ROUND-TRIP AND NOT "PARSES AS JSON"
 * ───────────────────────────────────────
 * Every one of these files parses fine in every format. Parseability is exactly
 * what makes the corruption invisible, so the assertion has to be that
 * `serialise(parse(raw)) === raw` BYTE FOR BYTE under the file's own declared
 * format — which also documents that format where a writer will look for it.
 *
 * MEASURED: there is no convention to converge on
 * ──────────────────────────────────────────────
 *   ci-checks-unreachable-before-merge.json   indent 4   ASCII-escaped
 *   doc-classification.json                   indent 4   non-ASCII literal
 *   messages/en.json                          indent 2   non-ASCII literal
 *   messages/bg.json                          indent 2   non-ASCII literal
 *   ui-core-classification.json               indent 1   MIXED — see EXEMPT
 *
 * Four distinct formats, each undiscoverable without measuring the file first.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

interface Format {
    readonly indent: number;
    /** true = non-ASCII is `\uXXXX`-escaped, as Python's `ensure_ascii=True`. */
    readonly escapeNonAscii: boolean;
    readonly trailingNewline: boolean;
    /**
     * sha256 of every key in document order, which the round-trip CANNOT see.
     *
     * A MUTATION RUN FOUND THIS GAP, and it is the gap that matters: re-writing
     * the registry with `sort_keys=True` changes 32 lines on disk — reordering
     * each entry's inner keys from `kind/reason/coveredBy` to
     * `coveredBy/kind/reason` — and the round-trip still PASSED, because
     * `JSON.parse` -> `JSON.stringify` reproduces whatever order is on disk.
     *
     * So the format check alone would have missed INCIDENT 1, the one that
     * motivated this guard. A digest is one line per file instead of thousands
     * of key names, and any reorder changes it.
     */
    /**
     * OPTIONAL, and the omissions are deliberate — see `messages/*.json` below.
     *
     * Only declare it where key order is an INVARIANT. A file that legitimately
     * gains keys on most PRs has no stable key order, so a digest there fails on
     * every honest addition and trains people to update the hash reflexively,
     * which destroys the signal it exists to carry.
     */
    readonly keyOrderSha?: string;
}

const GOVERNED: Readonly<Record<string, Format>> = {
    'tests/guardrails/ci-checks-unreachable-before-merge.json': {
        indent: 4,
        escapeNonAscii: true,
        trailingNewline: true,
        keyOrderSha: '072de24b0f85b7a8f1f251cef2be8df8619b0cc5d3dcb0934af80bec9e0040c4',
    },
    'docs/_status/doc-classification.json': {
        indent: 4,
        escapeNonAscii: false,
        trailingNewline: true,
        keyOrderSha: '31b3ab9eed4b779dd8b5e968f2146eb9e40d69f2c979e43195c9506d51b4e2c4',
    },
    // NO keyOrderSha for the two catalogues, deliberately. They gain keys on
    // essentially every i18n PR — #3289 added eighteen while this guard was in
    // CI, which is how the omission got measured rather than guessed. A digest
    // here would fail on every honest addition, so every i18n PR would carry two
    // hash updates and people would start updating them without reading, which
    // is worse than no check.
    //
    // The FORMAT check still applies and is the hazard that matters for these:
    // a resolver re-indenting a 5,000-key catalogue is the rewrite that makes
    // every concurrent i18n branch conflict. Key ORDER here is not an invariant;
    // indent and escaping are.
    'messages/en.json': { indent: 2, escapeNonAscii: false, trailingNewline: true },
    'messages/bg.json': { indent: 2, escapeNonAscii: false, trailingNewline: true },
};

/**
 * Files that cannot be governed, with the measurement that says why.
 *
 * `ui-core-classification.json` is MIXED-ENCODING: literal non-ASCII for its
 * first ~34,000 characters and `\uXXXX` escapes after that. Measured, the first
 * divergence is at character 34,064 — the file has `—` where any uniform
 * serialiser emits a literal em-dash. NO single (indent, escapeNonAscii) pair
 * reproduces it, so ANY programmatic rewrite of that file is lossy by
 * construction.
 *
 * Listed rather than silently omitted: leaving the worst file out of the table
 * with no record would be the same invisible gap this guard exists to close.
 * Normalising it means one deliberate commit whose diff is enormous ON PURPOSE
 * and contains nothing else — at which point delete this entry and govern it.
 */
const EXEMPT: Readonly<Record<string, string>> = {
    'docs/_status/ui-core-classification.json':
        'mixed encoding: literal non-ASCII before char ~34064, \\uXXXX escapes after. ' +
        'No uniform serialiser round-trips it; normalise in a dedicated commit first.',
};

function escapeNonAsciiChars(s: string): string {
    let out = '';
    for (const ch of s) {
        const cp = ch.codePointAt(0) ?? 0;
        out += cp > 127 ? `\\u${cp.toString(16).padStart(4, '0')}` : ch;
    }
    return out;
}

/**
 * The serialisation half of a `Format`. `keyOrderSha` is a RECORDED FACT about
 * the file, not an input to writing it, so asking for it here would force the
 * exemption probe below to invent a digest it has no use for.
 */
type Serialisation = Omit<Format, 'keyOrderSha'>;

function serialise(parsed: unknown, fmt: Serialisation): string {
    let out = JSON.stringify(parsed, null, fmt.indent);
    if (fmt.escapeNonAscii) out = escapeNonAsciiChars(out);
    return fmt.trailingNewline ? `${out}\n` : out;
}

/**
 * Every key in document order, depth-first, as one newline-joined string.
 *
 * Arrays contribute their index so a reordered array of objects is visible too.
 */
function keyOrder(value: unknown, prefix = ''): string[] {
    if (Array.isArray(value)) {
        return value.flatMap((v, i) => keyOrder(v, `${prefix}[${i}]`));
    }
    if (value !== null && typeof value === 'object') {
        return Object.keys(value as Record<string, unknown>).flatMap((k) => [
            `${prefix}.${k}`,
            ...keyOrder((value as Record<string, unknown>)[k], `${prefix}.${k}`),
        ]);
    }
    return [];
}

function keyOrderSha(parsed: unknown): string {
    return createHash('sha256').update(keyOrder(parsed).join('\n')).digest('hex');
}

/** First differing character index, or -1. */
function firstDiff(a: string, b: string): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : n;
}

describe('#3290 — contended JSON files round-trip byte-identically', () => {
    it('the table is non-trivial and every entry names a file that exists', () => {
        // Denominator beside the result: a table that lost its entries, or whose
        // paths rotted, would pass every assertion below over nothing.
        expect(Object.keys(GOVERNED).length).toBeGreaterThanOrEqual(4);
        // The digest is opt-in, so it could silently become opt-out-of-entirely.
        // At least one file must carry one, or the key-order half of this guard
        // governs nothing while still reading as present.
        const withDigest = Object.values(GOVERNED).filter((f) => f.keyOrderSha !== undefined);
        expect(withDigest.length).toBeGreaterThanOrEqual(2);
        for (const rel of [...Object.keys(GOVERNED), ...Object.keys(EXEMPT)]) {
            expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
        }
    });

    it.each(Object.keys(GOVERNED))('%s round-trips byte-identically', (rel) => {
        const fmt = GOVERNED[rel] as Format;
        const abs = path.join(ROOT, rel);
        const raw = fs.readFileSync(abs, 'utf-8');
        const ours = serialise(JSON.parse(raw), fmt);
        if (raw !== ours) {
            const i = firstDiff(raw, ours);
            throw new Error(
                `${rel} is not in its declared format ` +
                    `(indent ${fmt.indent}, ${fmt.escapeNonAscii ? 'ASCII-escaped' : 'non-ASCII literal'}).\n\n` +
                    `  first difference at character ${i} of ${raw.length}\n` +
                    `    on disk: ${JSON.stringify(raw.slice(i, i + 40))}\n` +
                    `    declared: ${JSON.stringify(ours.slice(i, i + 40))}\n\n` +
                    `Something rewrote this file in a different format — a conflict\n` +
                    `resolver's default indent, a formatter-on-save, or a serialiser\n` +
                    `kwarg such as \`sort_keys\`. The file still PARSES, which is why\n` +
                    `nothing else caught it, and every branch editing it now conflicts\n` +
                    `on lines nobody meant to touch.\n\n` +
                    `Re-serialise it in the declared format, or — if the format was\n` +
                    `changed deliberately — update this table in the same diff.`,
            );
        }

        // THE HALF THE ROUND-TRIP IS BLIND TO. Reordering keys leaves the
        // serialisation self-consistent, so only a recorded digest catches it.
        if (fmt.keyOrderSha === undefined) return;
        const sha = keyOrderSha(JSON.parse(raw));
        if (sha !== fmt.keyOrderSha) {
            throw new Error(
                `${rel} has the right FORMAT but its KEY ORDER changed.\n\n` +
                    `  recorded: ${fmt.keyOrderSha}\n` +
                    `  on disk:  ${sha}\n\n` +
                    `The round-trip check cannot see this — \`JSON.parse\` then\n` +
                    `\`JSON.stringify\` reproduces whatever order is on disk, so a\n` +
                    `reordered file is still self-consistent. This is the shape of a\n` +
                    `\`sort_keys=True\` rewrite: on the registry it changes 32 lines\n` +
                    `while every other check stays green.\n\n` +
                    `If keys were reordered deliberately, update the digest in the\n` +
                    `same diff. If not, restore the original order — a reorder makes\n` +
                    `every concurrent branch conflict on lines nobody edited.`,
            );
        }
    });

    it('every EXEMPT file is still genuinely un-round-trippable', () => {
        // A stale exemption is worse than none: it reads as considered and
        // governs nothing. If someone normalises the file, this fails and says
        // to delete the entry — the same no-stale discipline the ratchets use.
        for (const [rel, reason] of Object.entries(EXEMPT)) {
            const raw = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
            const parsed = JSON.parse(raw);
            const anyMatches = [1, 2, 4]
                .flatMap((indent) => [true, false].map((esc) => ({ indent, esc })))
                .some(
                    ({ indent, esc }) =>
                        serialise(parsed, {
                            indent,
                            escapeNonAscii: esc,
                            trailingNewline: true,
                        }) === raw ||
                        serialise(parsed, {
                            indent,
                            escapeNonAscii: esc,
                            trailingNewline: false,
                        }) === raw,
                );
            if (anyMatches) {
                throw new Error(
                    `${rel} is EXEMPT but now round-trips under a uniform format.\n` +
                        `Recorded reason: ${reason}\n\n` +
                        `It was normalised. Delete its EXEMPT entry and add it to\n` +
                        `GOVERNED with the format that matches, in this same diff.`,
                );
            }
        }
    });
});
