/**
 * Rendered / browser coverage floor — a STAGED UPWARD ratchet.
 *
 * Roadmap-4 made the behavioural-coverage registry an append-only
 * list of named high-risk primitives. What it did NOT do is stop the
 * rendered- and E2E-test *population* from shrinking: a PR could
 * delete a dozen `tests/rendered/` files and every structural
 * ratchet would stay green.
 *
 * This guard is the opposite of the `as any` ratchet. That one is a
 * downward ratchet — debt must only shrink. This is an UPWARD
 * ratchet — real-behaviour verification must only grow:
 *
 *   1. The count of rendered behavioural tests, E2E specs, and
 *      registered high-risk primitives must each stay AT OR ABOVE a
 *      floor. Deleting verification trips CI.
 *   2. A slack sentinel: when the live count runs well above its
 *      floor, the floor MUST be raised in the same PR. That is the
 *      "staged" part — added verification is locked in as the new
 *      minimum, so a later PR cannot silently spend the surplus.
 *
 * Floors only ever move UP. After a PR that adds rendered/E2E tests,
 * raise the matching floor here to the new count.
 *
 * See docs/verification-policy.md and docs/frontend-assurance-model.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');

/**
 * Coverage floors. UPWARD ratchet — only ever edited higher, in the
 * same PR that adds the tests. History:
 *   • 2026-05-22 — Roadmap-7 P4: established at the post-roadmap-4
 *     population (126 rendered / 36 E2E / 5 registered primitives).
 */
// Bumped 126 → 135 by the edit-columns gear-fix repro test +
// other recent additions across the parity roadmap PRs.
//
// R31 (Bundle 1) — adjusted 135 → 134. The
// `tests/rendered/canvas-help-strip.test.tsx` rendered test
// was retired alongside the `CanvasHelpStrip` component (the
// "one message per state" design verdict moved the onboarding
// affordance into the empty-state hint at canvas-bottom-centre).
// This is the documented exception the rendered-floor ratchet
// explicitly contemplates: "if a test was legitimately merged
// or renamed, account for it." The floor will resume its
// upward-only ratchet from 134 on the next addition.
// Raised 134 → 143 (2026-06-03): button icon-as-child row test +
// accumulated rendered-test gains since the last bump.
// Raised 143 → 152 (2026-06-06): asset/risk modal-field, asset-criticality,
// and asset-KPI-trendline rendered tests.
// Raised 173 → 182 (2026-06-17): donut hover-stable-hit + data-table
// prefetch + accumulated rendered-test gains.
// Raised 182 → 194 (2026-06-25): coverage Wave D batch 4 added five
// renderHook tests for lib hooks/processes — useUrlFilters,
// use-canvas-history, use-canvas-autosave, use-canvas-drill-stack,
// canvas-change-events — plus accumulated rendered-test gains.
// Briefly 202 (2026-06-29): a UI list-client rendered-test sweep was
// reverted — those tests exercise UI files that are NOT in the backend
// coverage denominator (collectCoverageFrom = src/app-layer + src/lib),
// so they diluted rather than raised the global gate. Floor restored to
// 194; backend coverage is the correct lever.
//   The reasoning was right and the premise was not, which is worth
//   knowing before anyone re-runs the experiment. `collectCoverageFrom`
//   was declared on the project blocks, where Jest never reads it, so
//   the resolved scope was empty and the report was whatever the suite
//   imported — those UI files WERE in the denominator, which is exactly
//   why the sweep diluted the gate. Corrected 2026-08-11; the scope now
//   resolves, so a rendered test moves `global` by zero in either
//   direction. See docs/implementation-notes/2026-08-11-coverage-scope-restored.md.
// 203 (2026-08-04): the posture-hero ladder-agreement suite. It locks the
// dial and the list beneath it to ONE level per axis — the surfaces
// disagreed in production (a 97% Tasks axis plotted on the outer ring
// while the list said L4), and only a rendered assertion catches that,
// since both surfaces are correct in isolation.
// 221 (2026-08-11): the Risks write surface. Failed-write behaviour
// (error visible, input survives), the permission gates that mirror
// `assertCanWrite`/`assertCanAdmin`, and the loss-events + scenarios
// pages themselves — the latter two written to repay the coverage their
// first mount enrolled. See
// docs/implementation-notes/2026-08-11-coverage-gate-enrolment.md.
const RENDERED_TEST_FLOOR = 221;
// Raised 36 → 37 (2026-06-20): page-load-budget.spec.ts — the per-route
// server-TTFB probe for the "instant pages" performance loop.
// Raised 37 → 42 (2026-06-27): tracks accumulated E2E growth incl. the
// NIS2 self-assessment spec — locks the gains in as the new minimum.
const E2E_SPEC_FLOOR = 42;
const REGISTRY_FLOOR = 5;

/** Max a live count may exceed its floor before the floor must rise. */
const SLACK = { rendered: 8, e2e: 4, registry: 3 } as const;

function countFiles(rel: string, suffix: string): number {
    const dir = path.join(ROOT, rel);
    return fs.readdirSync(dir).filter((f) => f.endsWith(suffix)).length;
}

function registrySize(): number {
    const src = fs.readFileSync(
        path.join(ROOT, 'tests/guards/behavioural-coverage-registry.test.ts'),
        'utf8',
    );
    return (src.match(/primitive:\s*'/g) ?? []).length;
}

describe('rendered / browser coverage floor — staged upward ratchet', () => {
    const rendered = countFiles('tests/rendered', '.test.tsx');
    const e2e = countFiles('tests/e2e', '.spec.ts');
    const registry = registrySize();

    it.each([
        ['rendered behavioural tests', rendered, RENDERED_TEST_FLOOR],
        ['E2E specs', e2e, E2E_SPEC_FLOOR],
        ['registered high-risk primitives', registry, REGISTRY_FLOOR],
    ])('%s count (%d) stays at or above its floor (%d)', (label, count, floor) => {
        if (count < floor) {
            throw new Error(
                `${label}: count ${count} fell below the floor ${floor}. ` +
                    `Real-behaviour verification must not shrink — restore ` +
                    `the deleted test(s), or, if a test was legitimately ` +
                    `merged/renamed, account for it. This floor only moves up.`,
            );
        }
        expect(count).toBeGreaterThanOrEqual(floor);
    });

    it.each([
        ['RENDERED_TEST_FLOOR', rendered, RENDERED_TEST_FLOOR, SLACK.rendered],
        ['E2E_SPEC_FLOOR', e2e, E2E_SPEC_FLOOR, SLACK.e2e],
        ['REGISTRY_FLOOR', registry, REGISTRY_FLOOR, SLACK.registry],
    ])('%s has no accumulated slack — raise it as coverage grows', (name, count, floor, slack) => {
        if (count - floor > slack) {
            throw new Error(
                `${name} is ${floor} but the live count is ${count} ` +
                    `(slack ${count - floor} > ${slack}). Raise ${name} to ` +
                    `${count} in this PR so the added verification is locked ` +
                    `in as the new minimum — an upward ratchet only works if ` +
                    `the floor tracks the gains.`,
            );
        }
        expect(count - floor).toBeLessThanOrEqual(slack);
    });

    it('the floors are a genuine population, not a vacuous zero', () => {
        // Guards against the whole ratchet being neutered to 0/0/0.
        expect(RENDERED_TEST_FLOOR).toBeGreaterThan(100);
        expect(E2E_SPEC_FLOOR).toBeGreaterThan(20);
        expect(REGISTRY_FLOOR).toBeGreaterThanOrEqual(5);
    });
});
