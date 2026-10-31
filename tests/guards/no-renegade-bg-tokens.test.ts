/**
 * Roadmap-6 PR-4 — eradicate renegade `bg-bg-*` tokens.
 *
 * The class `bg-bg-surface` was used at 5 callsites (invite
 * pages, tenants picker). It does NOT exist in `tokens.css` —
 * Tailwind compiled it to a no-op (browser default), giving the
 * affected surfaces an unintentional white/transparent
 * background. Five surface bugs the user saw and we didn't.
 *
 * What lands
 *
 *   All 5 callsites migrated `bg-bg-surface` → `bg-bg-default`
 *   (the card surface tone). The visual changes from "wrong by
 *   accident" to "right by design".
 *
 * What this ratchet locks
 *
 *   No `bg-bg-X` token may appear in `.tsx` files unless the
 *   token `--bg-X` is defined in `src/styles/tokens.css` (or
 *   one of the documented in-config tokens like `bg-bg-page` /
 *   `bg-bg-overlay`). Silent no-ops are silent regressions.
 *
 * Generated tokens are detected by reading `tokens.css` directly
 * and confirming each `bg-bg-X` callsite resolves to a real CSS
 * variable.
 */
import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

function readDefinedBgTokens(): Set<string> {
    const tokens = new Set<string>();
    const tokensCss = fs.readFileSync(
        path.join(ROOT, 'src/styles/tokens.css'),
        'utf-8',
    );
    // Match `--bg-X: ...;` declarations.
    for (const m of tokensCss.matchAll(/--bg-([a-z][a-z0-9-]*)\s*:/g)) {
        tokens.add(m[1]);
    }
    // The Tailwind config also exposes a few `bg-*` aliases via
    // `colors.bg.X`. Check tailwind.config.js for additional names
    // declared in the `bg:` color block.
    const tw = fs.readFileSync(path.join(ROOT, 'tailwind.config.js'), 'utf-8');
    const bgBlockMatch = tw.match(/bg:\s*\{([\s\S]*?)\n\s*\},/);
    if (bgBlockMatch) {
        for (const m of bgBlockMatch[1].matchAll(/['"]?([a-z][a-z0-9-]*)['"]?:\s*['"]var\(--bg-/g)) {
            tokens.add(m[1]);
        }
        for (const m of bgBlockMatch[1].matchAll(/^\s*([a-z][a-z0-9-]*):\s*['"]/gm)) {
            tokens.add(m[1]);
        }
    }
    return tokens;
}

interface Offence {
    file: string;
    line: number;
    token: string;
    snippet: string;
}

describe('No renegade bg-bg-* tokens (Roadmap-6 PR-4)', () => {
    it('every bg-bg-X token used in src/ is defined in tokens.css', () => {
        const defined = readDefinedBgTokens();
        // Tokens always present in tokens.css. Add common Tailwind-
        // scale colors that legitimately appear via `bg-bg-error/N`
        // alpha-suffixed callsites — those are still real.
        // The detector reads opacity suffixes off the class
        // automatically.
        const offenders: Offence[] = [];
        const walk = (dir: string) => {
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next')
                        continue;
                    walk(full);
                    continue;
                }
                if (!/\.tsx$/.test(e.name)) continue;
                const rel = path.relative(ROOT, full);
                const raw = fs.readFileSync(full, 'utf-8');
                const stripped = codeOf(raw);
                const lines = stripped.split('\n');
                lines.forEach((line, i) => {
                    // Match `bg-bg-X` (with optional /N alpha suffix +
                    // optional `-emphasis` modifier). Matches the
                    // canonical Tailwind class shape.
                    for (const m of line.matchAll(
                        /\bbg-bg-([a-z][a-z0-9-]*)(?:\/[0-9]+)?\b/g,
                    )) {
                        const token = m[1];
                        // `bg-bg-error-emphasis` → token = "error-emphasis".
                        // We accept any token whose root is defined.
                        const root = token.replace(/-emphasis$/, '');
                        if (defined.has(token) || defined.has(root)) continue;
                        offenders.push({
                            file: rel,
                            line: i + 1,
                            token: m[0],
                            snippet: line.trim().slice(0, 200),
                        });
                    }
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            const lines = offenders
                .map(
                    (o) =>
                        `  ${o.file}:${o.line} — ${o.token}\n    ${o.snippet}`,
                )
                .join('\n');
            throw new Error(
                `Renegade bg-bg-* tokens detected. Each Tailwind class \`bg-bg-X\` must reference a real \`--bg-X\` definition in tokens.css (or be the documented \`bg-bg-page\` / \`bg-bg-overlay\` etc). Silent no-ops are silent regressions:\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
