/**
 * Deterministic, total normalisation for identity reconciliation.
 *
 * ‾‾‾ WHAT "TOTAL" MEANS HERE, AND WHY IT IS NOT DECORATION ‾‾‾
 *
 * Every function in this file returns a value for every input: empty, enormous,
 * control-character-laden, an unpaired surrogate. None throws. The inputs come from
 * an operator-hosted legacy database, so "that cannot happen" is not a property of
 * the data — and a throw here aborts a pull, which the design forbids: a row that
 * cannot be keyed must FAIL THE PULL with a named reason, never crash the sweep or
 * get silently dropped.
 *
 * Every input is length-capped before any regular expression sees it, and every
 * expression is linear by construction — no nested quantifier over a character
 * class that can also match the delimiter. A legacy display name is attacker-shaped
 * input and a quadratic matcher is a denial of service with extra steps.
 *
 * ‾‾‾ VARIANTS CARRY THEIR PROVENANCE ‾‾‾
 *
 * Normalisation does not return "the" normal form. It returns CANDIDATES, each
 * tagged with the scheme that produced it, because the HR system and the legacy
 * application were very likely filled in by different people using different
 * romanisations. A match found through a transliteration variant is `SUGGESTED` at
 * most and never `LINKED` — that rule lives in the engine (Step 3b), and this file
 * exists to make it checkable: a reviewer can be shown WHICH scheme produced the
 * candidate they are being asked to confirm.
 */
import { emailKey } from '@/lib/identity/email-key';
import { stripInvisible } from '@/lib/text/invisible-chars';

/** Caps. Refusal thresholds, not targets — see the header. */
export const NORMALISE_LIMITS = {
    MAX_INPUT: 512,
    MAX_TOKENS: 32,
    MAX_VARIANTS: 16,
} as const;

/** Which romanisation produced a variant. `none` = the input was already Latin. */
export type TranslitScheme = 'none' | 'bg-streamlined-2009' | 'bg-traditional' | 'lookalike-fold';

export interface Variant {
    readonly value: string;
    readonly scheme: TranslitScheme;
}

// ‾‾‾ Transliteration ‾‾‾
//
// TWO IN-HOUSE TABLES, chosen over promoting `@sindresorhus/transliterate` to a
// direct dependency. Measured before deciding: that library renders
// `Ъгълов` as `glov` — it DROPS the hard sign entirely, which appears in common
// Bulgarian surnames. That is not a different-but-valid romanisation, it is data
// loss, and it would have needed an in-house pre-pass for `Ъ` anyway. Two tables
// here cost less than one table plus a dependency-governance entry plus a
// risk-review entry plus a pre-pass around a library that is wrong for the
// primary language in scope.

/**
 * Bulgaria's Streamlined System — the 2009 transliteration law, the scheme on a
 * Bulgarian passport. `щ -> sht`, `ъ -> a`, `й -> y`.
 */
const STREAMLINED: Readonly<Record<string, string>> = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ж': 'zh',
    'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n',
    'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f',
    'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sht', 'ъ': 'a',
    'ь': 'y', 'ю': 'yu', 'я': 'ya',
};

/**
 * The traditional/scholarly romanisation a person may well have typed instead.
 *
 * It differs from the law in exactly two ways, which is the point — a second scheme
 * is only useful where the two actually disagree:
 *   - `щ -> shch` rather than `sht`, so `Щербанов` is `Shcherbanov` not `Shterbanov`;
 *   - no word-final contraction, so `София` is `Sofiya` not `Sofia`.
 * `Ъ` maps to `a` in both, deliberately: dropping it is the library behaviour this
 * table exists to avoid, and no human writes `glov` for `Ъгълов`.
 */
const TRADITIONAL: Readonly<Record<string, string>> = { ...STREAMLINED, 'щ': 'shch' };

const CYRILLIC_RE = /[\u0400-\u04FF]/;
const LATIN_RE = /[A-Za-z]/;

/**
 * Cyrillic look-alikes, applied ONLY to a token that mixes scripts.
 *
 * A purely Cyrillic token is transliterated and never look-alike-folded: folding
 * `Иванов` gives `Иbaнob`, which is neither the name nor a romanisation of it, and
 * that is precisely the AI Guard behaviour this subsystem refuses to reuse. A MIXED
 * token is different — `Ivаnov` with a Cyrillic `а` is almost certainly a Latin name
 * someone pasted through a Cyrillic keyboard, so folding it recovers the intent.
 */
const LOOKALIKES: Readonly<Record<string, string>> = {
    'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
    'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j',
    'ѕ': 's', 'һ': 'h',
};

