/**
 * The rules of the harness report contract that need no hashing (#3726): the
 * contract ids, whether a value has the shape of a secret, and whether a scan
 * was complete.
 *
 * They live apart from `harness-contract.ts` because the findings planner
 * (`harness-findings.ts`) needs them, and a client component reaches the
 * planner through `harness-acceptance-rules.ts`. The contract verifies
 * signatures with `crypto`, so importing these from it shipped the
 * crypto-browserify polyfill to the agents reports page. `harness-contract.ts`
 * re-exports all of them, and the ingest, the scanner and the tests may import
 * them from either module.
 *
 * Keep this module free of Node built-ins: a client reaches it.
 * `tests/guards/client-reachable-modules-import-no-node-builtins.test.ts`
 * fails if it, or anything it imports, gains one.
 */

/**
 * The first contract (#3660), RETIRED at the scanner container's release
 * (#3686, owner decision 2026-10-19): the verifier refuses a report that names
 * it (`SCHEMA`) and writes nothing. No scanner but the reference one ever spoke
 * it, and that one speaks `/2`. Kept only so the refusal can say why.
 */
export const HARNESS_CONTRACT_V1 = 'inflect-agent-harness/1';

/**
 * `/1` plus the `code` source kind, the `UNPARSEABLE` reason and the
 * `unboundCredentials[]` member (#3754, owner decision 2026-10-19). Accepted
 * beside `/3`.
 */
export const HARNESS_CONTRACT_V2 = 'inflect-agent-harness/2';

/**
 * `/2` plus the `gcp-sa` source kind, a Google Cloud project's service
 * accounts (#3785, owner decision 2026-10-19), and nothing else. A new id
 * rather than a widened `/2`, because the source kinds are a closed list on the
 * wire: a `/2` verifier refuses a report naming `gcp-sa`, and a `/2` report
 * that names it is still refused here. What the reference scanner speaks.
 */
export const HARNESS_CONTRACT_V3 = 'inflect-agent-harness/3';

/** Every id the verifier accepts. `/1` is retired and is not among them. */
export const HARNESS_CONTRACT_IDS = [HARNESS_CONTRACT_V2, HARNESS_CONTRACT_V3] as const;
export type HarnessContractId = (typeof HARNESS_CONTRACT_IDS)[number];

/**
 * Where a scanner looks. Stable ids: the report and the matrix carry them. The
 * last, `code` (agent definitions read from source code and configuration,
 * #3737), is the one `/2` added; the rest were `/1`'s.
 */
export const SOURCE_KINDS_V2 = [
    'entra-sp',
    'okta-app',
    'vault',
    'mcp',
    'runtime',
    'cicd',
    'inflect-register',
    'code',
] as const;

/** `/3`'s kinds: `/2`'s, and `gcp-sa`, a Google Cloud project's service accounts (#3785). */
export const SOURCE_KINDS_V3 = [...SOURCE_KINDS_V2, 'gcp-sa'] as const;

/**
 * Every source kind a report this verifier accepts can carry, which is also
 * every kind a stored scan can hold, `/1` and `/2` scans included. Stored scans
 * are re-read against it, and an estate may declare exactly these (the
 * database CHECKs the same list). Here rather than in the contract so the
 * estate form, a client component, can offer the same list (#3807).
 */
export const SOURCE_KINDS = SOURCE_KINDS_V3;

/**
 * Shapes that are a secret wherever they appear, including inside something
 * that otherwise looks like a reference. Deliberately short: a false refusal
 * names itself and costs a scanner fix; a false acceptance puts a credential in
 * a tenant's database.
 */
