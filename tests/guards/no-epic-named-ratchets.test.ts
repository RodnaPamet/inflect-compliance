/**
 * An epic ratchet is deleted when its epic ships.
 *
 * WHY
 * ---
 * A ratchet named for one PR or epic — `b7-…`, `item-27-…`, `r14-…`,
 * `epic55-…`, `pr-b-…`, `roadmap-11-…` — does not encode an architectural
 * rule. It encodes the SHAPE OF ONE DIFF. Read the ones that were retired on
 * 2026-08-05 and the pattern is uniform: `readFileSync` the source, then
 * regex it for a literal that happened to be in that PR — a variable name
 * (`handleAssetRowClick`), a Tailwind class order
 * (`font-mono … text-xs … tabular-nums`), the interior spacing of an object
 * literal, a keyframe name in `tailwind.config.js`.
 *
 * Such a test cannot catch a regression the type system would miss: the code
 * it guards is imported and type-checked at its real call sites. What it CAN
 * do is fail when someone renames a variable, sorts classes, extracts a
 * shared helper, or reformats — all of which are refactors, not regressions.
 * So its true-positive rate is structurally zero and its false-positive rate
 * is proportional to how much you improve the code.
 *
 * That is not a neutral cost. 775 of 2,011 test files were ratchets, 29 of
 * them regexing `AssetsClient.tsx` alone. Extracting a shared helper meant
 * fixing dozens of source-string assertions, which made copy-paste the
 * cheaper option every single time. The suite was actively holding the
 * duplication in place.
 *
 * THE RULE
 * --------
 * Name a guard for the INVARIANT it protects, not for the work that
 * introduced it. `no-client-side-filtering`, `rls-coverage`,
 * `encryption-key-enforcement`, `api-permission-coverage` all still make
 * sense years after the PR that added them, and all still fail for a real
 * reason. `b7-asset-risk-tasks-column` never will.
 *
 * If what you want to enforce is structural — a banned import, a required
 * prop, a forbidden identifier, a naming convention — write an ESLint rule
 * instead. An AST rule survives reformatting and renaming; a regex over
 * source text does not.
 *
 * SURVIVORS
 * ---------
 * `ALLOWED` is the set that still carried a load when the retirement ran:
 * either another guard references it by name, or CLAUDE.md documents it as a
 * live platform rule. It is a shrinking list, not a budget to spend — adding
 * a name to it needs the same justification as adding a new guard, and
 * removing one is always welcome.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const GUARD_DIRS = ['tests/guards', 'tests/guardrails'];

/**
 * Filename prefixes that name a PR, batch, epic or roadmap item rather than
 * an invariant. Anchored at the start of the basename so a legitimate name
 * that merely contains one of these substrings is unaffected.
 */
const EPIC_NAME_PATTERNS: RegExp[] = [
    /^b\d+-/, // b1-… b9-…       batch N
    /^item-\d+/, // item-27-…       roadmap item N
    /^r\d+-/, // r13-… r31-…    roadmap N
    /^epic\d+/, // epic52-…        epic N
    /^pr-/, // pr-b-… pr-1-…   a single PR
    /^roadmap-\d+/, // roadmap-11-…    roadmap N
];

/**
 * Epic-named guards that survived the 2026-08-05 retirement, each with the
 * reason it could not simply be deleted. Shrink this list; do not grow it.
 */
const ALLOWED: Record<string, string> = {
    'b4-control-tasks-tab.test.ts': 'referenced by name from single-task-model.test.ts',
    'epic52-datatable-ratchet.test.ts':
        'CLAUDE.md documents it as the DataTable platform rule; referenced by behavioural-coverage-registry + interaction-state-discipline',
    'epic60-ratchet.test.ts':
        'CLAUDE.md documents it as the shared-hooks rule; referenced by no-explicit-any-ratchet',
    'r13-active-band-secondary.test.ts': 'referenced by name from behavioural-coverage-registry.test.ts',
    'r13-press-feedback.test.ts': 'referenced by name from motion-language-discipline.test.ts',
    'r14-mobile-parity-discipline.test.ts': 'referenced by name from mobile-roadmap-integrity.test.ts',
    'r14-no-page-searchbars.test.ts':
        'CLAUDE.md documents it as the search-placeholder rule (searchId + searchPlaceholder presence)',
    'r18-donut-bubble-entrance.test.ts': 'referenced by name from donut-chart-centering.test.ts',
    'r21-prb-sankey-rebuild.test.ts': 'referenced by name from behavioural-coverage-registry.test.ts',
    'r31-document-bar.test.ts': 'referenced by name from inline-subtitle-budget.test.ts',
};

