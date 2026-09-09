/**
 * Every literal `t('…')` key a component calls must resolve in `messages/en.json`.
 *
 * This guard exists because nothing else in CI could see a missing key, and the
 * hole was not hypothetical: an entire tab shipped calling nine keys that were
 * never merged into either locale, and every i18n check stayed green.
 *
 * The reason they stayed green is worth stating, because it is the general
 * shape of the blind spot. `i18n-completeness` and `scripts/i18n-diff.mjs`
 * compare en.json to bg.json — MISSING, ORPHAN, PLACEHOLDER-DRIFT, DUPLICATE —
 * so they answer "do the two locales agree?". Two equally stale files agree
 * perfectly. `i18n-adoption-ratchet` scans SOURCE for hardcoded UI text, so it
 * is satisfied the moment a string is behind a `t()` call and never asks
 * whether that call resolves. Nobody was comparing the code to the catalogue,
 * in either direction, so the failure surfaced as raw dotted key paths rendered
 * in the browser.
 *
 * Scope, stated plainly rather than implied:
 *
 *   • Only files with exactly ONE `useTranslations()` / `getTranslations()`
 *     namespace are checked (328 of 373 today). A file that opens two
 *     namespaces makes `t('x')` ambiguous to a static reader, and guessing
 *     would produce false failures. Those 45 files are NOT covered — this is a
 *     real gap, not a rounding error, and closing it needs per-call binding
 *     analysis rather than a regex.
 *   • Only LITERAL keys. `t(`${prefix}.${state}`)` cannot be resolved
 *     statically, and template-literal lookups are used deliberately in this
 *     codebase (the circuit-breaker posture badges, for one). Those keys are
 *     the ones a rendered test has to cover instead.
 *
 * Comments are stripped before scanning, so prose naming a key path — including
 * the prose above — cannot satisfy or trip the check.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'src');
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8'));

const NAMESPACE_RE =
    /useTranslations\(\s*['"]([^'"]+)['"]\s*\)|getTranslations\(\s*['"]([^'"]+)['"]\s*\)/g;
const CALL_RE = /\bt\(\s*'([A-Za-z0-9_.]+)'/g;

function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function resolves(dotted: string): boolean {
    let node: unknown = EN;
    for (const seg of dotted.split('.')) {
        if (typeof node !== 'object' || node === null || !(seg in (node as object))) return false;
        node = (node as Record<string, unknown>)[seg];
    }
    return true;
}

function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === '.next') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) out.push(full);
    }
    return out;
}

interface Unresolved {
    file: string;
    key: string;
}

function scan(): { unresolved: Unresolved[]; filesChecked: number; keysChecked: number } {
    const unresolved: Unresolved[] = [];
    let filesChecked = 0;
    let keysChecked = 0;

    for (const file of walk(SRC)) {
        const src = stripComments(fs.readFileSync(file, 'utf8'));
        const namespaces = [...src.matchAll(NAMESPACE_RE)].map((m) => m[1] ?? m[2]);
        if (namespaces.length === 0) continue;
        if (new Set(namespaces).size !== 1) continue; // ambiguous — see header
        const base = namespaces[0];
        filesChecked++;
        for (const m of src.matchAll(CALL_RE)) {
            keysChecked++;
            const full = `${base}.${m[1]}`;
            if (!resolves(full)) {
                unresolved.push({ file: path.relative(ROOT, file), key: full });
            }
        }
    }
    return { unresolved, filesChecked, keysChecked };
}

describe('i18n — every literal t() key resolves in en.json', () => {
    const { unresolved, filesChecked, keysChecked } = scan();

    it('the scan actually reached the code it claims to cover', () => {
        // Positive companion. A scan that silently matched nothing would report
        // zero unresolved keys and look identical to a clean tree — the exact
        // ambiguity that let the missing keys through in the first place.
        expect(filesChecked).toBeGreaterThan(250);
        expect(keysChecked).toBeGreaterThan(4000);
    });

    it('resolves a key that is known to exist, and rejects one that is not', () => {
        // Proves the resolver itself works, so a green run means "checked and
        // found nothing" rather than "the resolver returns true for anything".
        expect(resolves('admin.agentDetail.tabOverview')).toBe(true);
        expect(resolves('admin.agentDetail.__definitely_not_a_key__')).toBe(false);
    });

    it('no component calls a key the catalogue does not have', () => {
        const sample = unresolved
            .slice(0, 20)
            .map((u) => `  ${u.file}\n    -> ${u.key}`)
            .join('\n');
        expect(
            unresolved.length === 0
                ? ''
                : `${unresolved.length} t() call(s) reference a key absent from messages/en.json.\n` +
                  `These render as the raw dotted path in the UI, in every locale.\n\n${sample}`,
        ).toBe('');
    });
});