const SECRET_SHAPES: readonly RegExp[] = [
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
    /AKIA[0-9A-Z]{16}/,
    /xox[abpors]-[A-Za-z0-9-]{10,}/,
    /sk-[A-Za-z0-9]{20,}/,
    // Anthropic's keys, which the line above misses at the hyphen after `sk-ant`
    // (#4156): the credential an Agent SDK agent is most likely to carry.
    /sk-ant-[A-Za-z0-9_-]{20,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
    // A URL carrying a password in its userinfo: `scheme://user:password@host`.
    // The authority ends at the first `/`, `?`, `#` or `\`, so an `@` or a `:`
    // further along — `kv://prod/agents:reporting@v2` — is a locator, not a
    // credential. The username may itself hold an `@` (an e-mail address); the
    // password is everything after its first `:` up to the LAST `@`. A username
    // alone (`ssh://git@host`) is not matched: it is not a secret, and a token
    // used AS the username is caught by its own shape above. The match starts
    // at the literal `://` — whatever the scheme, or none — which keeps the scan
    // linear: a leading scheme class would be retried at every offset.
    /:\/\/[^/?#\\\s:]*:[^/?#\\\s]*[^/?#\\\s@]@/,
];

export function looksLikeSecret(value: string): boolean {
    return SECRET_SHAPES.some((re) => re.test(value)) || containsCardNumber(value);
}

// ─── The PCI line (D-L1-8, adopted 2026-11-11) ──────────────────────────────
//
// Inflect never stores, processes or transmits a card number (a PAN, or a
// network token such as a Mastercard Agentic Token, which has a PAN's shape).
// That keeps the product outside PCI DSS cardholder-data scope, and the line is
// held here, by a refusal in code, rather than by a sentence in a policy. Every
// caller of `looksLikeSecret` refuses one: the harness contract's credential
// and endpoint references, the ingest's walk over every string in a report
// (`firstSecretShapedMember`), the IAM skills' evidence references, and the
// spending-authority writer Phase 1 of
// `docs/ai-architecture/mastercard-agent-pay.md` adds.
//
// A card number is a run of 13 to 19 digits that passes the Luhn check and
// whose first digit is a payment-card major industry identifier (ISO/IEC
// 7812-1: 2 to 6). Two ways of writing one are recognised:
//
//   • CONTIGUOUS: `5555555555554444`.
//   • GROUPED as cards are printed, with ONE separator kind (a space or a
//     hyphen) used throughout: 4-4-4-1..4 and 4-4-4-1..4-1..3, and the
//     4-6-5 / 4-6-4 groupings of American Express and Diners Club.
//
// The value is read as TOKENS, maximal runs of ASCII letters and digits, and
// only an all-digit token is a candidate or a group. So:
//
//   • A digit run joined to a letter is never a card. A hex digest
//     (`sha256:…`, a commit SHA, a UUID's groups) holds decimal runs between
//     its letters; read as bare digit runs, about one `sha256:` digest in 460
//     and one UUID in 9,000 carried a 13-digit Luhn-valid run starting 2–6, and
//     every report carries a manifest hash per tool. As tokens, a digest is one
//     token with letters in it. The cost is a PAN glued to a word
//     (`card5555…`); a PAN after `_`, `-`, `/`, `=` or a space is still found.
//   • A grouped card may sit anywhere in a longer run of groups, and is found
//     there: followed by its expiry or CVV (`5555 5555 5555 4444 12/30`),
//     beside a second card, after an order number. Each start and each grouping
//     is tried, so a printed card is never hidden by what is printed next to
//     it. The cost: four space-separated 4-digit numbers that happen to pass
//     Luhn and start 2–6 are refused, and so may be an IBAN printed in groups,
//     which is personal data (D-L1-1) with no place in a report either.
//
// What else keeps ordinary numbers out, each a measured choice:
//
//   • The first digit. A millisecond timestamp, a Snowflake id and a
//     microsecond clock all start with 1 today, and 10% of any digit run passes
//     Luhn, so without it one id in ten in a report would be refused. The cost
//     is MII 7, 8 and 9 (fleet cards, RuPay's 81/82 range, national schemes),
//     which are outside every network Agent Pay and AP4M use.
//   • The length. A token outside 13 to 19 digits (a 21-digit GCP unique id)
//     is not a card, and no card is looked for inside it.
//   • The neighbours. A candidate after a `+` (an E.164 phone number), or
//     beside a decimal point (an amount or a float), is not a card.
//   • The grouping. A phone number, a date range or a GUID written with
//     spaces or hyphens does not fall into card groups.
//
// A false refusal names the member and costs a scanner fix; a false acceptance
// puts cardholder data in a tenant's database and Inflect inside PCI scope.

/** A candidate's digits pass the Luhn (mod 10) check. */
export function passesLuhn(digits: string): boolean {
    if (!/^\d+$/.test(digits)) return false;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
        let d = digits.charCodeAt(digits.length - 1 - i) - 48;
        if (i % 2 === 1) {
            d *= 2;
            if (d > 9) d -= 9;
        }
        sum += d;
    }
    return sum % 10 === 0;
}

interface CardToken {
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly allDigits: boolean;
}

/** Maximal runs of ASCII letters and digits, in order. */
function cardTokens(value: string): CardToken[] {
    const out: CardToken[] = [];
    const re = /[A-Za-z0-9]+/g;
    for (let m = re.exec(value); m !== null; m = re.exec(value)) {
        out.push({ text: m[0], start: m.index, end: m.index + m[0].length, allDigits: /^\d+$/.test(m[0]) });
    }
    return out;
}

/** Group lengths, as [min, max] per group, of each printed card grouping. */
const CARD_GROUPINGS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
    // 4-4-4 then one or two shorter-or-equal groups: 13 to 19 digits.
    [[4, 4], [4, 4], [4, 4], [1, 4]],
    [[4, 4], [4, 4], [4, 4], [1, 4], [1, 3]],
    // American Express 4-6-5, Diners Club 4-6-4.
    [[4, 4], [6, 6], [4, 5]],
];

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';

