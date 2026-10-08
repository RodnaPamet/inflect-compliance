/**
 * Username conventions — declared by a person, never inferred by the engine.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY A DECLARED TEMPLATE AND NOT A LEARNED ONE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A legacy application usually has a house style: `jsmith`, or `john.smith`, or
 * `smithj2`. Knowing it turns a name-only residue account into a confident
 * suggestion. The tempting move is to infer the style from the data — fit the
 * template that explains the most usernames and use it.
 *
 * That is exactly backwards for this engine. An inferred template is fitted to the
 * accounts it is then used to match, so the accounts that fit become evidence for
 * the rule that explains them, and the rule's apparent accuracy is circular. Worse,
 * the population it is fitted on contains the leavers and the orphans — the rows
 * this product exists to find — so a template learned from them is a template that
 * explains away the anomalies.
 *
 * So: {@link proposeConventions} MEASURES how well each template explains a
 * snapshot and reports it. A human reads that and adopts one. Nothing is adopted
 * automatically, and the adopted template is stored, versioned and audited.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND WHY IT STILL CANNOT LINK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Even a correct, human-adopted convention is a rule about how names USUALLY
 * become usernames. `jsmith` is John Smith until Jane Smith joins. So the signal it
 * emits is `USERNAME_CONVENTION`, which is a {@link SupportingSignalKind} — the
 * engine's type system will not let it reach `LINKED` however it scores, and a
 * collision between two employees yields `AMBIGUOUS` rather than the earlier of
 * them.
 *
 * @module lib/identity/reconcile/conventions
 */

import { baseClean, normaliseUsername, translitVariants } from './normalise';

// ─── The grammar ───────────────────────────────────────────────────────────

/**
 * The complete token set. Anything else is rejected by {@link parseConvention}.
 *
 * Deliberately small. Every token here is derivable from a given name and a family
 * name, which is all the roster reliably has — a grammar with `{dept}` or
 * `{hiredYear}` would be expressible and unusable.
 *
 * Upper-case variants are separate tokens rather than a flag, because a template
 * mixes them: `{F}{last}` is a real house style (`JSmith`).
 */
export const CONVENTION_TOKENS = [
    'first',
    'last',
    'middle',
    'f',
    'l',
    'm',
    'FIRST',
    'LAST',
    'MIDDLE',
    'F',
    'L',
    'M',
] as const;

export type ConventionToken = (typeof CONVENTION_TOKENS)[number];

/**
 * The optional trailing counter: `{n?}`.
 *
 * Optional because it disambiguates rather than identifies — `jsmith` and `jsmith2`
 * are the same template. It may appear at most once and only at the end, which is
 * what a counter means; `{n?}jsmith` is not a convention anybody has.
 */
export const COUNTER_TOKEN = 'n?';

/** A template longer than this is not a naming convention. */
export const MAX_TEMPLATE_LENGTH = 64;
/** Separator runs are literal, and bounded for the same reason. */
export const MAX_LITERAL_LENGTH = 8;

/** Literal separators a template may contain. */
const LITERAL_RE = /^[._\-]{1,8}$/;

export type ConventionPart =
    | { readonly kind: 'token'; readonly token: ConventionToken }
    | { readonly kind: 'literal'; readonly text: string }
    | { readonly kind: 'counter' };

export interface ParsedConvention {
    readonly template: string;
    readonly parts: readonly ConventionPart[];
}

export class ConventionSyntaxError extends Error {
    constructor(
        readonly template: string,
        readonly reason: string
    ) {
        // The template is operator-supplied configuration, not legacy data, so it
        // is safe to echo — and an error that will not say which template it
        // rejected is useless to the person fixing it.
        super(`invalid username convention ${JSON.stringify(template)}: ${reason}`);
        this.name = 'ConventionSyntaxError';
    }
}

/**
 * Parse a template, or throw.
 *
 * Throws rather than returning null: a template reaches this function from stored
 * configuration a human adopted, so a malformed one is a bug in validation
 * upstream, and silently generating nothing would make a convention that never
 * matches indistinguishable from one that is simply wrong about the house style.
 */
