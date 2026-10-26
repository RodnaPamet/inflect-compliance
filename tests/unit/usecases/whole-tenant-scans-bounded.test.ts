/**
 * Whole-tenant scans in the USECASE layer carry a cap.
 *
 * The Layer-D2 budget in `tests/guardrails/query-shape-guardrails.test.ts`
 * bounds unbounded `findMany` calls — but it scans
 * `src/app-layer/repositories`, so a whole-tenant read that lives in
 * `src/app-layer/usecases` is invisible to it. Three did:
 *
 *   - `listRisksWithDeleted` (risk.ts) — while its direct Controls twin
 *     `listControlsWithDeleted` was capped at FULL_SCAN_CAP (its read has
 *     since moved into `ControlRepository.listDeleted`). Worse than the
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
import { braceBlockAfter, functionBodyOf } from '../../helpers/source-blocks';

// #2246 Class A — `codeOf` masks comments at the READ SEAM, so this guard can
// no longer be satisfied by a COMMENT naming the thing its assertion is about.
// At the seam, not per assertion, so a new `expect(read(...))` inherits it.
// String literals are KEPT — masking them would silently empty assertions that
// harvest codes or ids from source. Every path this file reads is a
// TypeScript-alike, re-derived per file rather than assumed from the directory.
import { codeOf } from '../../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => codeOf(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const stripComments = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RISK = stripComments(read('src/app-layer/usecases/risk.ts'));
const CONTROL = stripComments(read('src/app-layer/usecases/control/queries.ts'));
const TENANT_ADMIN = stripComments(read('src/app-layer/usecases/tenant-admin.ts'));
const CONTROL_REPO = stripComments(read('src/app-layer/repositories/ControlRepository.ts'));

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
        //
        // Controls' read moved into `ControlRepository.listDeleted` (#4275),
        // where it carries its own `take:` and sits inside the D2 budget's
        // population. So the usecase must reach the repository, and the
        // repository method must be capped.
        const risks = functionBodyOf(RISK, 'listRisksWithDeleted');
        const controls = functionBodyOf(CONTROL, 'listControlsWithDeleted');
        expect(risks).toMatch(/take:\s*FULL_SCAN_CAP/);
        expect(controls).toMatch(/ControlRepository\.listDeleted\(/);
        // Anchored on the method body's own opening brace, past the
        // signature, so the `options` parameter's type literal is not taken
        // for the body.
        const repoRead = braceBlockAfter(
            CONTROL_REPO,
            '(?<=static async listDeleted\\([^)]*\\)\\s*)\\{',
        );
        expect(repoRead).toMatch(/where\.deletedAt\s*=\s*\{\s*not:\s*null\s*\}/);
        expect(repoRead).toMatch(/take:\s*options\.take\s*\?\?\s*\d+/);
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