/** Not after a `+` (a phone number), nor after a digit and a decimal point. */
function leadIsClear(value: string, at: number): boolean {
    const before = value[at - 1];
    if (before === '+') return false;
    return !(before === '.' && isDigit(value[at - 2]));
}

/** Not before a decimal point and a digit (an amount or a float). */
function tailIsClear(value: string, at: number): boolean {
    return !(value[at] === '.' && isDigit(value[at + 1]));
}

function isCard(digits: string): boolean {
    return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits);
}

/** Does a printed grouping of a card start at token `i`? */
function groupedCardAt(value: string, tokens: readonly CardToken[], i: number): boolean {
    for (const grouping of CARD_GROUPINGS) {
        if (i + grouping.length > tokens.length) continue;
        let separator: string | undefined;
        let digits = '';
        let fits = true;
        for (let g = 0; g < grouping.length && fits; g++) {
            const token = tokens[i + g];
            const [min, max] = grouping[g];
            fits = token.allDigits && token.text.length >= min && token.text.length <= max;
            if (fits && g > 0) {
                const prev = tokens[i + g - 1];
                const gap = value.slice(prev.end, token.start);
                fits = (gap === ' ' || gap === '-') && (separator === undefined || gap === separator);
                separator = gap;
            }
            digits += token.text;
        }
        if (fits && tailIsClear(value, tokens[i + grouping.length - 1].end) && isCard(digits)) return true;
    }
    return false;
}

/**
 * Does the value contain a card number (D-L1-8)? Pure and linear; reports
 * only yes or no, so no caller can echo the number it found.
 */
export function containsCardNumber(value: string): boolean {
    const tokens = cardTokens(value);
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token.allDigits || token.text[0] < '2' || token.text[0] > '6') continue;
        if (!leadIsClear(value, token.start)) continue;
        if (tailIsClear(value, token.end) && isCard(token.text)) return true;
        if (groupedCardAt(value, tokens, i)) return true;
    }
    return false;
}

/**
 * Is the scan complete? Derived from its sources, never declared. Zero sources
 * is not complete: a scan that looked nowhere evidences nothing.
 */
export function isScanComplete(body: {
    readonly population: { readonly sources: ReadonlyArray<{ readonly status: string }> };
}): boolean {
    return body.population.sources.length > 0 && body.population.sources.every((s) => s.status === 'COMPLETE');
}