export function parseConvention(template: string): ParsedConvention {
    const raw = String(template ?? '');
    if (raw.length === 0) throw new ConventionSyntaxError(raw, 'empty');
    if (raw.length > MAX_TEMPLATE_LENGTH) {
        throw new ConventionSyntaxError(raw, `longer than ${MAX_TEMPLATE_LENGTH} characters`);
    }

    const parts: ConventionPart[] = [];
    let i = 0;
    let sawCounter = false;

    while (i < raw.length) {
        if (raw[i] === '{') {
            const close = raw.indexOf('}', i);
            if (close === -1) throw new ConventionSyntaxError(raw, 'unclosed {');
            const name = raw.slice(i + 1, close);

            if (name === COUNTER_TOKEN) {
                if (sawCounter) throw new ConventionSyntaxError(raw, 'more than one {n?}');
                if (close !== raw.length - 1) {
                    throw new ConventionSyntaxError(raw, '{n?} must be last — it is a counter');
                }
                sawCounter = true;
                parts.push({ kind: 'counter' });
            } else if ((CONVENTION_TOKENS as readonly string[]).includes(name)) {
                if (sawCounter) throw new ConventionSyntaxError(raw, 'nothing may follow {n?}');
                parts.push({ kind: 'token', token: name as ConventionToken });
            } else {
                throw new ConventionSyntaxError(raw, `unknown token {${name}}`);
            }
            i = close + 1;
            continue;
        }

        // A literal run, up to the next `{`.
        const next = raw.indexOf('{', i);
        const text = next === -1 ? raw.slice(i) : raw.slice(i, next);
        if (!LITERAL_RE.test(text)) {
            throw new ConventionSyntaxError(
                raw,
                `literal ${JSON.stringify(text)} is not a separator run of . _ - (max ${MAX_LITERAL_LENGTH})`
            );
        }
        if (sawCounter) throw new ConventionSyntaxError(raw, 'nothing may follow {n?}');
        parts.push({ kind: 'literal', text });
        i = next === -1 ? raw.length : next;
    }

    if (!parts.some((p) => p.kind === 'token')) {
        throw new ConventionSyntaxError(raw, 'no name token — this template matches everyone');
    }
    return { template: raw, parts };
}

// ─── Generating the expected username ──────────────────────────────────────

export interface ConventionEmployee {
    readonly id: string;
    readonly givenName?: string | null;
    readonly middleNames?: readonly string[];
    readonly familyName?: string | null;
    readonly fullName?: string | null;
}

/**
 * The name parts a template can use, or null when they cannot be established.
 *
 * THE RULE THAT MATTERS: when `givenName` / `familyName` are absent, `fullName` is
 * split only when it yields EXACTLY two tokens. A mononym generates nothing. A
 * three-part name generates nothing.
 *
 * Guessing the split is how "Maria del Carmen Garcia" becomes `mdel` and matches
 * the wrong person with a confident-looking convention signal behind it. Two tokens
 * is the only case with one reading, and a roster that cannot say which part is the
 * family name is a roster that has not been asked to.
 */
export function nameParts(e: ConventionEmployee): {
    given: string;
    family: string;
    middle: string;
} | null {
    const given = baseClean(e.givenName);
    const family = baseClean(e.familyName);
    const middle = baseClean(e.middleNames?.[0] ?? '');

    if (given && family) return { given, family, middle };

    const full = baseClean(e.fullName);
    if (!full) return null;
    const tokens = full.split(/\s+/).filter(Boolean);
    // Exactly two. Not "at least two", not "first and last of N".
    if (tokens.length !== 2) return null;
    return { given: tokens[0], family: tokens[1], middle: '' };
}

/**
 * The username a template expects for one employee, or null.
 *
 * Null when the parts cannot be established, and null when the template needs a
 * part this employee lacks — a `{middle}` template over somebody with no middle
 * name generates nothing rather than collapsing the separator and inventing a
 * different username.
 *
 * The result is lower-cased for comparison. Case is a presentation detail of the
 * legacy system, and two systems disagree about it constantly; the UPPER tokens in
 * the grammar exist so a template can DESCRIBE a system's style, not so the
 * comparison becomes case-sensitive.
 */
export function generateUsername(
    convention: ParsedConvention,
    employee: ConventionEmployee
): string | null {
    const parts = nameParts(employee);
    if (!parts) return null;

    let out = '';
    for (const p of convention.parts) {
        if (p.kind === 'literal') {
            out += p.text;
            continue;
        }
        if (p.kind === 'counter') continue; // optional; the bare form is generated

        const value = ((): string | null => {
            switch (p.token) {
                case 'first':
                case 'FIRST':
                    return parts.given || null;
                case 'last':
                case 'LAST':
                    return parts.family || null;
                case 'middle':
                case 'MIDDLE':
                    return parts.middle || null;
                case 'f':
                case 'F':
                    return parts.given ? parts.given[0] : null;
                case 'l':
                case 'L':
                    return parts.family ? parts.family[0] : null;
                case 'm':
                case 'M':
                    return parts.middle ? parts.middle[0] : null;
            }
        })();

        if (value === null) return null;
        out += value;
    }

    const cleaned = out.toLowerCase().trim();
    return cleaned.length > 0 ? cleaned : null;
}

/**
 * Strip a trailing counter from an observed login, when the template allows one.
 *
 * `normaliseUsername` already separates a trailing 1–4 digit disambiguator from a
 * stem that contains a non-digit, and reusing it keeps one definition of what a
 * counter looks like rather than a second regex that can disagree with the first.
 */
function stemOf(login: string, allowsCounter: boolean): string {
    const cleaned = baseClean(login).toLowerCase();
    if (!allowsCounter) return cleaned;
    const u = normaliseUsername(cleaned);
    return u.disambiguator ? cleaned.slice(0, cleaned.length - u.disambiguator.length) : cleaned;
}

// ─── Matching a login against a roster ─────────────────────────────────────