const cap = (s: string): string => (s.length > NORMALISE_LIMITS.MAX_INPUT ? s.slice(0, NORMALISE_LIMITS.MAX_INPUT) : s);

/** NFKC, invisible characters removed, whitespace collapsed. Never throws. */
export function baseClean(raw: string | null | undefined): string {
    if (!raw) return '';
    let s = cap(String(raw));
    try {
        s = s.normalize('NFKC');
    } catch {
        // An unpaired surrogate can make `normalize` throw on some runtimes. The
        // uncleaned string is a worse key than the cleaned one and a better outcome
        // than aborting a pull, so the raw value continues through.
    }
    return stripInvisible(s).replace(/\s+/g, ' ').trim();
}

/**
 * Transliterate one token under one table.
 *
 * ORDER IS LOAD-BEARING. The token is transliterated from its NFC form BEFORE any
 * diacritic folding, and the Latin result is NFD-stripped afterwards. Folding first
 * decomposes `й` into `и` + combining breve and strips the breve, so `Йордан`
 * becomes `Iordan` instead of `Yordan`, and `Николай` becomes `Nikolai` instead of
 * `Nikolay` — the law says otherwise, and so does the passport in the person's hand.
 */
function translitToken(token: string, table: Readonly<Record<string, string>>, wordFinalIa: boolean): string {
    let t = token;
    try {
        t = t.normalize('NFC');
    } catch { /* see baseClean */ }

    // The word-final rule of the Streamlined System: `-ия` becomes `-ia`, so
    // `София` is `Sofia` and `Мария` is `Maria`. Applied to the TOKEN's end before
    // the per-character pass, because it is a rule about the word, not the letter.
    let suffix = '';
    if (wordFinalIa && /ия$/.test(t)) {
        t = t.slice(0, -2);
        suffix = 'ia';
    }

    let out = '';
    for (const ch of t) {
        const lower = ch.toLowerCase();
        const mapped = table[lower];
        if (mapped === undefined) {
            out += ch;
            continue;
        }
        // Preserve the token's capitalisation: a capital maps to a capitalised
        // rendering of a possibly multi-character result (`Щ` -> `Sht`, not `SHT`).
        out += ch === lower ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1);
    }
    out += suffix;

    // NFD-strip marks from the LATIN result only. By here nothing Cyrillic remains
    // for a decomposition to damage.
    try {
        out = out.normalize('NFD').replace(/[\u0300-\u036F]/g, '').normalize('NFC');
    } catch { /* see baseClean */ }
    return out;
}

/**
 * What one scheme renders a token as, regardless of de-duplication.
 *
 * `translitVariants` returns distinct CANDIDATES — if both tables agree, the value
 * appears once, attributed to the first scheme that produced it. That is right for
 * the engine, which scores candidates, and useless for two other callers: a test
 * asking "what does the law say about this token", and a review screen showing a
 * person both renderings so they can see the schemes agree. Hence a direct
 * accessor rather than digging through the list.
 */
export function transliterate(token: string, scheme: 'bg-streamlined-2009' | 'bg-traditional'): string {
    return scheme === 'bg-streamlined-2009'
        ? translitToken(token, STREAMLINED, true)
        : translitToken(token, TRADITIONAL, false);
}

const isMixedScript = (token: string): boolean => CYRILLIC_RE.test(token) && LATIN_RE.test(token);

const foldLookalikes = (token: string): string =>
    [...token]
        .map((ch) => {
            const lower = ch.toLowerCase();
            const mapped = LOOKALIKES[lower];
            if (mapped === undefined) return ch;
            return ch === lower ? mapped : mapped.toUpperCase();
        })
        .join('');

/**
 * Every romanisation candidate for a token, each tagged with its scheme.
 *
 * Deterministic order — `none`, then the law, then the traditional scheme, then a
 * look-alike fold — and de-duplicated, so identical input yields an identical list.
 * Order matters because the engine reports "top candidates" and a reviewer sees
 * them; a set that reshuffled between runs would make two identical reviews look
 * like different ones.
 */
export function translitVariants(token: string): Variant[] {
    const out: Variant[] = [];
    const seen = new Set<string>();
    const push = (value: string, scheme: TranslitScheme) => {
        if (!value || seen.has(value) || out.length >= NORMALISE_LIMITS.MAX_VARIANTS) return;
        seen.add(value);
        out.push({ value, scheme });
    };

    push(token, 'none');
    if (CYRILLIC_RE.test(token)) {
        if (isMixedScript(token)) {
            // Mixed script: the look-alike fold is the likely intent, and the two
            // romanisations are offered as well since the token may be genuinely
            // bilingual. A purely Cyrillic token NEVER reaches this branch.
            push(foldLookalikes(token), 'lookalike-fold');
        }
        push(translitToken(token, STREAMLINED, true), 'bg-streamlined-2009');
        push(translitToken(token, TRADITIONAL, false), 'bg-traditional');
    }
    return out;
}

