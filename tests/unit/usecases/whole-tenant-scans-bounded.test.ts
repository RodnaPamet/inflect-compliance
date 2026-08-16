/**
 * Whole-tenant scans in the USECASE layer carry a cap.
 *
 * The Layer-D2 budget in `tests/guardrails/query-shape-guardrails.test.ts`
 * bounds unbounded `findMany` calls — but it scans
 * `src/app-layer/repositories`, so a whole-tenant read that lives in
 * `src/app-layer/usecases` is invisible to it. Three did:
 *
 *   - `listRisksWithDeleted` (risk.ts) — while its direct Controls twin
 *     `listControlsWithDeleted` was capped at FULL_SCAN_CAP. Worse than the
 *     twin: no `select`, so it returns full rows, and `Risk` carries
 *     encrypted columns, so the Epic-B middleware decrypts `treatmentNotes`
 *     on every row.
 *   - `listTenantMembers` (tenant-admin.ts) — backs /admin/members.
 *   - `listAssignableUsers` (tenant-admin.ts) — the highest-traffic of the
 *     three; it feeds every UserCombobox in the product.
 *
 * Asserted against the query shape rather than behaviourally: these are
 * DB-backed usecases, and the invariant being protected is precisely "the
 * findMany carries a take:", which is what a future edit would drop. Bounded
 * per-function via `functionBodyOf` so a cap belonging to a NEIGHBOUR cannot
 * satisfy the assertion — the failure mode that made an earlier whole-file
 * count in this repo vacuous.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { functionBodyOf } from '../../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RISK = stripComments(read('src/app-layer/usecases/risk.ts'));
const CONTROL = stripComments(read('src/app-layer/usecases/control/queries.ts'));
const TENANT_ADMIN = stripComments(read('src/app-layer/usecases/tenant-admin.ts'));

describe('usecase-layer whole-tenant scans are bounded', () => {
    it.each([
        ['listRisksWithDeleted', () => RISK],
        ['listTenantMembers', () => TENANT_ADMIN],
        ['listAssignableUsers', () => TENANT_ADMIN],
    ])('%s caps its findMany', (fn, src) => {
        expect(functionBodyOf(src(), fn)).toMatch(/take:\s*[A-Z_]+/);
    });

    it('the recycle-bin twins agree — risks is capped like controls', () => {
        // These two are the same view over two entities. Only one was capped,
        // which is the shape of a fix applied to one side of a pair.
        const risks = functionBodyOf(RISK, 'listRisksWithDeleted');
        const controls = functionBodyOf(CONTROL, 'listControlsWithDeleted');
        expect(risks).toMatch(/take:\s*FULL_SCAN_CAP/);
        expect(controls).toMatch(/take:\s*FULL_SCAN_CAP/);
    });

    it('the caps are real constants, not inline magic numbers', () => {
        // A literal `take: 5000` at three call sites is three things to keep
        // in step; the named constant carries the reasoning at one place.
        expect(RISK).toMatch(/const FULL_SCAN_CAP = \d+;/);
        expect(TENANT_ADMIN).toMatch(/const MEMBERSHIP_SCAN_CAP = \d+;/);
    });

    it("documents D2's blind spot, so nobody assumes the budget covers this", () => {
        // If D2 ever grows to scan usecases/, this file becomes redundant and
        // should be deleted rather than left as a second source of truth.
        const guardrail = read('tests/guardrails/query-shape-guardrails.test.ts');
        expect(guardrail).toMatch(/app-layer\/repositories/);
        expect(guardrail).not.toMatch(/REPO_DIRS[^\n]*usecases/);
    });
});
