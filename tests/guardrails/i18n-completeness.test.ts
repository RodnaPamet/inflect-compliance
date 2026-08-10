/**
 * GAP-19 — i18n locale completeness guardrail.
 *
 * Locks in the invariant that every locale under `messages/` has
 * exactly the same keyset as `messages/en.json` (the canonical
 * source of truth) AND that interpolation placeholders match per
 * key. Drift accumulates fast in i18n — a feature ships in English,
 * the translator pass slips, the UI silently falls back to the key
 * name in production. This test catches that at PR-review time.
 *
 * Four failure modes covered:
 *
 *   • MISSING — key exists in `en.json` but not in another locale.
 *     The most common drift mode and the one a feature PR is most
 *     likely to introduce.
 *
 *   • ORPHAN — key exists in another locale but not in `en.json`.
 *     Usually a stale rename: someone refactored an English key
 *     and left the old one in the translation file.
 *
 *   • PLACEHOLDER DRIFT — the same key holds different `{var}`
 *     tokens between locales (e.g. en uses `{count}`, bg uses
 *     `{number}`). next-intl will silently fail to interpolate
 *     when the placeholders disagree, leaving raw `{count}` in
 *     the rendered output. Catch it here.
 *
 *   • DUPLICATE — the same key declared twice inside one object.
 *     `JSON.parse` keeps the last one silently, which makes this
 *     invisible to MISSING / ORPHAN / DRIFT (all three read the
 *     PARSED object, where the losers no longer exist) while the
 *     key it was meant to define renders as a raw dotted name in
 *     the UI. Detected over the file TEXT — see `duplicateKeys`.
 *
 * Output is actionable: every failure block lists the offending
 * keys grouped by their top-level namespace, with the English
 * source value beside them so a translator can act without opening
 * the JSON file.
 *
 * Companion CLI: `node scripts/i18n-diff.mjs --check` runs the
 * same checks from a developer shell. The TS guardrail and the
 * script duplicate the flatten + diff logic (~20 lines) by design
 * — the script is a Node-native CLI for developers, the test is a
 * Jest module-graph node. Sharing across the boundary would force
 * either tsx-loading from a script or .mjs-importing from Jest;
 * neither is worth the win for a logic block this small.
 */
import * as fs from 'fs';
import * as path from 'path';

const MESSAGES_DIR = path.resolve(__dirname, '../../messages');

type LocaleMap = Map<string, unknown>;

function flatten(obj: Record<string, unknown>, prefix = ''): LocaleMap {
    const out: LocaleMap = new Map();
    for (const [k, v] of Object.entries(obj)) {
        const dotted = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === 'object' && !Array.isArray(v)) {
            for (const [kk, vv] of flatten(v as Record<string, unknown>, dotted)) {
                out.set(kk, vv);
            }
        } else {
            out.set(dotted, v);
        }
    }
    return out;
}

function placeholders(value: unknown): string[] {
    if (typeof value !== 'string') return [];
    // ICU/next-intl placeholders: {name}, {count, plural, ...}.
    // We only care about the variable name (first capture group),
    // not the formatting tail — same behaviour matters across
    // locales regardless of plural rules.
    return [...value.matchAll(/\{([a-zA-Z0-9_]+)/g)].map((m) => m[1]).sort();
}

/**
 * Find keys declared more than once inside the SAME JSON object.
 *
 * `JSON.parse` accepts duplicates and silently keeps the last one, so
 * this is invisible to every other check in this file: the parsed
 * keyset is identical across locales (parity passes), the file lints,
 * and TypeScript never sees message files at all. The only symptom is
 * at runtime, where next-intl cannot resolve the key that lost and
 * renders its dotted name — `kri.saveError` — to the user.
 *
 * It is an easy mistake to make from a script: an insertion anchored on
 * a sibling key name that is not unique lands the new entry in the
 * wrong namespace, which reads as a duplicate in the object it landed
 * in and as a MISSING key in the one it was meant for. Three such
 * strays accumulated in `risks.correlations` before this check existed.
 *
 * Detection has to run over the raw text — by the time `JSON.parse`
 * returns, the losers are gone. The scan below walks characters,
 * tracking string literals (with escapes) so a `{` or `"` inside a
 * translated value is never mistaken for structure.
 */
function duplicateKeys(text: string): string[] {
    const dupes: string[] = [];
    const stack: { keys: Set<string> | null; name: string }[] = [];
    let pendingName = '';
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (c === '"') {
            let j = i + 1;
            let literal = '';
            while (j < text.length) {
                if (text[j] === '\\') { literal += text[j + 1]; j += 2; continue; }
                if (text[j] === '"') break;
                literal += text[j];
                j++;
            }
            // A string is a KEY iff the next non-space char is a colon
            // and we are inside an object (not an array).
            let k = j + 1;
            while (k < text.length && /\s/.test(text[k])) k++;
            const top = stack[stack.length - 1];
            if (text[k] === ':' && top && top.keys) {
                const dotted = [...stack.map((s) => s.name).filter(Boolean), literal].join('.');
                if (top.keys.has(literal)) dupes.push(dotted);
                else top.keys.add(literal);
                pendingName = literal;
            }
            i = j + 1;
            continue;
        }
        if (c === '{' || c === '[') {
            stack.push({ keys: c === '{' ? new Set<string>() : null, name: pendingName });
            pendingName = '';
        } else if (c === '}' || c === ']') {
            stack.pop();
        }
        i++;
    }
    return dupes;
}