/**
 * Every guard file the 2026-08-05 retirement deleted, and every one deleted by
 * the tranches that retired the rq* family after it, under the path it had. A
 * restore of any of them fails "no retired guard file has come back" below, by
 * name.
 *
 * Read from git, not from the implementation notes, which give counts rather
 * than names. For each commit: `git diff --name-status -M <sha>^ <sha> --
 * tests/guards tests/guardrails`, taking every `D` path and the OLD path of
 * every `R`.
 *
 *   #1790  c7a994a0  2026-08-05  154 deleted, 4 renamed
 *   #1797  47978689  2026-08-06  2 deleted
 *   #1800  38858d16  2026-08-06  2 deleted
 *   #1801  c5f79704  2026-08-06  1 deleted
 *   #1834  f957c0a6  2026-08-10  2 deleted (the last tranche RQ_CEILING records)
 *
 * `2026-08-05-retire-epic-ratchets.md` says 153 were deleted; git shows 154,
 * and 153 is the net after the one file that commit added, which is this one.
 *
 * The four #1790 renamed are here by their OLD names. Their new names
 * (`evidence-download-authz`, `evidence-review-authz`,
 * `evidence-list-resilience`, `risk-quantitative-analytics`) are live guards
 * and must not be added: the restore check would fail on them at once.
 *
 * 158 of the 165 also match EPIC_NAME_PATTERNS, so the first test catches
 * their return too. The five `rq*` files would move RQ_CEILING's count without
 * being named, and nothing else catches `risk-quantification-integrity` or
 * `polish-01-score-chip-a11y`.
 *
 * This is history: it does not grow with the tree and never needs raising. Its
 * length is pinned below for that reason, because a shorter list is a restore
 * being let through.
 */
