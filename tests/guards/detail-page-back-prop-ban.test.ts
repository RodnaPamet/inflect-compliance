/**
 * Roadmap-10 PR-9 — detail-page `back={...}` prop ban.
 *
 * R9 north-star decision (locked 2026-05-11): detail-page top-left
 * navigation was **breadcrumbs only**. The `back={...}` prop on
 * `<EntityDetailLayout>` / `<PageHeader>` parallels the breadcrumb
 * trail with an extra back button — at the time, two ways to go up
 * felt redundant.
 *
 * **2026-06-13 — RQ4 update.** The user-decision pinned in the RQ4
 * planning phase REVERSED that: every subpage gets a thin
 * "← Back to <Destination>" affordance ABOVE its title, alongside
 * breadcrumbs. The two affordances answer different questions —
 * breadcrumbs are "you are here", back is "go where you came from".
 *
 * So the ban is narrowed: the LEGACY static form
 * `back={{ href: ..., label: ... }}` is still banned (it's the
 * pre-RQ4 hand-rolled affordance that doesn't carry smart resolution).
 * The NEW RQ4 smart form `back={{ smart: true }}` is the canonical
 * mount — it routes through `<BackAffordance>` and resolves to the
 * in-tab referrer (or the IA-canonical parent on a cold load).
 *
 * Scan: any `<EntityDetailLayout` or `<PageHeader` JSX in `src/app/**`
 * that passes the LEGACY `back={{ href: ..., label: ... }}` static
 * form is a violation. The scanner strips JS/TS comments first so
 * doc-block references don't false-positive.
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// EVERY read here is wrapped because every path this file reads is a
// TypeScript-alike — re-derived per file, not assumed from the directory — so
// there is no second language needing its own reader. String literals are KEPT.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const APP_ROOT = path.resolve(ROOT, 'src/app');

function walk(dir: string, results: string[] = []): string[] {
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(full, results);
        } else if (entry.name.endsWith('.tsx')) {
            results.push(full);
        }
    }
    return results;
}

function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

// Capture EntityDetailLayout / PageHeader JSX blocks, then check for
// `back={` inside the opening tag block. `[\s\S]` matches any char
// INCLUDING newline (used in place of the `s` / dotAll flag because
// tsconfig targets pre-ES2018).
const PRIMITIVE_BLOCK_RE =
    /<(?:EntityDetailLayout|PageHeader)\b[\s\S]*?(?:>|\/>)/g;

describe('detail-page back prop ban (R10-PR9 + RQ4-4)', () => {
    test('no <EntityDetailLayout> or <PageHeader> in src/app passes the LEGACY back={{ href, label }} static form', () => {
        const offenders: { file: string; snippet: string }[] = [];
        for (const file of walk(APP_ROOT)) {
            const content = stripComments(codeOf(fs.readFileSync(file, 'utf-8')));
            const blocks = content.match(PRIMITIVE_BLOCK_RE);
            if (!blocks) continue;
            for (const block of blocks) {
                // Only flag the LEGACY form: `back={{ ...href... }}` or
                // `back={ /* obj */ }` with `href:` in it. The new
                // canonical form `back={{ smart: true }}` is the
                // RQ4-4 smart back affordance and is explicitly
                // allowed (it routes through <BackAffordance> which
                // resolves the destination at render time).
                if (
                    /\sback=\{\s*\{[^}]*href\s*:/.test(block) ||
                    /\sback=\{\s*\{[^}]*label\s*:/.test(block)
                ) {
                    offenders.push({
                        file: path.relative(ROOT, file),
                        snippet: block.slice(0, 120),
                    });
                }
            }
        }
        if (offenders.length > 0) {
            const sample = offenders
                .slice(0, 10)
                .map((o) => `  ${o.file}\n    ${o.snippet}`)
                .join('\n');
            throw new Error(
                `${offenders.length} site(s) pass the LEGACY back={{ href, label }} static form to <EntityDetailLayout> or <PageHeader>:\n${sample}\n\nFix: replace with the RQ4-4 smart form: \`back={{ smart: true }}\`. The smart form routes through <BackAffordance> and resolves to the in-tab referrer (or canonical parent on cold load), so the destination tracks where the user actually came from.`,
            );
        }
    });

    test('EntityDetailLayout primitive still exposes back?: prop in a union form (legacy + RQ4 smart)', () => {
        // Lock the primitive's interface — the prop remains in the
        // type so external consumers / library callers can pass it.
        // RQ4-4 widens it to a union that includes the new smart
        // form; both arms must remain.
        const src = codeOf(fs.readFileSync(
            path.resolve(ROOT, 'src/components/layout/EntityDetailLayout.tsx'),
            'utf-8',
        ));
        expect(src).toMatch(/href:\s*string/);
        expect(src).toMatch(/label:\s*string/);
        expect(src).toMatch(/smart:\s*true/);
    });
});
