/**
 * Every translatable string the shipped catalogues hold (#5996).
 *
 * One reader for the coverage ratchet and for the export command, so "what
 * needs translating" has a single definition. It reads the catalogue files as
 * data and collects the values of text-bearing keys; a string is attributed to
 * the catalogue FAMILY of the file it is in, and a string two families share
 * belongs to `shared`, so it is translated once.
 */
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { GENERIC_TEMPLATE_TASK_TITLES } from '../../prisma/generic-template-tasks';
import { contentKey } from '../../src/lib/content-i18n/limits';

const ROOT = path.join(__dirname, '..', '..');

/** Keys whose string value is text a person reads. */
const TEXT_KEYS: ReadonlySet<string> = new Set([
    'name', 'title', 'description', 'summary', 'objective', 'guidance', 'annotation', 'rationale',
    'category', 'section', 'text', 'hint', 'prompt', 'label', 'question', 'helpText', 'evidenceHint',
    'suggestedRole', 'en',
]);
/**
 * The subset of `TEXT_KEYS` that is a HEADING: what lists, menus and pickers
 * show. Translated first across every family (owner decision 2026-11-27);
 * descriptions, steps and guidance follow family by family.
 */
const HEADING_KEYS: ReadonlySet<string> = new Set(['name', 'title', 'category', 'section', 'label', 'suggestedRole']);

/** Keys whose value is a list of strings a person reads. */
const TEXT_LIST_KEYS: ReadonlySet<string> = new Set(['checklist', 'artifacts', 'steps', 'options', 'examples']);

/** Filename → family, first match wins. A file that matches nothing is its own family. */
const FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
    [/aiuc/, 'aiuc-1'],
    [/asvs/, 'owasp-asvs'],
    [/aisvs/, 'owasp-aisvs'],
    [/owasp[-_]asi|owasp-agentic|agent-risk/, 'owasp-agentic'],
    [/cis/, 'cis-v8'],
    [/coso/, 'coso-icf'],
    [/dora/, 'dora'],
    [/eu[-_]ai[-_]act|ai-governance/, 'eu-ai-act'],
    [/eu-uas/, 'eu-uas-ops'],
    [/finos/, 'finos-aigf'],
    [/gdpr/, 'gdpr'],
    [/imda/, 'imda-mgf'],
    [/iso[-_]?27701/, 'iso-27701'],
    [/iso[-_]?27001/, 'iso-27001'],
    [/iso[-_]?_?42001/, 'iso-42001'],
    [/iso(9001|28000|39001)/, 'iso-clauses'],
    [/nis2/, 'nis2'],
    [/nist-csf/, 'nist-csf'],
    [/nist[-_]privacy|risk-templates-privacy/, 'nist-privacy'],
    [/ssdf/, 'nist-ssdf'],
    [/soc2/, 'soc2'],
    [/internal-controls/, 'internal-controls'],
    [/policy-templates/, 'policy-templates'],
    [/vendor-questionnaire/, 'vendor-questionnaires'],
    [/risk-templates-generic/, 'generic'],
];

export function familyOf(file: string): string {
    const base = path.basename(file).toLowerCase();
    for (const [re, family] of FAMILIES) if (re.test(base)) return family;
    return base.replace(/\.(json|ya?ml)$/, '');
}

/** Text worth translating: has a letter, and is not an identifier, URN or URL. */
function isProse(value: string): boolean {
    const v = value.trim();
    if (v.length < 2 || !/[A-Za-z]/.test(v)) return false;
    if (/^(urn:|https?:\/\/)/i.test(v)) return false;
    if (/^[A-Z0-9_.:-]+$/.test(v)) return false; // codes and enum values
    return true;
}

function collect(node: unknown, out: Set<string>, headings?: Set<string>): void {
    if (Array.isArray(node)) {
        for (const item of node) collect(item, out, headings);
        return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (typeof value === 'string') {
            if (TEXT_KEYS.has(key) && isProse(value)) {
                out.add(contentKey(value));
                if (HEADING_KEYS.has(key)) headings?.add(contentKey(value));
            }
        } else if (Array.isArray(value) && TEXT_LIST_KEYS.has(key)) {
            for (const item of value) {
                if (typeof item === 'string' && isProse(item)) out.add(contentKey(item));
                else collect(item, out, headings);
            }
        } else {
            collect(value, out, headings);
        }
    }
}

function filesIn(dir: string, extensions: readonly string[]): string[] {
    const abs = path.join(ROOT, dir);
    return fs
        .readdirSync(abs)
        .filter((f) => extensions.some((e) => f.endsWith(e)))
        .sort()
        .map((f) => path.join(abs, f));
}

/** Every catalogue string that is a heading somewhere (see `HEADING_KEYS`). */
export function catalogueHeadings(): Set<string> {
    const headings = new Set<string>();
    const sink = new Set<string>();
    for (const file of filesIn('prisma/fixtures', ['.json'])) collect(JSON.parse(fs.readFileSync(file, 'utf8')), sink, headings);
    for (const file of [...filesIn('src/data/libraries', ['.yaml']), ...filesIn('prisma/catalogs', ['.yaml'])]) {
        collect(yaml.load(fs.readFileSync(file, 'utf8')), sink, headings);
    }
    for (const title of GENERIC_TEMPLATE_TASK_TITLES) headings.add(contentKey(title));
    return headings;
}

/** family → its strings, sorted. Strings in two or more families are under `shared` only. */
export function catalogueStrings(): Map<string, string[]> {
    const perFamily = new Map<string, Set<string>>();
    const add = (family: string, strings: Iterable<string>) => {
        const set = perFamily.get(family) ?? new Set<string>();
        for (const s of strings) set.add(s);
        perFamily.set(family, set);
    };

    for (const file of filesIn('prisma/fixtures', ['.json'])) {
        const found = new Set<string>();
        collect(JSON.parse(fs.readFileSync(file, 'utf8')), found);
        add(familyOf(file), found);
    }
    for (const file of [...filesIn('src/data/libraries', ['.yaml']), ...filesIn('prisma/catalogs', ['.yaml'])]) {
        const found = new Set<string>();
        collect(yaml.load(fs.readFileSync(file, 'utf8')), found);
        add(familyOf(file), found);
    }
    add('generic', GENERIC_TEMPLATE_TASK_TITLES.map(contentKey));

    const owners = new Map<string, number>();
    for (const set of perFamily.values()) for (const s of set) owners.set(s, (owners.get(s) ?? 0) + 1);
    const out = new Map<string, string[]>();
    const shared: string[] = [];
    for (const [family, set] of perFamily) {
        const own = [...set].filter((s) => owners.get(s) === 1).sort();
        if (own.length > 0) out.set(family, own);
    }
    for (const [s, n] of owners) if (n > 1) shared.push(s);
    out.set('shared', shared.sort());
    return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