const RETIRED_GUARD_FILES = [
    // #1790, c7a994a0, 2026-08-05: every file it deleted.
    'tests/guardrails/b1-bug-fix-bundle.test.ts',
    'tests/guardrails/b2-table-unification.test.ts',
    'tests/guardrails/b3-button-card-unify.test.ts',
    'tests/guardrails/b4-filter-nav-consistency.test.ts',
    'tests/guardrails/b5-evidence-workflow.test.ts',
    'tests/guardrails/b6-usezodform-adoption.test.ts',
    'tests/guardrails/b7-layout-redesign.test.ts',
    'tests/guardrails/b8-folders-frameworks.test.ts',
    'tests/guardrails/b8-followup-evidence-folders.test.ts',
    'tests/guardrails/b9-policy-template-upgrade.test.ts',
    'tests/guardrails/pr-1-tenant-tables-org-parity.test.ts',
    'tests/guardrails/pr-2-org-shell-parity.test.ts',
    'tests/guardrails/pr-3-org-dashboard-parity.test.ts',
    'tests/guardrails/pr-a-dashboard-reports.test.ts',
    'tests/guardrails/pr-asset-control-codes.test.ts',
    'tests/guardrails/pr-b-tables-buttons.test.ts',
    'tests/guardrails/pr-c-forms-filters-interactions.test.ts',
    'tests/guardrails/pr-d-entity-id-picker.test.ts',
    'tests/guards/b1-selection-header-bar.test.ts',
    'tests/guards/b10-create-button-dark-contrast.test.ts',
    'tests/guards/b3-popup-texture.test.ts',
    'tests/guards/b5-entity-prev-next-nav.test.ts',
    'tests/guards/b6-assets-cia-and-table-height.test.ts',
    'tests/guards/b7-asset-risk-tasks-column.test.ts',
    'tests/guards/b8-landing-no-passwords-grc.test.ts',
    'tests/guards/b9-seed-password-env.test.ts',
    'tests/guards/epic49-calendar-ratchets.test.ts',
    'tests/guards/epic51-theme-token-guard.test.ts',
    'tests/guards/epic55-native-select-ratchet.test.ts',
    'tests/guards/epic63-timestamp-rollout.test.ts',
    'tests/guards/item-25-weighted-criticality.test.ts',
    'tests/guards/item-27-32-34-asset-ux.test.ts',
    'tests/guards/item-28-task-due-wiring.test.ts',
    'tests/guards/item-29-status-buttons.test.ts',
    'tests/guards/item-30-risk-nav.test.ts',
    'tests/guards/item-31-risk-overview-single-card.test.ts',
    'tests/guards/item-33-35-layout.test.ts',
    'tests/guards/r13-active-label-brand-colour.test.ts',
    'tests/guards/r13-band-reach.test.ts',
    'tests/guards/r13-band-richness.test.ts',
    'tests/guards/r13-band-shimmer.test.ts',
    'tests/guards/r13-bevel-shadow.test.ts',
    'tests/guards/r13-gloss-highlight.test.ts',
    'tests/guards/r13-living-sidebar-bundle.test.ts',
    'tests/guards/r13-radial-active-wash.test.ts',
    'tests/guards/r13-secondary-brand-tokens.test.ts',
    'tests/guards/r13-soft-section-divider.test.ts',
    'tests/guards/r14-environment-badge-discipline.test.ts',
    'tests/guards/r14-living-chrome-discipline.test.ts',
    'tests/guards/r14-living-topbar-bundle.test.ts',
    'tests/guards/r14-nav-bar-brand-discipline.test.ts',
    'tests/guards/r14-nav-bar-geometry-discipline.test.ts',
    'tests/guards/r14-nav-bar-import-discipline.test.ts',
    'tests/guards/r14-notifications-bell-discipline.test.ts',
    'tests/guards/r14-slot-press-feedback-discipline.test.ts',
    'tests/guards/r14-tenant-switcher-discipline.test.ts',
    'tests/guards/r14-user-menu-discipline.test.ts',
    'tests/guards/r15-active-row-aura.test.ts',
    'tests/guards/r15-band-active-starburst.test.ts',
    'tests/guards/r15-band-halo-breath.test.ts',
    'tests/guards/r15-band-per-row-drift.test.ts',
    'tests/guards/r15-band-reveal-sweep.test.ts',
    'tests/guards/r15-band-stardust-trail.test.ts',
    'tests/guards/r15-label-magnetic-tracking.test.ts',
    'tests/guards/r15-row-liquid-sweep.test.ts',
    'tests/guards/r15-weighty-press.test.ts',
    'tests/guards/r16-chart-frame.test.ts',
    'tests/guards/r16-chart-gradient-primitives.test.ts',
    'tests/guards/r16-chart-motion-hooks.test.ts',
    'tests/guards/r16-chart-tokens.test.ts',
    'tests/guards/r16-donut-hover.test.ts',
    'tests/guards/r16-donut-rebuild.test.ts',
    'tests/guards/r16-donut-zero-value-segments.test.ts',
    'tests/guards/r16-gantt-chart.test.ts',
    'tests/guards/r16-gantt-hover.test.ts',
    'tests/guards/r16-lickable-charts-bundle.test.ts',
    'tests/guards/r16-line-chart.test.ts',
    'tests/guards/r16-line-hover.test.ts',
    'tests/guards/r16-radar-chart.test.ts',
    'tests/guards/r16-radar-hover.test.ts',
    'tests/guards/r17-capstone-rollout.test.ts',
    'tests/guards/r17-hero-ambient-glow.test.ts',
    'tests/guards/r17-hero-breath-animation.test.ts',
    'tests/guards/r17-hero-sparkline.test.ts',
    'tests/guards/r17-metric-card-corner-glow.test.ts',
    'tests/guards/r17-pr10-next-best-action-urgency-glow.test.ts',
    'tests/guards/r17-pr11-clear-check.test.ts',
    'tests/guards/r17-pr12-dashboard-rise-in.test.ts',
    'tests/guards/r17-pr7-clickable-kpi.test.ts',
    'tests/guards/r17-pr8-donut-filter-aware.test.ts',
    'tests/guards/r17-pr9-charts-filter-aware.test.ts',
    'tests/guards/r18-area-liquid-fill.test.ts',
    'tests/guards/r18-bar-hover-bubble.test.ts',
    'tests/guards/r18-bubble-tokens.test.ts',
    'tests/guards/r18-bubbly-bars.test.ts',
    'tests/guards/r18-capstone-rollout.test.ts',
    'tests/guards/r18-chart-gloss.test.ts',
    'tests/guards/r18-chart-spring.test.ts',
    'tests/guards/r18-donut-gloss.test.ts',
    'tests/guards/r18-fluid-morph.test.ts',
    'tests/guards/r18-line-gloss.test.ts',
    'tests/guards/r18-sheen-sweep.test.ts',
    'tests/guards/r18-uplift-a-dashboard-charts.test.ts',
    'tests/guards/r18-uplift-b-riskmatrix.test.ts',
    'tests/guards/r21-pra-foundation.test.ts',
    'tests/guards/r21-prc-heatmap-rebuild.test.ts',
    'tests/guards/r21-prd-funnel-hover-flicker.test.ts',
    'tests/guards/r21-prd-funnel-polish.test.ts',
    'tests/guards/r21-pre-3d-foundation.test.ts',
    'tests/guards/r21-prf-bar3d-capstone.test.ts',
    'tests/guards/r22-pre-variant-and-cta-order.test.ts',
    'tests/guards/r22-prf-capstone.test.ts',
    'tests/guards/r23-pra-kpi-primitive.test.ts',
    'tests/guards/r23-prb-kpi-filter-hook.test.ts',
    'tests/guards/r23-prc-kpi-url-sync.test.ts',
    'tests/guards/r23-prd-assets-controls-rollout.test.ts',
    'tests/guards/r23-pre-tasks-evidence-rollout.test.ts',
    'tests/guards/r23-prf-policies-vendors-capstone.test.ts',
    'tests/guards/r24-pre-rollout.test.ts',
    'tests/guards/r25-pra-route-and-shell.test.ts',
    'tests/guards/r25-prb-canvas-integration.test.ts',
    'tests/guards/r25-prc-process-step-node.test.ts',
    'tests/guards/r25-prd-edge-and-control-overlay.test.ts',
    'tests/guards/r25-pre-interaction-model.test.ts',
    'tests/guards/r25-prf-polish-and-capstone.test.ts',
    'tests/guards/r26-prb-node-taxonomy.test.ts',
    'tests/guards/r26-prc-proximity-auto-bind.test.ts',
    'tests/guards/r26-prd-edge-controls-semantics.test.ts',
    'tests/guards/r26-pre-editor-ux.test.ts',
    'tests/guards/r26-prf-capstone.test.ts',
    'tests/guards/r27-pra-visual-foundation.test.ts',
    'tests/guards/r27-prb-graph-elements.test.ts',
    'tests/guards/r27-prf-capstone.test.ts',
    'tests/guards/r28-editor-ergonomics.test.ts',
    'tests/guards/r29-multi-select-perf-collab.test.ts',
    'tests/guards/r30-group-nodes.test.ts',
    'tests/guards/r31-background-and-empty-state.test.ts',
    'tests/guards/r31-capstone.test.ts',
    'tests/guards/r31-command-palette.test.ts',
    'tests/guards/r31-edge-label-chip.test.ts',
    'tests/guards/r31-inspector-asidepanel.test.ts',
    'tests/guards/r31-left-palette.test.ts',
    'tests/guards/r31-minimap-zoom.test.ts',
    'tests/guards/r31-node-geometry.test.ts',
    'tests/guards/r32-canvas-decomposition.test.ts',
    'tests/guards/r32-modal-form-completeness.test.ts',
    'tests/guards/r32-selection-emphasis.test.ts',
    'tests/guards/r32-small-details-a.test.ts',
    'tests/guards/r32-small-details-b.test.ts',
    'tests/guards/roadmap-10-completion.test.ts',
    'tests/guards/roadmap-11-completion.test.ts',
    'tests/guards/roadmap-7-completion.test.ts',
    'tests/guards/roadmap-8-completion.test.ts',
    'tests/guards/roadmap-9-completion.test.ts',
    // #1790: the four it RENAMED rather than deleted, by their OLD names.
    'tests/guardrails/b10-advanced-analytics.test.ts',
    'tests/guards/r5-p1-evidence-download-security.test.ts',
    'tests/guards/r5-p2-evidence-review-authz.test.ts',
    'tests/guards/r5-p3-evidence-resilience.test.ts',
    // #1797, 47978689, 2026-08-06.
    'tests/guards/risk-quantification-integrity.test.ts',
    'tests/guards/rq3-11-capstone.test.ts',
    // #1800, 38858d16, 2026-08-06.
    'tests/guards/rq2-9-matrix-movement.test.ts',
    'tests/guards/rq9-trending.test.ts',
    // #1801, c5f79704, 2026-08-06.
    'tests/guards/rq3-ob-c-tab-deep-links.test.ts',
    // #1834, f957c0a6, 2026-08-10.
    'tests/guards/polish-01-score-chip-a11y.test.ts',
    'tests/guards/rq3-ob-f-first-run.test.ts',
] as const;

