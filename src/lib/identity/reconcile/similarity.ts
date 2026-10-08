/**
 * Two string-similarity measures, implemented here rather than taken from a
 * package.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY IN-HOUSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Not invented-here: these feed an identity decision, and three properties matter
 * more than the twenty lines they save.
 *
 *   1. **The numbers must be pinned to published reference values.** Jaro-Winkler
 *      has well-known triples — `MARTHA`/`MARHTA` 0.961, `DWAYNE`/`DUANE` 0.84,
 *      `DIXON`/`DICKSONX` 0.813 — and the tests assert them. A dependency that
 *      changed its prefix scale or its match window in a patch release would move
 *      every threshold derived from it, silently, in a lockfile bump.
 *   2. **No new egress-capable dependency on the identity path.** A string-metric
 *      package is a small supply-chain surface for a function that is forty lines.
 *   3. **It must be total.** Empty strings, one-character strings and strings of
 *      different scripts all have defined answers here, because the inputs are
 *      legacy display names and some of them are a single character.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NEITHER CAN LINK, AND THAT IS THE POINT OF HAVING THEM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Similarity is the weakest evidence in the system. `Jon Smith` and `Jan Smith`
 * score 0.97 and are different people; `Bob` and `Robert` score 0.5 and are the
 * same one. So these numbers only ever ORDER the candidates a reviewer sees —
 * they are emitted as `SIMILARITY`, a supporting kind the engine's types will not
 * let reach `LINKED`.
 *
 * @module lib/identity/reconcile/similarity
 */

import { baseClean, translitVariants } from './normalise';

/** Winkler's prefix scale, and the prefix length it applies over. */
export const WINKLER_PREFIX_SCALE = 0.1;
export const WINKLER_MAX_PREFIX = 4;

/**
 * Jaro similarity: the share of characters that match, adjusted for how many of
 * the matches are out of order.
 *
 * The match window — `floor(max(len) / 2) - 1` — is what makes it tolerant of
 * nearby transpositions but not of distant coincidence.
 */
export function jaro(a: string, b: string): number {
    if (a === b) return a.length === 0 ? 1 : 1;
    if (a.length === 0 || b.length === 0) return 0;

    const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const aMatched = new Array<boolean>(a.length).fill(false);
    const bMatched = new Array<boolean>(b.length).fill(false);

    let matches = 0;
    for (let i = 0; i < a.length; i++) {
        const lo = Math.max(0, i - window);
        const hi = Math.min(b.length - 1, i + window);
        for (let j = lo; j <= hi; j++) {
            if (bMatched[j] || a[i] !== b[j]) continue;
            aMatched[i] = true;
            bMatched[j] = true;
            matches += 1;
            break;
        }
    }
    if (matches === 0) return 0;

    // Transpositions: matched characters that appear in a different order.
    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < a.length; i++) {
        if (!aMatched[i]) continue;
        while (!bMatched[k]) k += 1;
        if (a[i] !== b[k]) transpositions += 1;
        k += 1;
    }

    const t = transpositions / 2;
    return (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
}

/**
 * Jaro-Winkler: Jaro, with a bonus for a shared prefix.
 *
 * The bonus exists because people mistype and abbreviate the END of a name far
 * more often than the beginning, so a shared prefix is better evidence than a
 * shared suffix of the same length.
 */
export function jaroWinkler(a: string, b: string): number {
    const j = jaro(a, b);
    let prefix = 0;
    const max = Math.min(WINKLER_MAX_PREFIX, a.length, b.length);
    while (prefix < max && a[prefix] === b[prefix]) prefix += 1;
    return j + prefix * WINKLER_PREFIX_SCALE * (1 - j);
}

/**
 * Token-set ratio: how much two names share once order and duplication stop
 * mattering.
 *
 * `|intersection| / |union|` over the token sets. It is the measure that gets
 * `Smith, John A.` and `John Smith` right, where Jaro-Winkler reads them as quite
 * different because it compares character runs in order.
 *
 * The two are kept separate rather than blended into one score. They fail in
 * different directions — Jaro-Winkler on reordering, token-set on typos — and a
 * blend hides which one carried a suggestion from the reviewer looking at it.
 */
export function tokenSetRatio(a: string, b: string): number {
    const tokens = (s: string): Set<string> =>
        new Set(
            baseClean(s)
                .toLowerCase()
                .split(/[^\p{L}\p{N}]+/u)
                .filter(Boolean)
        );
    const ta = tokens(a);
    const tb = tokens(b);
    if (ta.size === 0 || tb.size === 0) return 0;

    let shared = 0;
    for (const t of ta) if (tb.has(t)) shared += 1;
    const union = ta.size + tb.size - shared;
    return union === 0 ? 0 : shared / union;
}

export interface SimilarityScore {
    readonly jaroWinkler: number;
    readonly tokenSet: number;
    /** The higher of the two, which is what orders a candidate list. */
    readonly best: number;
    /** The romanisation scheme that produced `best`, when one did. */
    readonly scheme: string | null;
}

/**
 * Score two names, trying romanised forms when the direct comparison is weak.
 *
 * The scheme is recorded whenever a transliterated form beat the direct one, so a
 * reviewer can see that a suggestion rests on a romanisation rather than on the
 * names as written — which is exactly the kind of match a human should check.
 *
 * Variants are bounded by `translitVariants`, which caps them; this function does
 * not add its own cross product beyond the per-token one it already performs.
 */
export function scoreNames(a: string, b: string): SimilarityScore {
    const cleanA = baseClean(a).toLowerCase();
    const cleanB = baseClean(b).toLowerCase();

    const directJw = jaroWinkler(cleanA, cleanB);
    const directTs = tokenSetRatio(cleanA, cleanB);
    let best = Math.max(directJw, directTs);
    let scheme: string | null = null;

    // Romanise the side that is not already Latin, and re-score. Only worth doing
    // when the direct comparison is unconvincing — a strong direct match is not
    // improved by explaining it a second way.
    if (best < 0.95) {
        for (const va of translitVariants(cleanA)) {
            for (const vb of translitVariants(cleanB)) {
                if (va.scheme === 'none' && vb.scheme === 'none') continue;
                const score = Math.max(
                    jaroWinkler(va.value.toLowerCase(), vb.value.toLowerCase()),
                    tokenSetRatio(va.value, vb.value)
                );
                if (score > best) {
                    best = score;
                    scheme = va.scheme !== 'none' ? va.scheme : vb.scheme;
                }
            }
        }
    }

    return { jaroWinkler: directJw, tokenSet: directTs, best, scheme };
}
