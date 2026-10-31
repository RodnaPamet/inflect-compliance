/**
 * Roadmap-5 PR-5 — hover recipe discipline.
 *
 * The cursor traversed the product across nine different hover
 * tones on muted backgrounds:
 *
 *   hover:bg-bg-muted        × 61 (canonical click-target)
 *   hover:bg-bg-muted/50     × 26 (canonical row/card)
 *   hover:bg-bg-muted/40     × 3
 *   hover:bg-bg-muted/30     × 2
 *   hover:bg-bg-elevated/50  × 2
 *   hover:bg-bg-elevated/80  × 1
 *   hover:bg-bg-elevated/20  × 1
 *   hover:bg-bg-elevated     × 1
 *   hover:bg-bg-subtle       × 1
 *
 * Nine textures for two intents — "this row reacts" vs "this is
 * clickable." Twelve drift sites migrated; two recipes survive.
 *
 * Two recipes
 *
 *   • Row / card hover (subtle background change indicating "this
 *     row is hoverable / selectable"):
 *
 *         hover:bg-bg-muted/50
 *
 *     ~50% opacity on the muted token. Quiet enough to not feel
 *     like a button, loud enough to confirm interactivity.
 *
 *   • Click-target hover (button-shaped element, menu item, ghost
 *     button, icon button, sidebar nav item):
 *
 *         hover:bg-bg-muted
 *
 *     Solid muted background. Says "this is clickable."
 *
 * What this ratchet locks
 *
 *   No `.tsx` file under `src/` may ship a `hover:bg-bg-*` value
 *   outside the two canonical recipes above and the small set of
 *   semantic-state hovers (`hover:bg-bg-error`, `*-success`,
 *   `*-info`, `*-emphasis`, `*-attention`, `*-warning`, with or
 *   without an `/N` opacity).
 *
 *   Any other `hover:bg-bg-*` value is drift and fails CI.
 */
import * as fs from 'fs';
import * as path from 'path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');

// The two canonical hover recipes on muted backgrounds.
const CANONICAL_MUTED = new Set([
    'hover:bg-bg-muted',
    'hover:bg-bg-muted/50',
]);

// Semantic-state hover tones legitimately differ from the muted
// ladder — they carry meaning (error, success, info, …).
const SEMANTIC_PREFIXES = [
    'hover:bg-bg-error',
    'hover:bg-bg-success',
    'hover:bg-bg-info',
    'hover:bg-bg-emphasis',
    'hover:bg-bg-attention',
    'hover:bg-bg-warning',
];

const HOVER_RE = /\bhover:bg-bg-[a-z]+(?:\/[0-9]+)?/g;

interface Offence {
    file: string;
    line: number;
    token: string;
    snippet: string;
}

function isAllowed(token: string): boolean {
    if (CANONICAL_MUTED.has(token)) return true;
    return SEMANTIC_PREFIXES.some((p) => token === p || token.startsWith(p + '/'));
}

describe('Hover recipe discipline (Roadmap-5 PR-5)', () => {
    it('no .tsx file under src/ uses an off-recipe hover:bg-bg-* token', () => {
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
                    const matches = line.match(HOVER_RE);
                    if (!matches) return;
                    for (const token of matches) {
                        if (!isAllowed(token)) {
                            offenders.push({
                                file: rel,
                                line: i + 1,
                                token,
                                snippet: line.trim().slice(0, 200),
                            });
                        }
                    }
                });
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            const lines = offenders
                .map((o) => `  ${o.file}:${o.line} — ${o.token}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `Off-recipe hover:bg-bg-* tones detected. The product converges on TWO recipes — hover:bg-bg-muted/50 (row/card) and hover:bg-bg-muted (click target) — plus semantic-state hovers (error / success / info / emphasis / warning / attention):\n${lines}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