/** Every `.test.ts` under GUARD_DIRS, as a repo-relative path. */
function guardPaths(): string[] {
    const out: string[] = [];
    for (const dir of GUARD_DIRS) {
        const full = path.resolve(__dirname, '../../', dir);
        if (!fs.existsSync(full)) continue;
        for (const name of fs.readdirSync(full)) {
            if (name.endsWith('.test.ts')) out.push(`${dir}/${name}`);
        }
    }
    return out;
}

function guardFiles(): string[] {
    return guardPaths().map((p) => path.basename(p));
}

function isEpicNamed(basename: string): boolean {
    return EPIC_NAME_PATTERNS.some((re) => re.test(basename));
}

describe('epic-named ratchets are not added back', () => {
    it('no new guard is named for a PR, batch, epic or roadmap item', () => {
        const offenders = guardFiles()
            .filter(isEpicNamed)
            .filter((f) => !(f in ALLOWED))
            .sort();

        // The message matters more than the assertion here — whoever trips
        // this is mid-PR and needs to know what to do instead.
        expect({
            offenders,
            hint:
                offenders.length === 0
                    ? 'none'
                    : 'Name the guard for the invariant it protects, not the work that introduced it. ' +
                      'If the rule is structural (banned import, required prop, forbidden identifier, ' +
                      'naming convention), write an ESLint rule instead — an AST rule survives ' +
                      'reformatting and renaming; a regex over source text does not.',
        }).toEqual({ offenders: [], hint: 'none' });
    });

    it('every allowlisted survivor still exists', () => {
        // A stale entry would quietly widen the allowlist for a future file
        // that happens to reuse the name.
        const present = new Set(guardFiles());
        const stale = Object.keys(ALLOWED)
            .filter((f) => !present.has(f))
            .sort();
        expect(stale).toEqual([]);
    });

    it('every allowlisted survivor carries a written reason', () => {
        const unexplained = Object.entries(ALLOWED)
            .filter(([, reason]) => reason.trim().length < 20)
            .map(([f]) => f)
            .sort();
        expect(unexplained).toEqual([]);
    });

    it('no retired guard file has come back', () => {
        // Keeps the retirement from being undone quietly: a restore fails here
        // naming each file, in either directory, whatever else the tree holds.
        //
        // This replaced an absolute ceiling, `guardFiles().length < N`, set
        // at 700 on 2026-08-05 and raised by hand in 25 pull requests between
        // 2026-09-19 and 2026-10-25, to 812. Every raise was ordinary growth,
        // new guards named for their invariants as the rule above asks, and
        // none was a restore. Whenever headroom ran out, the count failed
        // whoever added the next guard file, in the merge queue, for a reason
        // nothing in their diff showed (#4445's candidate hit it at 812). The
        // owner replaced it with this named list (2026-10-29, #4449): a
        // restore still fails, and a new guard trips nothing here. The raises
        // and their reasons are in this file's history.
        const present = guardPaths();

        // Zero is never complete: a read that missed a directory would pass
        // the assertion below for that directory while checking nothing.
        expect([...new Set(present.map((p) => path.dirname(p)))].sort()).toEqual(
            [...GUARD_DIRS].sort(),
        );

        const retired = new Set(RETIRED_GUARD_FILES.map((p) => path.basename(p)));
        const restored = present.filter((p) => retired.has(path.basename(p))).sort();

        expect({
            restored,
            hint:
                restored.length === 0
                    ? 'none'
                    : 'These guards were retired on purpose; RETIRED_GUARD_FILES names the commit ' +
                      'that deleted each. Do not bring one back. If it held a real invariant, ' +
                      'write a test named for that invariant, or an ESLint rule if it is structural.',
        }).toEqual({ restored: [], hint: 'none' });
    });

    it('the retired list is the record it claims to be', () => {
        // The list is history, so its length never moves. A shorter one is a
        // restore being let through, and a duplicate hides a missing entry.
        const basenames = RETIRED_GUARD_FILES.map((p) => path.basename(p));
        expect(RETIRED_GUARD_FILES.length).toBe(165);
        expect(new Set(basenames).size).toBe(RETIRED_GUARD_FILES.length);

        const outsideGuardDirs = RETIRED_GUARD_FILES.filter(
            (p) => !GUARD_DIRS.includes(path.dirname(p)) || !p.endsWith('.test.ts'),
        );
        expect(outsideGuardDirs).toEqual([]);
    });

    /**
     * The `rq*` family — the risk-quantification waves — is epic-named by
     * exactly the same logic as `b7-` or `epic55-`, but `^rq` was missing
     * from EPIC_NAME_PATTERNS above, so all 41 files sailed through the
     * 2026-08-05 retirement untouched. Adding the pattern outright would
     * turn CI red on 39 files at once, and several of them still hold the
     * only written record of a contract that has to be re-expressed as a
     * behavioural test before the file can go (see the Box 3 items:
     * bulkDeleteRisk cross-tenant rejection, computeVelocity,
     * getRiskPrivacyLens, the four rendered-test rewrites).
     *
     * So it is a DOWNWARD RATCHET instead — the same shape the repo uses
     * for `as any`. New `rq`-named guards are blocked today; the existing
     * ones come out in tranches, and each tranche lowers the number. It
     * only ever goes down.
     */
    it('the rq* family is on a downward ratchet, not a budget', () => {
        const RQ_CEILING = 35; // 2026-08-06: 41 -> 39 (B3-1) -> 37 (B3-3c, B3-4) -> 36 (B3-4 rendered rewrites). 2026-08-10: -> 35 (B3-5, rq3-ob-f split into a mount guard + the existing rendered test).
        const rqGuards = guardFiles()
            .filter((f) => /^rq\d/.test(f))
            .sort();

        expect({
            count: rqGuards.length,
            ceiling: RQ_CEILING,
            hint:
                rqGuards.length <= RQ_CEILING
                    ? 'ok'
                    : 'Do not add an rq-named guard. Name it for the invariant, ' +
                      'or write the behavioural test the ratchet was standing in for.',
        }).toEqual({ count: rqGuards.length, ceiling: RQ_CEILING, hint: 'ok' });

        // Slack cannot accumulate: retire files and lower the ceiling in the
        // same diff, or the next PR quietly inherits room to add one back.
        expect(rqGuards.length).toBe(RQ_CEILING);
    });
});
