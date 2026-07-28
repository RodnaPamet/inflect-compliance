/**
 * Semantic content-token validity.
 *
 * `text-content-danger` shipped in four files and rendered NOTHING — there
 * is no `danger` key under `content` in tailwind.config.js, so Tailwind
 * generated no rule and those elements silently inherited body colour. The
 * failure mode is invisible: no build error, no console warning, no missing
 * class in the DOM. It just quietly is not red.
 *
 * The token names are the source of truth, read from the config at test
 * time rather than hardcoded, so adding a legitimate new tone here does not
 * require touching this file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/** Pull the `content` palette keys straight out of the Tailwind config. */
function validContentTokens(): Set<string> {
    const cfg = fs.readFileSync(path.join(ROOT, 'tailwind.config.js'), 'utf8');
    const block = cfg.slice(cfg.indexOf('content: {'));
    const end = block.indexOf('},');
    const keys = [...block.slice(0, end).matchAll(/^\s*([a-zA-Z][\w-]*):/gm)].map(
        (m) => m[1],
    );
    return new Set(keys.filter((k) => k !== 'content'));
}

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(tsx?|jsx?)$/.test(entry.name)) out.push(full);
    }
    return out;
}

describe('semantic content tokens resolve to a real Tailwind key', () => {
    const tokens = validContentTokens();

    it('the config exposes the tones the codebase relies on', () => {
        // Sanity check on the parser itself — if this regex ever stops
        // finding keys, every assertion below would vacuously pass.
        expect(tokens.size).toBeGreaterThan(3);
        expect(tokens.has('error')).toBe(true);
        expect(tokens.has('muted')).toBe(true);
    });

    it('has no `danger` tone — `error` is the name', () => {
        expect(tokens.has('danger')).toBe(false);
    });

    it('no source file references a content-* token that does not exist', () => {
        const offenders: string[] = [];
        const pattern = /\b(?:text|bg|border)-content-([a-z][\w-]*)/g;

        for (const file of walk(path.join(ROOT, 'src'))) {
            const src = fs.readFileSync(file, 'utf8');
            for (const match of src.matchAll(pattern)) {
                const tone = match[1];
                if (!tokens.has(tone) && !KNOWN_DEAD_TONES.has(tone)) {
                    offenders.push(`${path.relative(ROOT, file)} → ${match[0]}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it('the known-dead baseline only ever shrinks', () => {
        // A tone leaves this list one of two ways: the class is replaced with
        // a real token, or the token is added to tailwind.config.js. Either
        // way the entry goes in the same diff. Nothing is added here without
        // a written reason.
        expect(KNOWN_DEAD_TONES.size).toBeLessThanOrEqual(2);
    });
});

/**
 * Tones referenced in source that resolve to nothing today.
 *
 * `danger` was the third and is now fixed — it was 6 uses across 4 files,
 * all replaced with `error`, which is what the palette actually calls that
 * tone.
 *
 * These two are a larger, separate problem and are recorded rather than
 * fixed here:
 *
 *   • `link` — 27 uses. `--content-link` is never defined; globals.css
 *     references it exactly once, with a `var(--brand-default)` fallback
 *     doing the real work. Wiring `link` into the config would make 27
 *     currently-inherited elements render brand-coloured, which is a visual
 *     design decision, not a mechanical fix.
 *   • `accent` — 1 use, same situation.
 *
 * They are quarantined so the guard still blocks NEW dead tones today.
 */
const KNOWN_DEAD_TONES = new Set(['link', 'accent']);
