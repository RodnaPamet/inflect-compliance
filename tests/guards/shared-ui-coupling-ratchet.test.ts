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
 *   `domain-import` and `brand-as-text` get 1. An incidental fix while doing
 *     something else should not force an edit to this file. Read both ceilings
 *     from `CEILINGS` below and never from this paragraph — it quoted
 *     `domain-import` as 41 while the constant said 46, which is a count
 *     stored beside its own source, the rot `doc-classification.json`'s
 *     deleted `counts` header records.
 *   `storage-key` gets 0, and there the VALUE is the argument rather than a
 *     citation: its ceiling is 1, so at an allowance of 1 the only remaining
 *     file could be fixed and the ceiling would stay silently at 1 — a ratchet
 *     with nothing left to ratchet. For a count this small, exactness is the
 *     point.
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
 * Measured on main, 2026-10-03. Lower these when you remove a coupling; the
 * sentinel below will tell you when you have to.
 */
const CEILINGS: Record<CouplingKind, { max: number; allowance: number }> = {
    // Re-seated 46 -> 36 by #3046 batch 2, in two steps, measured by running
    // this guard after each:
    //
    //   46 -> 37  `NEUTRAL_LIB` in `tests/helpers/shared-ui-couplings.ts` gained
    //             `format-date`, `kpi-trend`, `number-format` and
    //             `locale-constants` — four leaf utilities, each with ZERO `@/`
    //             imports of its own, so none can pull a domain module in
    //             behind the allowance. Nine files stopped tripping the kind.
    //             (The same change DELETED `utils`, `format`, `dates` and
    //             `a11y`, which named modules that do not exist and so could
    //             never have allowed anything; that half moves no count.)
    //   37 -> 36  `ui/hooks/use-celebration.ts`'s single `@/lib/celebrations`
    //             import inverted — the preset/input TYPES moved into the hook
    //             and the dedupe pair is injected, so the hooks barrel stops
    //             depending on a product registry.
    //
    // The nine files the widening freed were NOT all reclassified: a file stops
    // tripping a MECHANICAL coupling without becoming neutral, and five of the
    // nine keep a judgement coupling (`date-picker`/`date-range-picker`'s
    // untranslated English, `LocaleSwitcher`'s cookie-seam bypass, `KpiCard`'s
    // domain JSDoc, `charts/funnel-chart`'s brand-painted SVG text). So this
    // count falling is not the same event as the GENERIC set growing.
    //
    // 36 should keep falling as `@/lib/<domain>` and non-shared `@/components`
    // imports become props or slots. The predecessor reading, 46, was itself a
    // RISE (41 -> 46, #3098 §1) and not a regression: the detector's regex had
    // matched only `@/app-layer` and `@/lib`, so an import of
    // `@/components/<anything outside the roots>` was invisible, and eight
    // files in the roots had one. `layout/ClientProviders.tsx` was reclassified
    // GENERIC -> MIXED in that change, because a file tripping a mechanical
    // coupling cannot be GENERIC.
    //
    // #3046 batch 3 (#3133) left this at 36, and that is STRUCTURAL rather than
    // a coincidence worth re-checking next time. It reclassified five files
    // MIXED -> GENERIC and took the import-closed subset 427 -> 442, yet
    // `counts()` below reads `couplingIndex()`, which derives from SOURCE only
    // and never opens the classification map — so no reclassification, of any
    // size, can move any of these three numbers. Batch 2's note above records
    // the converse (the count fell while the GENERIC set barely moved); both
    // directions are independent, and expecting them to travel together has now
    // been wrong twice.
    //
    // Re-seated 36 -> 34 by #3046 batch 4. `NEUTRAL_LIB` gained `resize-image`
    // and `text-utils`, so the two files whose ONLY non-neutral `@/lib` edge was
    // one of them stop tripping the kind: `ui/file-upload.tsx` and
    // `ui/filter/filter-list.tsx`. Both modules have zero import statements of
    // any kind (so neither can pull a domain module in behind the allowance) and
    // both are the repo's first-party replacements for the `Dub utils` shim —
    // read the full argument, including the two it deliberately did NOT add, in
    // `NEUTRAL_LIB`'s own docstring.
    //
    // 34 is not a floor: the cheapest remaining real inversion is MEASURED and
    // recorded rather than taken. `ui/TruncationBanner.tsx` imports
    // `@/lib/list-backfill-cap` for ONE thing — the default of its existing
    // `cap?: number` prop — so making `cap` required inverts the edge with no
    // new mechanism. Its price is 10 call sites under `src/app/t/[tenantSlug]`
    // that pass `truncated` and nothing else, which is why it is a batch of its
    // own rather than a rider on this one.
    'domain-import': { max: 34, allowance: 1 },
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
