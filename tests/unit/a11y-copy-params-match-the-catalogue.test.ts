/**
 * A `t()` CALL PASSES EXACTLY THE PLACEHOLDERS ITS KEY DECLARES (#3209).
 *
 * The #3209 tranche moved a11y templates like
 * `` `Expand ${title} panel` `` into `common.ui` keys. Three failure modes
 * survive that move, and only one of them was already guarded:
 *
 *   en/bg key parity, orphans, and placeholder parity BETWEEN LOCALES
 *     — covered by `i18n-completeness`.
 *
 *   a component passing a param the key does not declare
 *     — NOT covered, and it ships silently: next-intl leaves an unmatched
 *       `{label}` in the output, so a screen reader reads the brace. Six of
 *       the ten strings this tranche moved are asserted by NO existing test,
 *       so nothing else would catch it.
 *
 * This reads the call sites out of source and compares each one's object keys
 * against the placeholders in `messages/en.json`. It is deliberately a source
 * scan rather than a render: the components need providers and props that have
 * nothing to do with the property under test, and a render test for each would
 * be six fixtures certifying one invariant.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repoRelativeFiles } from '../helpers/repo-files';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const en = JSON.parse(fs.readFileSync(path.join(ROOT, 'messages/en.json'), 'utf8')) as Record<
    string,
    unknown
>;

/** `common.ui` → the object, so a key's placeholders can be read. */
function namespaceObject(ns: string): Record<string, string> {
    const o = ns.split('.').reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], en);
    expect(typeof o).toBe('object');
    return o as Record<string, string>;
}

const placeholdersOf = (s: string): Set<string> =>
    new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

/**
 * Every `t('key', { … })` in the repo whose namespace is `common.ui`.
 *
 * Matched on the SOURCE rather than by rendering, and the population is
 * printed below so a scan that matched nothing cannot read as a pass.
 */
const skipped: string[] = [];

function callSites(): { file: string; key: string; params: Set<string> }[] {
    const out: { file: string; key: string; params: Set<string> }[] = [];
    for (const rel of repoRelativeFiles().filter((f) => f.startsWith('src/') && f.endsWith('.tsx'))) {
        // COMMENTS STRIPPED. The first draft of this scanned raw source and
        // reported `ListPageShell.tsx → common.ui.count` — a `t('count', …)`
        // inside a DOCBLOCK, not a call. A comment hit is the classic false
        // positive for a source scan, and this repo has a helper for it.
        const src = codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
        if (!src.includes("useTranslations('common.ui')")) continue;
        // ONE NAMESPACE PER FILE, or this cannot attribute a `t()` call.
        // `EvidenceGallery.tsx` binds three, so every `t()` in it would be
        // checked against `common.ui` and fail for keys that live elsewhere.
        // Skipped rather than guessed, and COUNTED so the narrowing is visible
        // instead of silently shrinking the population.
        const namespaces = new Set(
            [...src.matchAll(/useTranslations\('([^']+)'\)/g)].map((m) => m[1]),
        );
        if (namespaces.size > 1) {
            skipped.push(rel);
            continue;
        }
        // `t('key', { a: …, b: … })` — the object's TOP-LEVEL keys only.
        for (const m of src.matchAll(/\bt\('([A-Za-z0-9_]+)'\s*,\s*\{([^}]*)\}/g)) {
            const params = new Set(
                [...m[2].matchAll(/(?:^|[,{\s])([A-Za-z0-9_]+)\s*:/g)].map((p) => p[1]),
            );
            // shorthand `{ title }` carries no colon
            for (const p of m[2].split(',')) {
                const bare = p.trim();
                if (/^[A-Za-z0-9_]+$/.test(bare)) params.add(bare);
            }
            out.push({ file: rel, key: m[1], params });
        }
    }
    return out;
}

describe("a common.ui t() call passes exactly its key's placeholders (#3209)", () => {
    const sites = callSites();

    it('found call sites at all — a clean result over zero says nothing', () => {
        expect(sites.length).toBeGreaterThanOrEqual(10);
    });

    it('reports what it could not attribute, so the population is honest', () => {
        // Not an assertion that the list is empty — it is not. The point is
        // that a file skipped for multiple namespaces is NAMED, so nobody
        // reads this suite as covering it.
        expect(Array.isArray(skipped)).toBe(true);
        if (skipped.length) {
            console.info(`[#3209] not attributed (multiple namespaces): ${skipped.join(', ')}`);
        }
    });

    it('every key a call site names exists in common.ui', () => {
        const ui = namespaceObject('common.ui');
        const missing = sites.filter((s) => typeof ui[s.key] !== 'string');
        expect(missing.map((m) => `${m.file} → common.ui.${m.key}`)).toEqual([]);
    });

    it('and passes exactly the placeholders that key declares', () => {
        const ui = namespaceObject('common.ui');
        const wrong: string[] = [];
        for (const s of sites) {
            const declared = placeholdersOf(ui[s.key] ?? '');
            const passed = s.params;
            const missing = [...declared].filter((d) => !passed.has(d));
            const extra = [...passed].filter((p) => !declared.has(p));
            if (missing.length || extra.length) {
                wrong.push(
                    `${s.file} → common.ui.${s.key}: ` +
                        `${missing.length ? `missing ${missing.join(', ')}` : ''}` +
                        `${missing.length && extra.length ? '; ' : ''}` +
                        `${extra.length ? `unexpected ${extra.join(', ')}` : ''}`,
                );
            }
        }
        // An unmatched placeholder is not an error next-intl raises — it leaves
        // the literal `{name}` in the string, which a screen reader reads out.
        expect(wrong).toEqual([]);
    });
});
