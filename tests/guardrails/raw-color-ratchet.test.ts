/**
 * Epic 51 — raw Tailwind color ratchet.
 *
 * Complements the "migrated page" anti-drift guardrail
 * (`design-system-drift.test.ts`) which strictly forbids raw colors
 * on the 4 pages that were migrated in the first pass. This ratchet
 * runs across the whole `src/app/` tree and caps the count at the
 * recorded baseline so the migration can only go in one direction.
 *
 * Lower `BASELINE` when you migrate a file; never raise it. If you
 * genuinely need a raw color (e.g. inside a print-only view where
 * tokens don't apply), carry that in the allowlist below and leave
 * the ratchet count alone.
 *
 * Lowering it is not optional politeness: a second test here is a
 * DRIFT SENTINEL that fails when `BASELINE` sits more than
 * `DRIFT_ALLOWANCE` above the live count. A ceiling above the tree is
 * headroom a regression can spend with a green build, so the ratchet
 * is required to stay seated in both directions.
 */

import * as fs from 'fs';
import * as path from 'path';

import { assertRatchetSlack, ratchetSlackFailure } from '../helpers/ratchet-slack';

const APP_ROOT = path.resolve(__dirname, '../../src/app');

// Matches `bg-slate-800`, `text-neutral-400`, `border-gray-100`, etc.
// Same regex used by `design-system-drift.test.ts` so the two guards
// stay consistent.
const RAW_COLOR_RE = /\b(?:text|bg|border)-(?:slate|gray|neutral|zinc)-\d{2,3}\b/g;

// Baseline recorded at Epic 51 close-out. Lower only.
//
// History
//   92 → 95  (2026-04-22) absorbed pre-existing drift in the
//            render-before-theme paths (error.tsx, login/page.tsx,
//            audit/shared/[token]) that landed across the fix(login) +
//            fix(auth) cluster of commits. CI had been red for weeks
//            against the stale 92 baseline.
//   95 → 51  (2026-08-29) re-seated to the live count. The tree had
//            been tokenised well past the baseline without anyone
//            lowering it, leaving 44 units of headroom a regression
//            could have spent with a green build. That is the exact
//            failure the drift sentinel below now makes visible — this
//            ratchet had none, which is why the slack survived months
//            of green CI.
//
// The ONE remaining hotspot, and it is the whole count:
//   51  audit/shared/[token]/page.tsx  — public audit-pack viewer.
//       Unauthenticated, mounts no app shell, and has no layout.tsx of
//       its own. It is NOT a print or light surface: it paints
//       `bg-slate-900` + `text-white` and shades with slate-700/800 —
//       a hand-rolled replica of the app's dark theme. So the classes
//       here have semantic-token equivalents; nothing about the surface
//       resists tokenisation.
//
// Every other file the old comment listed (reports/soa/print/
// SoAPrintView.tsx, login/page.tsx, error.tsx, not-found.tsx,
// security/mfa/page.tsx) now matches zero times — they were tokenised
// and the enumeration was never updated. Do not re-add a surface here
// without re-running the count.
//
// Read this number together with EXEMPT_DIRS below: exempting the audit
// viewer would take the count to 0 and leave this ratchet asserting
// nothing across all of src/app.
const BASELINE = 51;

// How far above the live count `BASELINE` may sit before the sentinel
// reports it as unspent headroom. Five, matching the model sentinel in
// `no-explicit-any-ratchet.test.ts`: enough that a small tokenisation
// pass need not touch this file, small enough that the drift which put
// the baseline 44 above the tree cannot recur unnoticed.
const DRIFT_ALLOWANCE = 5;

// Directories that are intentionally outside the internal design
// system. Adding entries here is allowed when the surface is a
// public, unauthenticated page that doesn't share the app's dark
// theme tokens.
const EXEMPT_DIRS = new Set<string>([
    // Epic G-3 — public vendor questionnaire respondent page at
    // /vendor-assessment/[id], which does NOT mount the app shell.
    //
    // This entry is now INERT, and that fact is the useful part. It was
    // added on the rationale that the page "intentionally uses a light,
    // neutral palette" and so could not use the tokens; the page has
    // since been tokenised anyway (37 semantic-token classes, zero raw
    // colours as of 2026-08-29), so removing the exemption today would
    // not change the count by one.
    //
    // Kept rather than deleted only as the worked precedent for the
    // question this list invites: a public, shell-less, unauthenticated
    // surface turned out NOT to need an exemption. Weigh that before
    // adding a directory here — and re-run the count first, because an
    // exemption that removes the last hits makes the ratchet vacuous.
    'vendor-assessment',
]);

function walk(dir: string, out: string[]): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '.next') continue;
            if (EXEMPT_DIRS.has(entry.name)) continue;
            walk(full, out);
        } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

function countRawColors(): { total: number; byFile: Record<string, number> } {
    const byFile: Record<string, number> = {};
    let total = 0;
    for (const file of walk(APP_ROOT, [])) {
        const src = fs.readFileSync(file, 'utf-8');
        const matches = src.match(RAW_COLOR_RE);
        if (matches && matches.length > 0) {
            byFile[path.relative(APP_ROOT, file)] = matches.length;
            total += matches.length;
        }
    }
    return { total, byFile };
}

describe('Epic 51 — raw Tailwind color ratchet', () => {
    it(`count of bg-/text-/border-(slate|gray|neutral|zinc)-NN in src/app is ≤ ${BASELINE}`, () => {
        const { total, byFile } = countRawColors();
        if (total > BASELINE) {
            const top = Object.entries(byFile)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 10)
                .map(([f, n]) => `  ${n}\t${f}`)
                .join('\n');
            throw new Error(
                `Epic 51 ratchet: raw color usage grew from baseline ${BASELINE} to ${total}.\n` +
                `Migrate to semantic tokens (see docs/token-cheatsheet.md) or lower the baseline when you do.\n` +
                `Top hotspots:\n${top}`,
            );
        }
        expect(total).toBeLessThanOrEqual(BASELINE);
    });

    it('baseline has not drifted above the live count (drift sentinel)', () => {
        const { total } = countRawColors();

        // Positive control, against the REAL counter — an absence is
        // ambiguous, so prove the sentinel can still fail before trusting
        // it to pass. A baseline one unit past the allowance must be
        // rejected; if someone neuters `ratchetSlackFailure` this line
        // goes red rather than the whole check going quietly vacuous.
        expect(
            ratchetSlackFailure({
                constantName: 'BASELINE',
                baseline: total + DRIFT_ALLOWANCE + 1,
                count: total,
                allowance: DRIFT_ALLOWANCE,
            }),
        ).not.toBeNull();

        assertRatchetSlack({
            constantName: 'BASELINE',
            baseline: BASELINE,
            count: total,
            allowance: DRIFT_ALLOWANCE,
            what: 'raw bg-/text-/border-(slate|gray|neutral|zinc)-NN classes in src/app',
        });
    });
});
