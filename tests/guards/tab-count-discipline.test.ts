/**
 * Roadmap-4 PR-7 — tab-count visual lockdown.
 *
 * Tab bars in `<EntityDetailLayout>` carry optional counts. Until
 * this ratchet, the count rendered inline as
 *
 *     <span className="ml-1 text-xs opacity-60">({t.count})</span>
 *
 * — fine while there's only one tab bar, but a fragile shape: any
 * future tab surface (org-scope detail page, audit-shared portal,
 * a new TabSelect-driven dashboard) could hand-roll its own count
 * rendering and drift on tone, weight, or digit width.
 *
 * What this ratchet locks
 *
 *   1. The canonical helper `<TabCount>` lives inside
 *      `EntityDetailLayout.tsx` and carries the locked class string:
 *
 *          ml-1 text-xs tabular-nums opacity-60
 *
 *      The `tabular-nums` is load-bearing — it keeps digit widths
 *      stable so a count that ticks 9 → 10 doesn't shift the tab
 *      bar sideways. The opacity-60 over inherited tone is the
 *      "weaker than the label, regardless of selection state"
 *      trick that lets the count dim relative to both the
 *      emphasis (selected) and muted (unselected) tones.
 *
 *   2. The shell mounts `<TabCount>` (not the inline `({...})`
 *      pattern) — verified by source pattern.
 *
 *   3. No other source file under `src/` ships a tab count using
 *      the inline pattern. New tab bars MUST use the helper.
 *
 * What this ratchet does NOT police
 *
 *   - The handful of `({n})` patterns inside non-tab UI (eg.
 *     Heading-text "Active Keys (3)" in admin/api-keys, the
 *     Evidence filter-buttons "Active (5)") — those are not
 *     `role="tab"` surfaces, the count IS the label, and the
 *     visual rules (label-with-count, no opacity dim) differ.
 *     Those callsites use `<Heading>` or `<Button>` and
 *     deliberately render the count in-line with the label tone.
 *
 *   - The `TabSelectOption.badge` ReactNode slot in
 *     `tab-select.tsx`. That primitive has zero callers today;
 *     when it gets one, the ratchet should expand to require it
 *     to mount the helper too — but the API surface (`badge`
 *     accepts arbitrary ReactNode) makes a structural assertion
 *     awkward until then.
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
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf-8'));

const SHELL = 'src/components/layout/EntityDetailLayout.tsx';

describe('Tab-count visual lockdown (Roadmap-4 PR-7)', () => {
    it('shell exports a <TabCount> helper with the locked class string', () => {
        const src = read(SHELL);
        // Helper definition exists.
        expect(src).toMatch(/function TabCount\(\{ value }: \{ value: number }\)/);
        // Locked class string — order-sensitive on purpose so a
        // future PR can't quietly drop tabular-nums or swap to
        // text-content-subtle.
        expect(src).toMatch(
            /className="ml-1 text-xs tabular-nums opacity-60"/,
        );
        // data-tab-count anchor for E2E and future ratchets.
        expect(src).toMatch(/data-tab-count/);
    });

    it('shell mounts <TabCount> for tab counts, not the inline span', () => {
        const src = read(SHELL);
        // The render path uses the helper.
        expect(src).toMatch(/<TabCount value=\{t\.count}\s*\/>/);
        // The old inline pattern is gone — we permit the literal
        // class string ONLY where the helper itself defines it (one
        // occurrence in the whole file).
        const occurrences = src.match(
            /className="ml-1 text-xs tabular-nums opacity-60"/g,
        );
        expect(occurrences?.length ?? 0).toBe(1);
        // Old (pre-PR-7) shape removed.
        expect(src).not.toMatch(/className="ml-1 text-xs opacity-60"/);
    });

    it('no other source file hand-rolls a tab-count <span>', () => {
        // Walk every .tsx under src/ outside the shell + the
        // ratchet itself. We're scanning for the OLD inline shape
        // (the `ml-1 text-xs opacity-60` span specifically used for
        // tab counts) so a future copy-paste is caught.
        const offenders: string[] = [];
        const walk = (dir: string) => {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) {
                    if (e.name === 'node_modules' || e.name === '.next')
                        continue;
                    walk(full);
                    continue;
                }
                if (!/\.tsx$/.test(e.name)) continue;
                const rel = path.relative(ROOT, full);
                if (rel === SHELL) continue;
                const src = codeOf(fs.readFileSync(full, 'utf-8'));
                if (/ml-1 text-xs opacity-60/.test(src)) {
                    offenders.push(rel);
                }
            }
        };
        walk(path.join(ROOT, 'src'));
        if (offenders.length > 0) {
            throw new Error(
                `These files hand-roll the tab-count inline span (use <TabCount> from EntityDetailLayout):\n  ${offenders.join('\n  ')}`,
            );
        }
        expect(offenders).toEqual([]);
    });
});
