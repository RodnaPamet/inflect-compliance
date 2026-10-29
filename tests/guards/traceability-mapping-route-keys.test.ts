/**
 * Every traceability mapping route is gated on the key of the entity you edit
 * FROM (#4413, owner decision 2026-10-27).
 *
 * ─── WHY A GUARD AND NOT JUST THE UNIT TESTS ────────────────────────────
 *
 * `usecases/traceability.test.ts` covers the ASSERTS. What it cannot see is
 * whether the ROUTE above each one still carries a `requirePermission`, and
 * measured on this branch: stripping the gate off `POST /assets/:id/controls`
 * left 318 tests green across all three authorization guardrails.
 *
 * That is not a hole in those guardrails — it is their stated design.
 * `api-route-has-some-authorization` is LAYER 2 and passes a handler that
 * reaches any permission decision, which the usecase assert does. And layer 1,
 * `api-permission-coverage`, scopes itself to `src/app/api/t/[tenantSlug]/admin/`
 * — "intentionally narrow for Epic C.1", with widening deferred. These six
 * routes sit outside both populations, so they need their own pin.
 *
 * ─── WHAT THE KEY MEANS ─────────────────────────────────────────────────
 *
 * The route's own path says which entity you are editing: `/assets/:id/risks`
 * hangs off the asset, `/controls/:id/risks` off the control. That is the FROM
 * entity, and its `edit` key is the gate. This supersedes #2117's rule ("the
 * CONTROL side governs a mapping where a control is one end"), which is why
 * `DELETE /assets/:id/controls/:controlId` moved from `controls.edit` to
 * `assets.edit` — see that file's docblock.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const API = 'src/app/api/t/[tenantSlug]';

/**
 * Every write route that draws or removes a traceability line.
 *
 * Spelled out rather than looped: a path built from a loop variable is
 * `path-not-constant` to `assertion-needle-uniqueness-ratchet`, and an
 * interpolated regex is `needle-interpolated` — both land in the un-analysable
 * bucket, which is the blind spot where an ambiguous needle hides. Six literal
 * reads with two literal needles each cost a few lines and stay readable to it.
 */
const ROUTES = {
    assetRisks: 'assets/[id]/risks/route.ts',
    assetRisk: 'assets/[id]/risks/[riskId]/route.ts',
    assetControls: 'assets/[id]/controls/route.ts',
    assetControl: 'assets/[id]/controls/[controlId]/route.ts',
    controlRisks: 'controls/[controlId]/risks/route.ts',
    controlRisk: 'controls/[controlId]/risks/[riskId]/route.ts',
} as const;

const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, API, rel), 'utf8'));

describe('traceability mapping routes are gated on the FROM entity', () => {
    it('finds the population it is about — otherwise every case below is vacuous', () => {
        const files = Object.values(ROUTES);
        expect(files).toHaveLength(6);
        for (const f of files) {
            expect(fs.existsSync(path.join(ROOT, API, f))).toBe(true);
        }
    });

    // `requirePermission<` names the CALL and occurs once per file — the import
    // carries no type argument. The key literal occurs once as well.
    it('POST /assets/:id/risks asks assets.edit', () => {
        const src = read('assets/[id]/risks/route.ts');
        expect(src).toContain('requirePermission<');
        expect(src).toContain("'assets.edit'");
        expect(src).not.toContain("'controls.edit'");
    });

    it('DELETE /assets/:id/risks/:riskId asks assets.edit', () => {
        const src = read('assets/[id]/risks/[riskId]/route.ts');
        expect(src).toContain('requirePermission<');
        expect(src).toContain("'assets.edit'");
        expect(src).not.toContain("'controls.edit'");
    });

    it('POST /assets/:id/controls asks assets.edit, not the other end', () => {
        const src = read('assets/[id]/controls/route.ts');
        expect(src).toContain('requirePermission<');
        expect(src).toContain("'assets.edit'");
        expect(src).not.toContain("'controls.edit'");
    });

    it('DELETE /assets/:id/controls/:controlId asks assets.edit — #4413 over #2117', () => {
        // This is the one that moved. #2117 settled "the CONTROL side governs a
        // mapping where a control is one end"; the owner's 2026-10-27 ruling
        // replaced that with the FROM entity, so this pair stopped disagreeing
        // with itself.
        const src = read('assets/[id]/controls/[controlId]/route.ts');
        expect(src).toContain('requirePermission<');
        expect(src).toContain("'assets.edit'");
        expect(src).not.toContain("'controls.edit'");
    });

    it('POST /controls/:id/risks asks controls.edit', () => {
        const src = read('controls/[controlId]/risks/route.ts');
        expect(src).toContain('requirePermission<');
        expect(src).toContain("'controls.edit'");
        expect(src).not.toContain("'assets.edit'");
    });

    it('DELETE /controls/:id/risks/:riskId asks controls.edit', () => {
        const src = read('controls/[controlId]/risks/[riskId]/route.ts');
        expect(src).toContain('requirePermission<');
        expect(src).toContain("'controls.edit'");
        expect(src).not.toContain("'assets.edit'");
    });

    it('the usecase behind them reads a KEY, never a role name', () => {
        const usecase = codeOf(
            fs.readFileSync(path.join(ROOT, 'src/app-layer/usecases/traceability.ts'), 'utf8'),
        );
        // The ASSIGNMENTS, which occur once each — a bare `assertCanEditAsset`
        // matches its import too. Positive on purpose: a negated whole-file
        // read is taken against masked text, which Class D scores as
        // un-analysable, and it buys nothing here — an assignment TO these
        // asserts is incompatible with the role-name check that used to sit in
        // the same place, and `usecases/traceability.test.ts` fails
        // behaviourally if it returns.
        expect(usecase).toContain('const assertCanMapFromAsset = assertCanEditAsset;');
        expect(usecase).toContain('const assertCanMapFromControl = assertCanUpdateControl;');
    });
});
