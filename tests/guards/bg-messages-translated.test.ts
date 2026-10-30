/**
 * Bulgarian copy is Bulgarian (#4553).
 *
 * `messages/bg.json` and `messages/en.json` hold the same keys, so key parity
 * is complete and every i18n ratchet is green. Parity is the wrong axis for
 * "was this translated": copying the English value across satisfies it. Ten
 * Bulgarian values shipped as the English sentence that way, six of them the
 * whole SharePoint export toast, and nothing in CI could see it.
 *
 * This guard reads the axis parity cannot. A Bulgarian value FAILS when it is
 * byte-identical to its English counterpart, has no Cyrillic, and still reads
 * as English: either it contains an English prose word (a lowercase word of
 * three or more letters outside `{placeholders}`, URLs, e-mail addresses and
 * code-like tokens such as `cpe:2.3:a:vendor`), or it is one of the common
 * one-word UI labels in `ENGLISH_UI_WORDS` ("Undo" shipped untranslated too).
 *
 * What stays English on purpose does not trip it: product names
 * (`Microsoft Entra ID`, `Okta`), acronyms and units (`SOC 2`, `CVSS`,
 * `200 MB`), format-only strings (`v{version}`, `{from} → {to}`), placeholders
 * of URLs and addresses. The few values that DO trip it and must stay as they
 * are live in `KEPT_IN_ENGLISH`, each with its reason, and the flagged set must
 * equal that list exactly: a new untranslated sentence fails, and so does an
 * entry left behind after its value was translated.
 *
 * What it cannot see: a capitalised English word that is not in
 * `ENGLISH_UI_WORDS`, and English copy that differs from the en value. Both
 * need a reader, not a regex; the guard narrows the class, it does not close it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Messages = { [key: string]: string | Messages };

const ROOT = join(__dirname, '..', '..');
const read = (lang: string): Messages =>
    JSON.parse(readFileSync(join(ROOT, 'messages', `${lang}.json`), 'utf8')) as Messages;

function flatten(tree: Messages, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    for (const [key, value] of Object.entries(tree)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (typeof value === 'string') out.set(path, value);
        else for (const [k, v] of flatten(value, path)) out.set(k, v);
    }
    return out;
}

const CYRILLIC = /[Ѐ-ӿ]/;

/** One-word labels that are English UI vocabulary, not a name or an acronym. */
const ENGLISH_UI_WORDS: ReadonlySet<string> = new Set([
    'Undo', 'Cancel', 'Save', 'Delete', 'Remove', 'Close', 'Edit', 'Add', 'Back',
    'Next', 'Previous', 'Confirm', 'Retry', 'Submit', 'Search', 'Loading…', 'Saving…',
    'Yes', 'No', 'None', 'All', 'Open', 'Done',
]);

/** English prose words left once placeholders, URLs, addresses and codes are removed. */
function englishProseWords(value: string): string[] {
    const stripped = value
        // ICU placeholders, innermost first, so `{n, plural, one {…}}` goes too.
        .replace(/\{[^{}]*\}/g, ' ')
        .replace(/\{[^{}]*\}/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/\S+@\S+/g, ' ');
    // A lowercase word standing on its own: not glued to a digit, an
    // underscore or a hyphen, and not part of a `:`/`.`-joined code token
    // (`cpe:2.3:a:vendor`), though a word may END a sentence with `.` or `:`.
    const word = /(?<![A-Za-z0-9_:\-./])[a-z]{3,}(?![A-Za-z0-9_\-]|[:.][A-Za-z0-9])/g;
    return stripped.match(word) ?? [];
}

function readsAsEnglish(value: string): boolean {
    return ENGLISH_UI_WORDS.has(value.trim()) || englishProseWords(value).length > 0;
}

/**
 * Bulgarian values that are deliberately the English text, and why. Keep this
 * short: every entry is a string a Bulgarian reader sees in English.
 */
const KEPT_IN_ENGLISH: Readonly<Record<string, string>> = {
    'securityTesting.filterEnums.source.GITLEAKS':
        'Product name. The tool spells itself in lowercase.',
    'automation.ruleBuilder.agentInputMappingPlaceholder':
        'An example of the literal `field: field` lines the user types, which name schema fields.',
    'agents.orphanPass.servicePrincipal':
        'Owner decision 2026-10-30 (#4553): "service principal" stays Microsoft\'s English term, as in Microsoft\'s Bulgarian documentation, and the line has nothing else to translate.',
};

describe('Bulgarian copy is Bulgarian (#4553)', () => {
    const en = flatten(read('en'));
    const bg = flatten(read('bg'));

    const untranslated = [...bg]
        .filter(([key, value]) => en.get(key) === value && !CYRILLIC.test(value) && readsAsEnglish(value))
        .map(([key]) => key)
        .sort();

    it('no Bulgarian value is the English sentence, except the named ones', () => {
        const kept = Object.keys(KEPT_IN_ENGLISH).sort();
        const unexpected = untranslated.filter((k) => !(k in KEPT_IN_ENGLISH));
        const stale = kept.filter((k) => !untranslated.includes(k));
        expect({ unexpected, stale }).toEqual({ unexpected: [], stale: [] });
    });

    it('measured a real population, not an empty file', () => {
        expect(bg.size).toBeGreaterThan(10_000);
        expect(en.size).toBe(bg.size);
    });

    describe('the detector', () => {
        it.each([
            '{n} failed the malware scan',
            'Exported — but {count} evidence file(s) were left out.',
            'Type {name} to confirm',
            'Entra service principal',
            'Undo',
        ])('reads %p as English', (value) => {
            expect(readsAsEnglish(value)).toBe(true);
        });

        it.each([
            'Microsoft Entra ID',
            'SOC 2',
            'v{version}',
            '{from} → {to}',
            '{count}/2000',
            'https://…',
            'auditor@example.com',
            'cpe:2.3:a:vendor:product:version',
            '{n, plural, one {# файл} other {# файла}}',
            'CVE-2024-12345',
        ])('does not read %p as English', (value) => {
            expect(readsAsEnglish(value)).toBe(false);
        });
    });
});