function readLocale(name: string): LocaleMap {
    const p = path.join(MESSAGES_DIR, `${name}.json`);
    return flatten(JSON.parse(fs.readFileSync(p, 'utf-8')));
}

/**
 * Group dotted keys by their top-level segment ("common", "risks",
 * "ui", ...) for readable error output. Within each group the keys
 * are sorted alphabetically.
 */
function groupByNamespace(keys: string[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    for (const k of keys.sort()) {
        const ns = k.split('.', 1)[0];
        const arr = grouped.get(ns) ?? [];
        arr.push(k);
        grouped.set(ns, arr);
    }
    return grouped;
}

function formatMissing(
    missing: string[],
    en: LocaleMap,
    headline: string,
): string {
    if (missing.length === 0) return '';
    const lines = ['', headline, ''];
    const grouped = groupByNamespace(missing);
    for (const [ns, keys] of [...grouped.entries()].sort()) {
        lines.push(`  [${ns}]`);
        for (const k of keys) {
            const enVal = en.get(k);
            const display =
                typeof enVal === 'string'
                    ? enVal.length > 80
                        ? enVal.slice(0, 80) + '…'
                        : enVal
                    : JSON.stringify(enVal);
            lines.push(`    ${k}    en="${display}"`);
        }
    }
    return lines.join('\n');
}

function formatOrphan(orphan: string[], localeName: string, locale: LocaleMap): string {
    if (orphan.length === 0) return '';
    const lines = ['', `  ORPHAN keys in ${localeName}.json (absent from en.json — usually a stale rename):`, ''];
    const grouped = groupByNamespace(orphan);
    for (const [ns, keys] of [...grouped.entries()].sort()) {
        lines.push(`  [${ns}]`);
        for (const k of keys) {
            const v = locale.get(k);
            const display = typeof v === 'string' ? (v.length > 80 ? v.slice(0, 80) + '…' : v) : JSON.stringify(v);
            lines.push(`    ${k}    ${localeName}="${display}"`);
        }
    }
    return lines.join('\n');
}

function formatDrift(
    drift: { key: string; en: string[]; locale: string[] }[],
    localeName: string,
): string {
    if (drift.length === 0) return '';
    const lines = ['', `  PLACEHOLDER DRIFT (same key, different {var} tokens between en and ${localeName}):`, ''];
    for (const d of drift) {
        lines.push(`    ${d.key}    en=[${d.en.join(', ')}]   ${localeName}=[${d.locale.join(', ')}]`);
    }
    return lines.join('\n');
}

// ─── Locale enumeration ─────────────────────────────────────────

const localeFiles = fs
    .readdirSync(MESSAGES_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'en.json')
    .map((f) => path.basename(f, '.json'));

// Sanity: there is at least one non-en locale to compare against.
// If a future change drops bg.json without adding another locale,
// this fails — that's the right signal because we'd otherwise be
// running a no-op guardrail.
describe('GAP-19 — i18n completeness', () => {
    it('messages/ contains at least one non-English locale to compare', () => {
        expect(localeFiles.length).toBeGreaterThan(0);
    });

    const en = readLocale('en');

    for (const localeName of localeFiles) {
        describe(`${localeName}.json vs en.json`, () => {
            const locale = readLocale(localeName);
            const enKeys = new Set(en.keys());
            const localeKeys = new Set(locale.keys());

            it('has no keys missing from en (every en key is translated)', () => {
                const missing = [...enKeys].filter((k) => !localeKeys.has(k));
                if (missing.length > 0) {
                    throw new Error(
                        `${localeName}.json is missing ${missing.length} translation(s) present in en.json:` +
                            formatMissing(
                                missing,
                                en,
                                `  Add these to messages/${localeName}.json (preserve nesting + interpolation placeholders):`,
                            ) +
                            `\n\nRun \`node scripts/i18n-diff.mjs\` for the same report from a developer shell.`,
                    );
                }
            });

            it('has no orphan keys (every locale key is also in en)', () => {
                const orphan = [...localeKeys].filter((k) => !enKeys.has(k));
                if (orphan.length > 0) {
                    throw new Error(
                        `${localeName}.json has ${orphan.length} orphan key(s) absent from en.json:` +
                            formatOrphan(orphan, localeName, locale) +
                            `\n\nThe English key was likely renamed without updating ${localeName}.json. ` +
                            `Either add the renamed key to en.json, or delete the orphan from ${localeName}.json.`,
                    );
                }
            });

            it('preserves interpolation placeholders across locales', () => {
                const drift: { key: string; en: string[]; locale: string[] }[] = [];
                for (const k of enKeys) {
                    if (!localeKeys.has(k)) continue;
                    const enP = placeholders(en.get(k));
                    const lcP = placeholders(locale.get(k));
                    if (enP.join(',') !== lcP.join(',')) {
                        drift.push({ key: k, en: enP, locale: lcP });
                    }
                }
                if (drift.length > 0) {
                    throw new Error(
                        `${localeName}.json has ${drift.length} key(s) with mismatched {var} placeholders:` +
                            formatDrift(drift, localeName) +
                            `\n\nnext-intl silently fails to interpolate when placeholders disagree, ` +
                            `leaving raw "{var}" tokens in the rendered output. ` +
                            `Update the locale's value to use the same placeholder names as en.json.`,
                    );
                }
            });
        });
    }
});

// ─── DUPLICATE keys (parity-invisible; see duplicateKeys above) ──
describe('GAP-19 — i18n duplicate keys', () => {
    for (const name of ['en', ...localeFiles]) {
        it(`${name}.json declares every key exactly once per object`, () => {
            const text = fs.readFileSync(path.join(MESSAGES_DIR, `${name}.json`), 'utf-8');
            const dupes = duplicateKeys(text);
            if (dupes.length > 0) {
                throw new Error(
                    `\n  DUPLICATE keys in ${name}.json — JSON.parse keeps only the LAST,\n` +
                        `  so the others render as raw key names in the UI:\n\n` +
                        dupes.map((d) => `    ${d}`).join('\n') +
                        `\n\n  Usually a key inserted into the wrong namespace. Move it to the\n` +
                        `  object the calling component's useTranslations(ns) actually reads.\n`,
                );
            }
            expect(dupes).toEqual([]);
        });
    }
});

// ─── Self-test: prove the diff detector actually fires ──────────
//
// Without this block, a future regression that breaks the
// flatten/compare logic would let bad locales slip through with
// the test silently still "passing". The self-test runs the same
// flatten + comparison against an in-memory mismatched pair and
// asserts the detection is real.
describe('GAP-19 — i18n completeness self-test', () => {
    const fakeEn = flatten({
        common: { save: 'Save', cancel: 'Cancel' },
        risks: { score: 'Score', count: '{count} risks' },
    } as Record<string, unknown>);

    it('detects MISSING when locale lacks an en key', () => {
        const fakeLocale = flatten({
            common: { save: 'Запази' /* cancel intentionally absent */ },
            risks: { score: 'Резултат', count: '{count} риска' },
        } as Record<string, unknown>);
        const missing = [...fakeEn.keys()].filter((k) => !fakeLocale.has(k));
        expect(missing).toEqual(['common.cancel']);
    });

    it('detects ORPHAN when locale carries a non-en key', () => {
        const fakeLocale = flatten({
            common: { save: 'Запази', cancel: 'Отказ', orphan: 'X' },
            risks: { score: 'Резултат', count: '{count} риска' },
        } as Record<string, unknown>);
        const orphan = [...fakeLocale.keys()].filter((k) => !fakeEn.has(k));
        expect(orphan).toEqual(['common.orphan']);
    });

    it('detects PLACEHOLDER DRIFT when same key uses different {var}', () => {
        const fakeLocale = flatten({
            common: { save: 'Запази', cancel: 'Отказ' },
            risks: { score: 'Резултат', count: '{number} риска' /* drift */ },
        } as Record<string, unknown>);
        const enP = placeholders(fakeEn.get('risks.count'));
        const lcP = placeholders(fakeLocale.get('risks.count'));
        expect(enP).toEqual(['count']);
        expect(lcP).toEqual(['number']);
        expect(enP.join(',')).not.toEqual(lcP.join(','));
    });

    it('detects a DUPLICATE key that JSON.parse would silently swallow', () => {
        const text = `{
  "risks": {
    "correlations": { "saveError": "correlations copy" },
    "kri": { "saveError": "kri copy" }
  }
}`;
        expect(duplicateKeys(text)).toEqual([]);

        // The real regression: the kri entry lands in the correlations
        // object. JSON.parse yields ONE saveError, so a parsed-object
        // check cannot see it — and `risks.kri.saveError` is simply gone.
        const misfiled = `{
  "risks": {
    "correlations": { "saveError": "correlations copy", "saveError": "kri copy" },
    "kri": { "title": "KRI" }
  }
}`;
        expect(duplicateKeys(misfiled)).toEqual(['risks.correlations.saveError']);
        expect(Object.keys(JSON.parse(misfiled).risks.correlations)).toEqual(['saveError']);
    });

    it('does not mistake braces, colons or quotes INSIDE a value for structure', () => {
        const text = `{
  "a": { "tpl": "use {count} of \\"these\\": ok", "b": "x" },
  "c": [ "not: a key", { "d": "1", "d": "2" } ]
}`;
        // Only the genuine duplicate inside the array's object is reported.
        expect(duplicateKeys(text)).toEqual(['c.d']);
    });

    it('placeholder extraction tolerates ICU formatting tail', () => {
        // {count, plural, one {# risk} other {# risks}} — only the
        // var name matters; the formatting tail is locale-specific
        // and intentionally ignored by the comparison.
        const both = '{count, plural, one {# risk} other {# risks}}';
        expect(placeholders(both)).toEqual(['count']);
    });
});
