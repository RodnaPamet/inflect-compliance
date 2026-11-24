/**
 * The mobile E2E project's route set, its known defects and its ratchet.
 *
 * Read by `mobile-layout.spec.ts` (seeded tenant, read-only) and
 * `mobile-layout-records.spec.ts` (the P0 pages whose records the seed lacks,
 * created in an isolated tenant). Every metric is defined ONCE, in
 * `scripts/mobile-audit/measure.ts`, which the whole-product audit uses too.
 *
 * Two kinds of check run on every route below, in both configurations:
 *
 *   1. ZERO-TOLERANCE INVARIANTS — nothing interactive clipped outside a
 *      scroll container, no field under 16px, no floating overlay over a
 *      control at full scroll, no overflowing tab bar without a cue. A route
 *      that still breaks one is listed in `KNOWN_DEFECTS` with its issue: the
 *      spec then asserts the defect IS present, so the fix turns that
 *      assertion red until its entry is deleted (the per-defect form of
 *      `test.fail`).
 *
 *   2. THE RATCHET — the number of routes failing each ratcheted metric, per
 *      configuration, must EQUAL the baseline below. Higher is a regression.
 *      Lower is a fix, and it fails too until the baseline is lowered in the
 *      same diff, so no slack accumulates (`DRIFT_ALLOWANCE` is 0, as in the
 *      assertion-reach ratchets). Counts are routes failing, not elements,
 *      because a list page's element count moves with the seeded rows and a
 *      ratchet with no allowance must not move on data.
 *
 * Every route must capture: a route that fails to load fails the spec rather
 * than dropping out of a count, so a page that stops rendering cannot lower
 * a number.
 *
 * The baselines below are the ONLY place these figures are written down.
 */
import type { MobileMetricId, ZeroToleranceInvariant } from '../../scripts/mobile-audit/measure';
import type { PhoneConfigId } from '../../scripts/mobile-audit/configs';

/** Both widths, both themes, Bulgarian (the longer language, where wrapping breaks first). */
export const MOBILE_E2E_CONFIGS = ['390-dark-bg', '360-light-bg'] as const satisfies readonly PhoneConfigId[];
export type MobileE2eConfig = (typeof MOBILE_E2E_CONFIGS)[number];

export interface FixedRoute {
    /** A route pattern from `src/app` (filled by `scripts/mobile-audit/resolve.ts`) … */
    route: string;
    /** … optionally opened into one of `OPEN_STATES` (`scripts/mobile-audit/states.ts`). */
    state?: string;
    /** What this entry is here to hold: a shared primitive or a P0 page. */
    covers: string;
}

const T = '/t/[tenantSlug]';

/** Routes the seeded tenant already has data for. Read-only: nothing is created or changed. */
export const SEED_ROUTES: readonly FixedRoute[] = [
    { route: '/login', covers: 'fields on the sign-in form (iOS zoom)' },
    { route: `${T}/dashboard`, covers: 'app shell, phone top bar, KPI grid' },
    { route: `${T}/dashboard`, state: 'nav-drawer', covers: 'navigation drawer (Sheet)' },
    { route: `${T}/dashboard`, state: 'user-menu', covers: 'popover mobile drawer (P0 #1)' },
    { route: `${T}/dashboard`, state: 'command-palette', covers: 'command palette from the top bar' },
    { route: `${T}/dashboard`, state: 'assistant-sheet', covers: 'assistant entry point and sheet' },
    { route: `${T}/controls`, covers: 'mobile cards, filter toolbar, page header' },
    { route: `${T}/controls`, state: 'selection-toolbar', covers: 'selection toolbar / bulk actions (P0 #2)' },
    { route: `${T}/controls`, state: 'create-modal', covers: 'create modal as a bottom sheet' },
    { route: `${T}/risks`, covers: 'filter toolbar with chips' },
    { route: `${T}/tests`, covers: 'toggle group' },
    { route: `${T}/risks/hierarchy`, covers: 'toggle group in a card' },
    { route: `${T}/controls/[controlId]`, covers: 'detail tab strip (ScrollCueStrip), page header' },
    { route: `${T}/risks/[riskId]`, covers: 'detail tab strip, detail header' },
    { route: `${T}/frameworks/[frameworkKey]`, covers: 'page header actions' },
    { route: `${T}/processes`, covers: 'the processes tab strip' },
    { route: `${T}/tasks/[taskId]`, covers: 'P0 #3 task detail' },
    { route: `${T}/admin/integrations`, covers: 'P0 #5 integrations' },
    { route: `${T}/agents/runs`, covers: 'P0 #6 agent runs' },
    { route: `${T}/admin/vendor-templates/[templateId]`, covers: 'P0 #7 vendor template editor' },
    { route: `${T}/audits/cycles/[cycleId]/readiness`, covers: 'P0 #8 audit-cycle readiness' },
];