// ‾‾‾ Email ‾‾‾

export interface NormalisedEmail {
    /** `emailKey`'s answer, unmodified. The ONLY value the JML chain joins on. */
    readonly key: string | null;
    /** `key` with a `+tag` removed. A SEPARATE layer — see below. */
    readonly untagged: string | null;
    /** The local part of `untagged`, for name-shaped comparison. */
    readonly localPart: string | null;
    readonly domain: string | null;
}

/**
 * Equivalent mail domains, for comparison only.
 *
 * NEVER written back and never fed to `emailKey`. `ConnectedIdentityAccount.email`
 * and `Employee.workEmail` are joined byte for byte through `emailKey`, and
 * `docs/jml-joiner-design.md` names a second private normaliser as the defect it
 * must not ship — a disagreement between the collision check and the link matcher
 * is exactly the account a leaver can never disable. So domain equivalence lives
 * here, one layer above, and informs a SUGGESTION rather than a key.
 */
const DOMAIN_EQUIVALENCE: Readonly<Record<string, string>> = {
    'googlemail.com': 'gmail.com',
};

/**
 * Normalise an address WITHOUT touching `emailKey`.
 *
 * `key` is whatever `emailKey` returns, unchanged, because that is the value the
 * reconciler and the joiner both already use. The extra fields are strictly
 * additive and are used for scoring, never for identity.
 */
export function normaliseEmail(raw: string | null | undefined): NormalisedEmail {
    const key = emailKey(baseClean(raw) || null);
    if (!key) return { key: null, untagged: null, localPart: null, domain: null };

    const at = key.lastIndexOf('@');
    if (at <= 0 || at === key.length - 1) return { key, untagged: key, localPart: null, domain: null };

    const local = key.slice(0, at);
    const rawDomain = key.slice(at + 1);
    const domain = DOMAIN_EQUIVALENCE[rawDomain] ?? rawDomain;
    // `+tag` stripping, as its own layer. Gmail-style tagging is a routing feature,
    // not an identity: `ivan+legacy@x` and `ivan@x` are one mailbox.
    const plus = local.indexOf('+');
    const untaggedLocal = plus > 0 ? local.slice(0, plus) : local;
    return {
        key,
        untagged: `${untaggedLocal}@${domain}`,
        localPart: untaggedLocal,
        domain,
    };
}

// ‾‾‾ Names ‾‾‾

const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'eng', 'ing', 'инж', 'д-р', 'г-н', 'г-жа']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'md', 'msc', 'bsc']);

export interface NormalisedName {
    readonly given: string | null;
    readonly family: string | null;
    readonly middle: readonly string[];
    readonly honorifics: readonly string[];
    readonly suffixes: readonly string[];
    /** Text lifted out of parentheses — `(contractor)`, `(IT)`, a second spelling. */
    readonly tags: readonly string[];
    /** Every token's romanisation candidates, in token order. */
    readonly variants: readonly (readonly Variant[])[];
}

const EMPTY_NAME: NormalisedName = {
    given: null, family: null, middle: [], honorifics: [], suffixes: [], tags: [], variants: [],
};

/**
 * Parse a display name into parts.
 *
 * `Last, First` is handled explicitly: a legacy directory stores it that way about
 * as often as not, and guessing from token order alone gets it backwards for half
 * the population.
 */
