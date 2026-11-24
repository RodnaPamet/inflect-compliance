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
 *                 inside it: "Обратно към Agents", or a whole templated one,
 *                 "Обобщение: Posture snapshot — 3 controls, …". A Latin run
 *                 that the Bulgarian catalog itself uses ("Active Directory")
 *                 is a product name kept on purpose, not a leak.
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
 *
 * A SENTENCE THE PRODUCT STORES is the case the page alone cannot settle
 * (#5883): the diagnostic workflow writes its run summary in English
 * ("Posture snapshot — 3 controls, 7 risks, 2 open tasks."), the run keeps it
 * as its record, and the runs pages must re-word it for a Bulgarian reader. It
 * is free text in the page body, like an agent's own summary, which is data.
 * What makes it the product's is that its template is a catalog message
 * (`agentWorkflows.diagnostic.summary`), so the stored English matches a
 * placeholder pattern and is caught as CATALOG, or EMBEDDED behind a
 * Bulgarian label. A product sentence in NO catalog cannot be told from tenant
 * data by any rule here: the fix is to give its template a catalog message,
 * which is also what lets it be translated.
 * `tests/unit/mobile-audit-leaks.test.ts` holds this against the real catalog
 * and the workflow's own synthesis step.
 *
 * LIBRARY CONTENT is content too (owner decision, 2026-11-23): the English
 * text the product ships as a library — control and policy templates,
 * framework names and descriptions, requirement titles and sections, ISO
 * clause names, the seeded vendor questionnaires' sections, prompts and
 * options. Translating it is a content project, not an interface defect. The
 * caller passes those values as `libraryTexts` (`resolve.ts` reads them from
 * the library tables), and a page string that IS one of them is not a leak.
 * The exclusion is by exact value, never by kind of text, so an interface
 * string is still judged — with one rule where the two meet: a library value
 * that is also a SINGLE-WORD English catalog message ("High", "Planning",
 * "Security") is still judged as the interface string, because a one-word
 * label is far likelier to be the product's own ("High" is a severity) than
 * a coincidence. A multi-word value ("Risk Management", "Information Security
 * Policy") is the library's phrase wherever it appears — including INSIDE a
 * Bulgarian sentence: "Избор на A-5.22 Monitoring, review and change
 * management of supplier services" is the catalog's "Избор на {name}" with a
 * control template's title in it, and "Monitoring" there is the title's word,
 * not a stray interface label (#5924).
 *
 * A PRODUCT NAME IN BULGARIAN PROSE is the Bulgarian text's own word
 * (#5924). The NIS2 gap questionnaire asks "Използвате ли сигурни съобщения
 * (Teams, Signal) вместо некриптирани SMS…": "Signal" is also an English
 * catalog label (a legacy-queue column, "Сигнал"), but here it names an app.
 * An interface label that leaks is interpolated where a Bulgarian word should
 * stand — "Обратно към Agents", "…да изтриете този Risk?" — and a name is
 * given as an example, in an aside. So a single capitalised Latin word inside
 * a parenthesised aside of a Bulgarian sentence (at least
 * `PROSE_MIN_CYRILLIC_WORDS` Bulgarian words) is a name, not a leak. A label
 * outside an aside, a label in a short string, and a multi-word message are
 * still judged; a name in running text with no aside ("Teams или Signal") is
 * the case this rule does not reach.
 *
 * A QUESTIONNAIRE'S ANSWER OPTIONS are data where their question is shown
 * (#5924). A vendor questionnaire a tenant wrote offers "Yes", "Partial",
 * "Other" as its options; each is also a one-word English catalog label, and
 * none is the interface's. The caller passes every questionnaire's options
 * keyed by the prompt they answer (`QuestionOptions`), and `pageDataNames`
 * adds a question's options to the page's data names only when the page shows
 * that question's prompt: an option is data beside its question, and the same
 * word anywhere else is still judged as the interface's.
 */

export type LeakReason = 'CATALOG' | 'EMBEDDED' | 'EN_IN_BG' | 'CHROME' | 'DATE';

export interface Leak {
    text: string;
    reason: LeakReason;
}

export interface LeakCatalog {
    /** English values (whitespace-squashed) Bulgarian renders differently. */
    exact: ReadonlySet<string>;
    /**
     * English values with `{placeholders}`, as anchored patterns plus a literal
     * pre-filter, and `embedded`: the same message found INSIDE a longer string,
     * its placeholders matching no Cyrillic, for a Bulgarian sentence that
     * carries a whole English message ("Обобщение: Posture snapshot — 3
     * controls, …").
     */
    patterns: ReadonlyArray<{ literal: string; re: RegExp; embedded: RegExp }>;
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

const CYRILLIC_RANGE = 'Ѐ-ӿ';
const CYRILLIC = new RegExp(`[${CYRILLIC_RANGE}]`);
const CYRILLIC_WORD = new RegExp(`[${CYRILLIC_RANGE}]+`, 'g');
/** How many Bulgarian words make a string a sentence rather than a label ("Обратно към Agents" has two). */
export const PROSE_MIN_CYRILLIC_WORDS = 6;
/** A parenthesised aside: "(Teams, Signal)". */
const ASIDE = /\(([^()]*)\)/g;
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
    const patterns: Array<{ literal: string; re: RegExp; embedded: RegExp }> = [];
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
            const parts = value.split(PLACEHOLDER).map(escapeRe);
            patterns.push({
                literal,
                re: new RegExp(`^${parts.join('.+?')}$`),
                embedded: new RegExp(parts.join(`[^${CYRILLIC_RANGE}]+?`)),
            });
        } else if (value.length >= 3 && looksLikeEnglishProse(value)) {
            exact.add(value);
        }
    }
    return { exact, patterns, keptInBg };
}

/**
 * For each Latin run of a multi-word library value, the values it occurs in,
 * so a run inside a Bulgarian sentence can be traced to a library value the
 * sentence carries whole. Built once per library set.
 */
const libraryRunIndexes = new WeakMap<ReadonlySet<string>, Map<string, string[]>>();
function libraryRunIndex(libraryTexts: ReadonlySet<string>): Map<string, string[]> {
    let index = libraryRunIndexes.get(libraryTexts);
    if (index) return index;
    index = new Map();
    for (const value of libraryTexts) {
        if (!value.includes(' ')) continue;
        for (const run of value.match(LATIN_RUN) ?? []) {
            const list = index.get(run);
            if (list) list.push(value);
            else index.set(run, [value]);
        }
    }
    libraryRunIndexes.set(libraryTexts, index);
    return index;
}

/**
 * `run` is a name given as an example in Bulgarian prose: one capitalised
 * Latin word inside a parenthesised aside of a sentence of at least
 * `PROSE_MIN_CYRILLIC_WORDS` Bulgarian words (see the module docblock).
 */
function nameInAnAside(s: string, run: string): boolean {
    if (run.includes(' ') || !/^[A-Z][a-z]/.test(run)) return false;
    if ((s.match(CYRILLIC_WORD) ?? []).length < PROSE_MIN_CYRILLIC_WORDS) return false;
    const word = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(run)}(?:[^A-Za-z0-9]|$)`);
    for (const aside of s.matchAll(ASIDE)) if (word.test(aside[1])) return true;
    return false;
}

/** Every questionnaire's answer options, keyed by the (squashed) prompt they answer. */
export type QuestionOptions = ReadonlyMap<string, readonly string[]>;

/**
 * The page's data names: `names`, plus the answer options of every question
 * whose prompt the page shows (see the module docblock).
 */
export function pageDataNames(
    texts: readonly string[],
    names: ReadonlySet<string>,
    questionOptions: QuestionOptions,
): ReadonlySet<string> {
    if (!questionOptions.size) return names;
    const extra: string[] = [];
    for (const raw of texts) {
        const options = questionOptions.get(squash(raw));
        if (options) extra.push(...options);
    }
    return extra.length ? new Set([...names, ...extra.map(squash)]) : names;
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
    /** Values of the shipped English library: content, not UI (see the module docblock). */
    libraryTexts: ReadonlySet<string> = new Set(),
): Leak[] {
    const chrome = new Set(page.chromeTexts.map(squash));
    const leaks = new Map<string, LeakReason>();
    const isLibrary = (s: string): boolean =>
        libraryTexts.has(s) && (s.includes(' ') || !catalogHas(catalog, s));
    for (const raw of page.texts) {
        const s = squash(raw);
        if (s.length < 3 || leaks.has(s) || dataNames.has(s) || isLibrary(s)) continue;
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
            // A run that belongs to a multi-word library value the sentence
            // carries whole is the library's word, not the interface's.
            const inLibraryValue = (r: string) =>
                (libraryRunIndex(libraryTexts).get(r) ?? []).some((value) => s.includes(value));
            const english = (r: string) =>
                r.length >= 4 &&
                !dataNames.has(r) &&
                !isLibrary(r) &&
                !catalog.keptInBg.has(r) &&
                catalog.exact.has(r) &&
                !inLibraryValue(r) &&
                !nameInAnAside(s, r);
            // A whole templated message inside the sentence: a stored English
            // sentence the product wrote, shown after a Bulgarian label.
            const message = catalog.patterns.some((p) => s.includes(p.literal) && p.embedded.test(s));
            if (runs.some(english) || message) leaks.set(s, 'EMBEDDED');
            continue;
        }
        // Three words at most: a control label, not a seeded title shown on a button.
        if (chrome.has(s) && s.split(' ').length <= 3 && looksLikeEnglishProse(s) && hasCommonEnglish(s)) leaks.set(s, 'CHROME');
    }
    return Array.from(leaks, ([text, reason]) => ({ text, reason }));
}

/** The labels of a library question's options: `[{ label }]`, `["Yes", "No"]`, or a scale's `{ labels: [...] }`. */
export function optionLabels(json: unknown): string[] {
    const list = Array.isArray(json)
        ? json
        : json && typeof json === 'object' && Array.isArray((json as { labels?: unknown }).labels)
          ? (json as { labels: unknown[] }).labels
          : [];
    return list.flatMap((o) =>
        typeof o === 'string' ? [o] : o && typeof o === 'object' && typeof (o as { label?: unknown }).label === 'string' ? [(o as { label: string }).label] : [],
    );
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
