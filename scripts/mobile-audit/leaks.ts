/**
 * English text on a Bulgarian page — the leak detector behind the
 * `englishLeaks` metric (see `measure.ts` for the rest of the table).
 *
 * It runs Node-side over the texts `collectInPage` returned, so it is a pure
 * function and is unit-tested (`tests/unit/mobile-audit-leaks.test.ts`). A
 * string is a leak for one of four reasons, each named in the result:
 *
 *   CATALOG       the whole string is an English message from `messages/en.json`
 *                 that Bulgarian translates differently (or does not translate
 *                 at all, see EN_IN_BG) — a string rendered from the English
 *                 catalog, or a hard-coded copy of one.
 *   EMBEDDED      a Bulgarian sentence carries an English catalog message
 *                 inside it: "Обратно към Agents". A Latin run that the
 *                 Bulgarian catalog itself uses ("Active Directory") is a
 *                 product name kept on purpose, not a leak.
 *   EN_IN_BG      `messages/bg.json` holds the English text itself. Only values
 *                 that contain a common English word count, so a brand or an
 *                 acronym kept on purpose ("Okta", "PDF", "ISO 27001") does not.
 *   CHROME        a short (three words at most) control label, tab, column
 *                 header or placeholder written in Latin letters only that
 *                 contains a common English word — the hard-coded literal that
 *                 never reached the catalog ("Clear Filters", "Expand all").
 *   DATE          an English month or relative time ("29 November 2026",
 *                 "20 minutes ago").
 *
 * Seeded records are English (control and risk titles), so free text in the
 * page body is judged only against the catalog and the date patterns, never by
 * the word heuristic, and the caller passes the record names (tenants, orgs,
 * controls) as `dataNames` — "Acme Corp" is both the seeded tenant and an
 * English placeholder in the catalog.
 */

export type LeakReason = 'CATALOG' | 'EMBEDDED' | 'EN_IN_BG' | 'CHROME' | 'DATE';

export interface Leak {
    text: string;
    reason: LeakReason;
}

export interface LeakCatalog {
    /** English values (whitespace-squashed) Bulgarian renders differently. */
    exact: ReadonlySet<string>;
    /** English values with `{placeholders}`, as anchored patterns plus a literal pre-filter. */
    patterns: ReadonlyArray<{ literal: string; re: RegExp }>;
    /** Multi-word Latin runs the Bulgarian catalog itself uses: product names kept on purpose ("Active Directory"). */
    keptInBg: ReadonlySet<string>;
}

/**
 * Function words and common UI verbs. Deliberately no nouns a seeded name
 * could carry ("Admin", "Corp"), so a person's or tenant's name on a button is
 * not called a leak.
 */
const COMMON_ENGLISH = new Set([
    'the', 'and', 'or', 'of', 'to', 'for', 'with', 'by', 'from', 'in', 'on', 'at', 'no', 'not', 'yet',
    'is', 'are', 'was', 'be', 'this', 'that', 'your', 'you', 'all', 'any', 'none', 'more', 'less',
    'add', 'new', 'clear', 'filters', 'filter', 'expand', 'collapse', 'show', 'hide', 'save', 'cancel',
    'delete', 'remove', 'edit', 'create', 'view', 'open', 'close', 'back', 'next', 'previous', 'search',
    'select', 'apply', 'reset', 'run', 'export', 'import', 'download', 'upload', 'settings', 'details',
    'overview', 'status', 'owner', 'actions', 'loading', 'empty', 'results', 'items', 'page', 'of',
    'sign', 'out', 'continue', 'submit', 'confirm', 'retry', 'refresh', 'copy', 'copied', 'link',
    'unlink', 'assign', 'reviewer', 'due', 'date', 'today', 'yesterday', 'ago', 'never', 'always',
    'enabled', 'disabled', 'enable', 'disable', 'active', 'inactive', 'pending', 'approved', 'rejected',
]);

const MONTHS =
    '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
const DATE_RES = [
    new RegExp(`\\b\\d{1,2}\\s+${MONTHS}\\b`),
    new RegExp(`\\b${MONTHS}\\s+\\d{1,2}\\b`),
    /\b(?:\d+|an?)\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago\b/i,
];

const CYRILLIC = /[Ѐ-ӿ]/;
const PLACEHOLDER = /\{[^{}]*\}/g;
/** A run of Latin words inside a mixed string: "Agents" in "Обратно към Agents". */
const LATIN_RUN = /[A-Za-z][A-Za-z0-9'’&-]*(?: [A-Za-z0-9'’&-]+)*/g;

export const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

const words = (s: string): string[] => s.toLowerCase().match(/[a-z]+/g) ?? [];
const hasCommonEnglish = (s: string): boolean => words(s).some((w) => COMMON_ENGLISH.has(w));
/** At least one Latin word of three letters or more with a lowercase letter: prose, not an acronym. */
const looksLikeEnglishProse = (s: string): boolean => /\b[A-Za-z]*[a-z][A-Za-z]*\b/.test(s) && /[A-Za-z]{3,}/.test(s);

