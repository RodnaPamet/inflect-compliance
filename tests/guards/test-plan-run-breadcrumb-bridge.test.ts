/**
 * PR-Z item 5 — the test-plan / test-run route-split bridge.
 *
 * The PLAN lives under `/controls/{controlId}/tests/{planId}` (and the
 * tenant-wide twin `/tests/plans/{planId}`) while its RUNS live at the
 * top-level `/tests/runs/{runId}`. That split is DELIBERATE — moving the
 * routes is riskier than it is worth — and the deferral was re-confirmed in
 * PR-Z on the strength of one mitigation: **the run page's breadcrumb trail
 * bridges back through the control's plan**, so hopping plan → run never
 * silently drops the control context.
 *
 * That mitigation is the whole reason the deferral is acceptable, so it is
 * locked here. If someone strips the control-scoped crumb from the run page,
 * the split stops being navigable and this fails — forcing either a fix or a
 * conscious re-decision (rather than a silent UX regression).
 */
import * as fs from 'fs';
import * as path from 'path';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const readRaw = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');
const read = (p: string) => codeOf(readRaw(p));
// `readDoc` is the DELIBERATE raw seam (#2246). Masking comments is the right
// default, but an assertion whose SUBJECT is the prose inverts the defect: the
// text it names is the very text masking blanks, so the assertion could never
// pass (or, for a negative, never fail) again. Named, so the choice is visible.
const readDoc = (p: string) => readRaw(p);
const RUN_PAGE = 'src/app/t/[tenantSlug]/(app)/tests/runs/[runId]/page.tsx';
const CONTROL_PLAN_PAGE = 'src/app/t/[tenantSlug]/(app)/controls/[controlId]/tests/[planId]/page.tsx';

describe('test-plan ↔ run route split — breadcrumb bridge', () => {
    it('the run page breadcrumbs link back through the control-scoped plan', () => {
        const src = read(RUN_PAGE);
        // The crumb must rebuild the CONTROL-scoped plan href — not the
        // tenant-wide /tests/plans/{id} twin, which would drop the control.
        expect(src).toMatch(/\/controls\/\$\{[^}]*controlId\}\/tests\/\$\{[^}]*testPlanId\}/);
        // …and it must be conditional on the run actually carrying that context.
        expect(src).toMatch(/run\?\.controlId\s*&&\s*run\?\.testPlanId/);
    });

    it('the run page also crumbs up to the controls register', () => {
        const src = read(RUN_PAGE);
        expect(src).toMatch(/tenantHref\('\/controls'\)/);
    });

    it('both plan entry points still exist (the split is intentional, not accidental)', () => {
        expect(fs.existsSync(path.join(ROOT, CONTROL_PLAN_PAGE))).toBe(true);
        expect(
            fs.existsSync(path.join(ROOT, 'src/app/t/[tenantSlug]/(app)/tests/plans/[planId]/page.tsx')),
        ).toBe(true);
        // The control-scoped entry documents WHY the split stands.
        expect(readDoc(CONTROL_PLAN_PAGE)).toMatch(/deliberate/i);
    });
});
