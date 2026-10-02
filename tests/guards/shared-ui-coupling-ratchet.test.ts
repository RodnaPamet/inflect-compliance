/**
 * The shared-UI coupling totals may only fall.
 *
 * #3048. The issue asks for a guard over four mechanical checks; three of them
 * (`storage-key`, `brand-as-text`, `domain-import`) are already enforced by
 * `ui-core-classification.test.ts`, and the fourth — hardcoded copy — is
 * already enforced across all of `src/components` by
 * `i18n-adoption-ratchet.test.ts`, which carries a grandfathered baseline and
 * nine detector self-tests. Rebuilding any of them here would put two guards
 * over the same files, which is the drift `no-epic-named-ratchets` exists to
 * prevent.
 *
 * So this adds the enforcement those three LEAVE OUT, which is the real gap:
 * they police files recorded `GENERIC`. A file already recorded `MIXED` can
 * acquire MORE coupling and nothing notices, because it was never claimed
 * clean. This closes it from the other side — the totals are a ceiling, so a
 * new coupling anywhere fails even in a file that already had one.
 *
 * ─── Counts, not a file list ─────────────────────────────────────────
 *
 * Deliberately per-KIND totals rather than a frozen set of paths. A frozen set
 * has to be edited on every rename and every legitimate move, and the edit is
 * indistinguishable from an exemption. A ceiling cannot be quietly widened:
 * raising one is a one-line diff with a number in it, visible in review.
 *
 * The companion guard owns the per-file detail, so nothing is lost: it already
 * fails if a `GENERIC` file trips a coupling, and the classification map
 * records which files carry what.
 *
 * ─── The sentinel, and why the allowances differ ─────────────────────
 *
 * `assertRatchetSlack` makes drift itself a failure: a ceiling sitting further
 * than `allowance` above the live count demands re-seating, so slack cannot
 * accumulate unobserved. Its doc requires the allowance to be STRICTLY SMALLER
 * than the drift the sentinel corrects. This sentinel is new and corrects no
 * historical drift, so the rule becomes "the smallest number that keeps
 * ordinary PRs quiet" — and that is not one number for all three:
 *
 *   `domain-import` (41) and `brand-as-text` (10) get 1. An incidental fix
 *     while doing something else should not force an edit to this file.
 *   `storage-key` (1) gets 0. At an allowance of 1 the only remaining file
 *     could be fixed and the ceiling would stay silently at 1 — a ratchet with
 *     nothing left to ratchet. For a count this small, exactness is the point.
 *
 * The helper's doc also demands a REPLAY: restore an inflated ceiling and
 * confirm the sentinel fails, because a sentinel that never fired is
 * indistinguishable from one that cannot. That replay was run for all three
 * kinds before this landed.
 */
import * as path from 'node:path';
import { assertRatchetSlack } from '../helpers/ratchet-slack';
import {
    couplingIndex,
    sharedUiPopulation,
    type CouplingKind,
} from '../helpers/shared-ui-couplings';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Measured on main, 2026-10-02. Lower these when you remove a coupling; the
 * sentinel below will tell you when you have to.
 */
const CEILINGS: Record<CouplingKind, { max: number; allowance: number }> = {
    'domain-import': { max: 41, allowance: 1 },
    // Re-seated 16 -> 10 by #3096, which replaced the brand fill token with
    // `text-content-brand` in the six files where it painted real rendered
    // TEXT and so owed WCAG 1.4.3's 4.5:1 (badge, checklist-gear-button,
    // FrameworkMinimap, TreeViewItem, FrameworkBuilder, table-title-cell).
    //
    // The residual 10 are NOT unfinished work. Every one is non-text content,
    // which owes 1.4.11's 3:1 and already clears it: six chart files painting
    // SVG fill/stroke through `currentColor` (charts/areas, charts/bars,
    // charts/time-series-chart, mini-area-chart, progress-circle,
    // dashboard-widgets/ChartRenderer), three `aria-hidden` icons
    // (layout/org-workspace-switcher, layout/tenant-switcher, FileDropzone),
    // and radio-group's border plus checked indicator. Recolouring any of
    // them would change charts and icons for no accessibility gain, so 10 is
    // the floor this kind is expected to sit at.
    'brand-as-text': { max: 10, allowance: 1 },
    'storage-key': { max: 1, allowance: 0 },
};

function counts(): Record<CouplingKind, number> {
    const per = { 'domain-import': 0, 'brand-as-text': 0, 'storage-key': 0 };
    for (const kinds of couplingIndex(ROOT).values()) {
        for (const k of kinds) per[k] += 1;
    }
    return per;
}

describe('shared-UI coupling ratchet (#3048)', () => {
    const live = counts();

    it.each(Object.keys(CEILINGS) as CouplingKind[])(
        '%s does not grow',
        (kind) => {
            const { max } = CEILINGS[kind];
            if (live[kind] > max) {
                throw new Error(
                    `${kind} rose to ${live[kind]}, ceiling ${max}. A shared-UI file ` +
                        `acquired this coupling. Either lift the product-specific part into ` +
                        `a slot the host supplies (AppShellFrame's render props and ` +
                        `UserMenu's items are the worked examples), or — if the file genuinely ` +
                        `belongs to the product — reclassify it COUPLED in ` +
                        `docs/_status/ui-core-classification.json with the reason. Raising ` +
                        `this ceiling is the option of last resort and needs saying why.`,
                );
            }
            expect(live[kind]).toBeLessThanOrEqual(max);
        },
    );

    it.each(Object.keys(CEILINGS) as CouplingKind[])(
        '%s ceiling has not drifted above the live count',
        (kind) => {
            const { max, allowance } = CEILINGS[kind];
            assertRatchetSlack({
                constantName: `CEILINGS['${kind}'].max`,
                baseline: max,
                count: live[kind],
                allowance,
                what: `shared-UI files tripping the ${kind} coupling`,
            });
        },
    );

    it('the detectors are live — a zero would make every ceiling vacuous', () => {
        // Each ceiling above is satisfied trivially if the derivation returns
        // nothing, which is the shape a broken detector shares with a clean
        // repo. The population and at least one hit per kind are asserted so
        // the ceilings are known to be measuring something.
        expect(sharedUiPopulation(ROOT).length).toBeGreaterThan(600);
        for (const kind of Object.keys(CEILINGS) as CouplingKind[]) {
            expect(live[kind]).toBeGreaterThan(0);
        }
    });

    it('is not a second copy of the checks that already exist', () => {
        // The regret this file is built to avoid. `i18n-adoption-ratchet` owns
        // hardcoded copy over all of `src/components`;
        // `ui-core-classification` owns the per-file GENERIC assertion. This
        // guard must not grow its own copy of either, so the detectors are
        // imported rather than defined, and there is exactly one of them.
        const src = require('node:fs').readFileSync(__filename, 'utf8') as string;
        expect(src).toContain("from '../helpers/shared-ui-couplings'");
        // No inline regex: a pattern typed here is a second detector.
        expect(src).not.toMatch(/new RegExp\(|= \/\^?\(\?:/);
    });
});