export function normaliseName(raw: string | null | undefined): NormalisedName {
    const cleaned = baseClean(raw);
    if (!cleaned) return EMPTY_NAME;

    // Lift parenthetical tags out first, so they cannot be mistaken for name parts.
    // Bounded, non-greedy, and the class excludes the delimiter — so it cannot
    // backtrack quadratically on a line of unbalanced brackets.
    const tags: string[] = [];
    const withoutTags = cleaned.replace(/\(([^()]{0,120})\)/g, (_m, inner: string) => {
        const t = inner.trim();
        if (t) tags.push(t);
        return ' ';
    });

    const commaAt = withoutTags.indexOf(',');
    let ordered = withoutTags;
    if (commaAt > 0) {
        const before = withoutTags.slice(0, commaAt).trim();
        const after = withoutTags.slice(commaAt + 1).trim();
        // Only treat it as `Last, First` when BOTH sides carry something; a trailing
        // comma is punctuation, not a structure.
        if (before && after) {
            // `Last, First` reordered to `First Last`; the flag the earlier draft
            // kept was never read, because the reordering IS the record of it.
            ordered = `${after} ${before}`;
        } else {
            ordered = `${before} ${after}`.trim();
        }
    }

    const tokens = ordered.split(' ').filter(Boolean).slice(0, NORMALISE_LIMITS.MAX_TOKENS);
    const honorifics: string[] = [];
    const suffixes: string[] = [];
    const core: string[] = [];
    for (const tok of tokens) {
        const bare = tok.replace(/[.,]/g, '').toLowerCase();
        if (HONORIFICS.has(bare)) { honorifics.push(tok); continue; }
        if (SUFFIXES.has(bare)) { suffixes.push(tok); continue; }
        core.push(tok);
    }

    let given: string | null = null;
    let family: string | null = null;
    let middle: string[] = [];
    if (core.length === 1) {
        // A mononym. NOT split into a guessed given/family pair — Step 4a's
        // convention generator relies on this returning nothing rather than a guess.
        given = core[0];
    } else if (core.length >= 2) {
        given = core[0];
        family = core[core.length - 1];
        middle = core.slice(1, -1);
    }

    return {
        given, family, middle, honorifics, suffixes, tags,
        variants: core.map((t) => translitVariants(t)),
    };
}

// ‾‾‾ Usernames ‾‾‾

export interface NormalisedUsername {
    /** `DOMAIN` from `DOMAIN{BACKSLASH}user`, kept as a qualifier rather than discarded. */
    readonly qualifier: string | null;
    /** The UPN suffix from `user@corp.example`, separated out. */
    readonly upnSuffix: string | null;
    /** A trailing numeric disambiguator — the `2` in `ivanov2`. */
    readonly disambiguator: string | null;
    readonly tokens: readonly string[];
    readonly variants: readonly (readonly Variant[])[];
}

/**
 * Split a login name into tokens.
 *
 * Splits on `.`, `_`, `-` and on a lower-to-upper case change, so `ivan.ivanov`,
 * `ivan_ivanov` and `ivanIvanov` all yield the same two tokens. The case-change
 * split uses a lookahead on a single character class and so is linear.
 */
export function normaliseUsername(raw: string | null | undefined): NormalisedUsername {
    const cleaned = baseClean(raw);
    if (!cleaned) return { qualifier: null, upnSuffix: null, disambiguator: null, tokens: [], variants: [] };

    let s = cleaned;
    let qualifier: string | null = null;
    const slash = s.indexOf('\\');
    if (slash > 0) {
        // A NetBIOS-qualified name. The domain is kept: two accounts called
        // `jsmith` in different domains are two accounts, and dropping the
        // qualifier is how they become one.
        qualifier = s.slice(0, slash);
        s = s.slice(slash + 1);
    }

    let upnSuffix: string | null = null;
    const at = s.lastIndexOf('@');
    if (at > 0) {
        upnSuffix = s.slice(at + 1);
        s = s.slice(0, at);
    }

    let disambiguator: string | null = null;
    // THE STEM MUST CONTAIN A NON-DIGIT. With a bare `(.*?)` the lazy group took
    // one character off `12345` and called `2345` a disambiguator, turning an
    // all-numeric identifier into the token `1`. An employee-number-shaped login
    // is a login, not a name with a counter after it.
    const trailing = /^(.*?[^0-9])([0-9]{1,4})$/.exec(s);
    if (trailing) {
        disambiguator = trailing[2];
        s = trailing[1];
    }

    const tokens = s
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[._\-\s]+/)
        .filter(Boolean)
        .slice(0, NORMALISE_LIMITS.MAX_TOKENS);

    return { qualifier, upnSuffix, disambiguator, tokens, variants: tokens.map((t) => translitVariants(t)) };
}

// ‾‾‾ Employee numbers ‾‾‾

/**
 * Strip a prefix and leading zeros from an employee number.
 *
 * Returns `null` when nothing numeric remains. This is the STRONGEST signal the
 * engine has, so a value that is not really an employee number must become nothing
 * rather than something: `Step 0c` already refuses to fall back to a work email for
 * the same reason, and a fallback here would let an address pose as the strongest
 * match in the system.
 */
export function normaliseEmployeeNumber(raw: string | null | undefined): string | null {
    const cleaned = baseClean(raw).replace(/[\s-]/g, '');
    if (!cleaned) return null;
    // Optional non-digit prefix, then the digits. Anchored and linear.
    const m = /^[A-Za-z]{0,8}0*([0-9]{1,32})$/.exec(cleaned);
    if (!m) return null;
    const digits = m[1].replace(/^0+/, '');
    return digits.length > 0 ? digits : null;
}