export interface ConventionMatch {
    /** Employees whose generated username equals the account's login. */
    readonly employeeIds: readonly string[];
    /** True when two or more matched — the caller must yield AMBIGUOUS. */
    readonly collides: boolean;
    /** The romanisation scheme that produced the match, when one did. */
    readonly scheme: string | null;
}

/**
 * Which employees a convention says could hold this login.
 *
 * Returns ALL of them. A collision is not a tie to be broken — `jsmith` generated
 * by both John and Jane Smith is a statement that the convention cannot tell them
 * apart, and the engine turns that into `AMBIGUOUS`. Returning the first, or the
 * one with the earlier start date, would be the engine inventing a rule the
 * convention does not contain.
 *
 * Transliteration is tried only AFTER the direct comparison fails, and the
 * matching scheme is recorded. A candidate found by romanising a Cyrillic name is
 * a weaker claim than one found directly, and Step 4a's checklist requires it be
 * traceable to the scheme that produced it.
 */
export function matchConvention(
    convention: ParsedConvention,
    login: string,
    roster: readonly ConventionEmployee[]
): ConventionMatch {
    const allowsCounter = convention.parts.some((p) => p.kind === 'counter');
    const target = stemOf(login, allowsCounter);
    if (!target) return { employeeIds: [], collides: false, scheme: null };

    const direct: string[] = [];
    for (const e of roster) {
        const generated = generateUsername(convention, e);
        if (generated && generated === target) direct.push(e.id);
    }
    if (direct.length > 0) {
        const ids = [...direct].sort();
        return { employeeIds: ids, collides: ids.length > 1, scheme: null };
    }

    // Transliterated forms, each tagged with the scheme that produced it.
    const viaTranslit: { id: string; scheme: string }[] = [];
    for (const e of roster) {
        const parts = nameParts(e);
        if (!parts) continue;
        for (const gv of translitVariants(parts.given)) {
            for (const fv of translitVariants(parts.family)) {
                const generated = generateUsername(convention, {
                    id: e.id,
                    givenName: gv.value,
                    familyName: fv.value,
                    middleNames: parts.middle ? [parts.middle] : [],
                });
                if (generated && generated === target) {
                    // The weaker of the two schemes names the claim: a match that
                    // needed romanisation on either side is a romanised match.
                    viaTranslit.push({ id: e.id, scheme: gv.scheme === 'none' ? fv.scheme : gv.scheme });
                }
            }
        }
    }

    const ids = [...new Set(viaTranslit.map((v) => v.id))].sort();
    if (ids.length === 0) return { employeeIds: [], collides: false, scheme: null };
    const scheme = viaTranslit.find((v) => v.id === ids[0])?.scheme ?? null;
    return { employeeIds: ids, collides: ids.length > 1, scheme };
}

// ─── The proposer ──────────────────────────────────────────────────────────

export interface ConventionProposal {
    readonly template: string;
    /** Logins this template explains, uniquely — a collision does not count. */
    readonly explainedUniquely: number;
    /** Logins it explains but ambiguously. Reported, never counted as success. */
    readonly explainedAmbiguously: number;
    readonly total: number;
    /** `explainedUniquely / total`, 0 when there is nothing to explain. */
    readonly share: number;
}

/**
 * Templates worth measuring against a snapshot.
 *
 * A fixed list, not a search. A search over the grammar would find the template
 * that best fits THIS data, which is the circularity the module docblock describes;
 * a fixed list measures the house styles that actually exist in the world and lets
 * a human pick.
 */
export const CANDIDATE_TEMPLATES: readonly string[] = [
    '{f}{last}',
    '{first}{last}',
    '{first}.{last}',
    '{first}_{last}',
    '{last}{f}',
    '{last}.{first}',
    '{first}{l}',
    '{f}{m}{last}',
    '{f}{last}{n?}',
    '{first}.{last}{n?}',
    '{last}{f}{n?}',
];

/**
 * For each template, how much of the snapshot it explains uniquely.
 *
 * Reported for a human to read. Nothing here adopts anything, and the function
 * returns no "best" — a caller that wants one has to pick it, which is the point.
 */
export function proposeConventions(
    logins: readonly string[],
    roster: readonly ConventionEmployee[],
    templates: readonly string[] = CANDIDATE_TEMPLATES
): readonly ConventionProposal[] {
    const total = logins.length;
    const out: ConventionProposal[] = [];

    for (const template of templates) {
        let parsed: ParsedConvention;
        try {
            parsed = parseConvention(template);
        } catch {
            continue; // a malformed candidate is skipped, not reported as 0%
        }
        let unique = 0;
        let ambiguous = 0;
        for (const login of logins) {
            const m = matchConvention(parsed, login, roster);
            if (m.employeeIds.length === 1) unique += 1;
            else if (m.employeeIds.length > 1) ambiguous += 1;
        }
        out.push({
            template,
            explainedUniquely: unique,
            explainedAmbiguously: ambiguous,
            total,
            share: total === 0 ? 0 : unique / total,
        });
    }

    // Highest share first, then alphabetically — a total order, so two templates
    // that explain the same share do not depend on list position.
    return [...out].sort((a, b) => b.share - a.share || a.template.localeCompare(b.template));
}