/** P0 pages whose records the seed does not have; the spec creates them in an isolated tenant. */
export const RECORD_ROUTES: readonly FixedRoute[] = [
    { route: `${T}/controls/[controlId]/tests/[planId]`, covers: 'P0 #4 test-plan detail (control route)' },
    { route: `${T}/tests/plans/[planId]`, covers: 'P0 #4 test-plan detail (tests route)' },
    { route: `${T}/audits/business-continuity/[id]`, covers: 'P0 #9 BIA detail' },
];

/** The key a route or open state is reported under: `pattern` or `pattern#state`. */
export const fixedRouteKey = (r: FixedRoute): string => (r.state ? `${r.route}#${r.state}` : r.route);

export interface KnownDefect {
    key: string;
    invariant: ZeroToleranceInvariant;
    /** Configurations it shows in; every E2E configuration when absent. */
    configs?: readonly MobileE2eConfig[];
    /** The open issue that fixes it. */
    issue: number;
}

/**
 * Zero-tolerance invariants a fixed route still breaks today. Delete an entry
 * in the PR that fixes it: the spec asserts the defect is still present.
 */
export const KNOWN_DEFECTS: readonly KnownDefect[] = [];

/** The metrics the ratchet holds, beside the four invariants it also counts. */
export const RATCHETED_METRICS = [
    'clipped',
    'inputUnder16',
    'overlayCoversControl',
    'overlayCoversText',
    'tabsNoCue',
    'tapUnder24',
    'englishLeaks',
] as const satisfies readonly MobileMetricId[];
export type RatchetedMetric = (typeof RATCHETED_METRICS)[number];

/** No slack: a fix lowers its baseline in the same diff. */
export const DRIFT_ALLOWANCE = 0;

type Baseline = Record<MobileE2eConfig, Record<RatchetedMetric, number>>;

/**
 * Routes in `SEED_ROUTES` failing each metric.
 *
 * englishLeaks, 0 (#5828): no fixed route shows English in Bulgarian. The
 * last five were the command palette's shortcut list ("Close navigation
 * drawer"), the risks list's free-text owner "Infrastructure" (tenant data,
 * now in `dataNames`), the framework explorer's "Compliance status: Partial /
 * Gap", and the ISO 27001 domain names in the controls browse rail (the list
 * and its selection state) — the rail renders only when the shared tenant
 * holds ISO controls, which other E2E specs install before this one runs.
 *
 * tapUnder24, 9 (#5869): 10 until the harness stopped counting what is not a
 * defect. The create sheet's only small "control" was the Radix RadioGroup
 * root, which takes focus for its radios and is not a control itself. On the
 * controls list the selection circles are now measured by the 44px wrapper
 * that takes the tap.
 *
 * tapUnder24, 3 (#5873, #5876, #5878, #5881, #5885): 9 until the tap-target
 * batch. A clickable list card's title is text (the card is the one target);
 * stand-alone small links are `TextLink`, the toast close and the slider thumb
 * wear the touch hit area, the stepper is 48px on touch, native choice inputs
 * are the Radix primitives. The three left are other issues' surfaces: the
 * dashboard's chart marks (#5877), the command palette's 23px search field
 * and the risk score's help button. The framework explorer's tree toggles
 * went with #5889 (44px rows and chevrons on a coarse pointer).
 *
 * tapUnder24, 1 (#5884): 3 until the score chip on `risks/[riskId]` ("16 ·
 * Критичен, обяснение", 16px tall) wore the shared touch hit area and the
 * command palette's 23px search field took the search bar's full height. The
 * one left is the dashboard's chart marks and legend links (#5877).
 *
 * clipped, 0 (#5875, with #5874 and #5879): the last one was the integrations
 * page's webhook URL, a `<code>` with no space to break at. `code`, `samp` and
 * `.font-mono` now wrap anywhere (`src/app/globals.css`).
 */
export const SEED_BASELINE: Baseline = {
    '390-dark-bg': { clipped: 0, inputUnder16: 0, overlayCoversControl: 0, overlayCoversText: 0, tabsNoCue: 0, tapUnder24: 1, englishLeaks: 0 },
    '360-light-bg': { clipped: 0, inputUnder16: 0, overlayCoversControl: 0, overlayCoversText: 0, tabsNoCue: 0, tapUnder24: 1, englishLeaks: 0 },
};

/** Routes in `RECORD_ROUTES` failing each metric. */
export const RECORDS_BASELINE: Baseline = {
    '390-dark-bg': { clipped: 0, inputUnder16: 0, overlayCoversControl: 0, overlayCoversText: 0, tabsNoCue: 0, tapUnder24: 0, englishLeaks: 0 },
    '360-light-bg': { clipped: 0, inputUnder16: 0, overlayCoversControl: 0, overlayCoversText: 0, tabsNoCue: 0, tapUnder24: 0, englishLeaks: 0 },
};