function flatten(obj: unknown, prefix: string, into: Map<string, string>): void {
    if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, into);
    } else if (typeof obj === 'string') {
        into.set(prefix, obj);
    }
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build the catalog from the two message files (parsed JSON). */
export function buildLeakCatalog(en: unknown, bg: unknown): LeakCatalog {
    const enMap = new Map<string, string>();
    const bgMap = new Map<string, string>();
    flatten(en, '', enMap);
    flatten(bg, '', bgMap);
    const exact = new Set<string>();
    const patterns: Array<{ literal: string; re: RegExp }> = [];
    const keptInBg = new Set<string>();
    // Multi-word runs only: a product name ("Active Directory", "Microsoft Entra
    // ID"). A single Latin word in bg.json ("Admin" in some technical string)
    // says nothing about whether the word alone is Bulgarian UI.
    for (const v of bgMap.values()) {
        for (const run of squash(v).replace(PLACEHOLDER, ' ').match(LATIN_RUN) ?? []) if (run.includes(' ')) keptInBg.add(run);
    }
    for (const [key, raw] of enMap) {
        const value = squash(raw);
        const bgValue = bgMap.has(key) ? squash(bgMap.get(key) as string) : undefined;
        const translated = bgValue !== undefined && bgValue !== value;
        if (!translated && !hasCommonEnglish(value.replace(PLACEHOLDER, ' '))) continue;
        if (value.includes('{')) {
            // ICU plurals/selects are skipped: their literal text is not one string.
            if (/\{[^{}]*,\s*(?:plural|select|selectordinal)/.test(value)) continue;
            const literals = value.split(PLACEHOLDER).map((s) => s.trim()).filter(Boolean);
            const literal = [...literals].sort((a, b) => b.length - a.length)[0] ?? '';
            // A short literal around a placeholder ("User {name}", "{n} policies")
            // matches any data that starts or ends with that word.
            const literalText = literals.join(' ');
            if (!looksLikeEnglishProse(literalText) || literalText.length < 12 || words(literalText).length < 2) continue;
            const body = value.split(PLACEHOLDER).map(escapeRe).join('.+?');
            patterns.push({ literal, re: new RegExp(`^${body}$`) });
        } else if (value.length >= 3 && looksLikeEnglishProse(value)) {
            exact.add(value);
        }
    }
    return { exact, patterns, keptInBg };
}

function catalogHas(catalog: LeakCatalog, s: string): boolean {
    if (catalog.exact.has(s)) return true;
    for (const p of catalog.patterns) if (s.includes(p.literal) && p.re.test(s)) return true;
    return false;
}

/**
 * The distinct English strings among a page's texts. `chromeTexts` must be a
 * subset of `texts` (control labels, tabs, headers, placeholders).
 */
export function findEnglishLeaks(
    page: { texts: readonly string[]; chromeTexts: readonly string[] },
    catalog: LeakCatalog,
    /** Record names that are data, not UI: the seeded tenant, org and people. */
    dataNames: ReadonlySet<string> = new Set(),
): Leak[] {
    const chrome = new Set(page.chromeTexts.map(squash));
    const leaks = new Map<string, LeakReason>();
    for (const raw of page.texts) {
        const s = squash(raw);
        if (s.length < 3 || leaks.has(s) || dataNames.has(s)) continue;
        const cyr = CYRILLIC.test(s);
        if (!cyr && catalogHas(catalog, s)) {
            leaks.set(s, 'CATALOG');
            continue;
        }
        if (DATE_RES.some((re) => re.test(s))) {
            leaks.set(s, 'DATE');
            continue;
        }
        if (cyr) {
            const runs = s.match(LATIN_RUN) ?? [];
            const english = (r: string) => r.length >= 4 && !dataNames.has(r) && !catalog.keptInBg.has(r) && catalog.exact.has(r);
            if (runs.some(english)) leaks.set(s, 'EMBEDDED');
            continue;
        }
        // Three words at most: a control label, not a seeded title shown on a button.
        if (chrome.has(s) && s.split(' ').length <= 3 && looksLikeEnglishProse(s) && hasCommonEnglish(s)) leaks.set(s, 'CHROME');
    }
    return Array.from(leaks, ([text, reason]) => ({ text, reason }));
}

/** Load the catalog from the repository's message files. */
export async function loadLeakCatalog(repoRoot: string): Promise<LeakCatalog> {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const [en, bg] = await Promise.all(
        ['en', 'bg'].map(async (l) => JSON.parse(await readFile(path.join(repoRoot, 'messages', `${l}.json`), 'utf8')) as unknown),
    );
    return buildLeakCatalog(en, bg);
}
