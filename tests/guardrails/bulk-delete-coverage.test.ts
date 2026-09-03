/**
 * Bulk-delete coverage ratchet.
 *
 * Every entity with a row-select action bar (asset, risk, control, task,
 * test plan, evidence, policy, vendor) must expose a bulk "Delete" action
 * that soft-deletes the selected rows behind a confirmation dialog. This
 * guard locks: the per-entity usecase, the bulk/delete route, the Zod
 * schema, the list-page action wiring, the shared confirm support, and the
 * ControlTestPlan soft-delete enrolment.
 *
 * WHAT THIS IS AND ISN'T (2026-08-06). This is a SET-COMPLETENESS guard —
 * it answers "does every selectable entity have a bulk delete?", which no
 * per-entity test can answer, because the failure it catches is a NEW
 * entity shipping without one. It is deliberately shallow per entity.
 *
 * It is not a substitute for depth. `bulkDeleteRisk` now has a two-tenant
 * behavioural test at `tests/integration/risk-bulk-ops.test.ts` proving a
 * foreign id cannot delete a foreign row — the question that actually
 * matters for a destructive cross-tenant path, and one this file cannot
 * ask. The risk row stays here anyway: dropping it would not remove a
 * duplicated assertion, it would punch a hole in the set. The other seven
 * entities deserve the same behavioural depth; that is a coverage gap to
 * fill, not a reason to shrink this list.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { codeOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
// Every read below is masked for comments, so a commented-out bulk action or
// a prose mention of `bulkDeleteX` cannot satisfy an assertion about code.
const read = (rel: string) => codeOf(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

const ENTITIES = [
    { usecase: 'bulkDeleteAsset', schema: 'BulkAssetDeleteSchema', page: 'src/app/t/[tenantSlug]/(app)/assets/AssetsClient.tsx' },
    { usecase: 'bulkDeleteRisk', schema: 'BulkRiskDeleteSchema', page: 'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx' },
    { usecase: 'bulkDeleteControl', schema: 'BulkControlDeleteSchema', page: 'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx' },
    { usecase: 'bulkDeleteTask', schema: 'BulkTaskDeleteSchema', page: 'src/app/t/[tenantSlug]/(app)/tasks/TasksClient.tsx' },
    { usecase: 'bulkDeleteTestPlan', schema: 'BulkTestPlanDeleteSchema', page: 'src/app/t/[tenantSlug]/(app)/tests/page.tsx' },
    { usecase: 'bulkDeleteEvidence', schema: 'BulkEvidenceDeleteSchema', page: 'src/app/t/[tenantSlug]/(app)/evidence/EvidenceClient.tsx' },
    { usecase: 'bulkDeletePolicy', schema: 'BulkPolicyDeleteSchema', page: 'src/app/t/[tenantSlug]/(app)/policies/PoliciesClient.tsx' },
    { usecase: 'bulkDeleteVendor', schema: 'BulkVendorDeleteSchema', page: 'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx' },
];

function walk(dir: string, acc: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, acc);
        else acc.push(full);
    }
    return acc;
}

describe('bulk-delete coverage', () => {
    const usecaseSrc = walk(path.join(ROOT, 'src/app-layer/usecases'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => codeOf(fs.readFileSync(f, 'utf8')))
        .join('\n');
    const schemas = read('src/lib/schemas/index.ts');

    it.each(ENTITIES)('$usecase: usecase + schema exist', ({ usecase, schema }) => {
        expect(usecaseSrc).toContain(`export async function ${usecase}(`);
        expect(schemas).toContain(`export const ${schema}`);
    });

    it.each(ENTITIES)('$usecase: list page declares a delete bulk action', ({ page }) => {
        const src = read(page);
        expect(src).toMatch(/value:\s*'delete'/);
        expect(src).toMatch(/entityLabel=/);
        expect(src).toMatch(/selectedCount=/);
    });

    it('the Controls delete verb is gated on admin, not merely present', () => {
        // The assertion above matches the 'delete' LITERAL, which used to sit
        // inside `...(canAdmin ? [{ value: 'delete', … }] : [])`. Removing the
        // canAdmin guard left the literal in place and kept this suite green —
        // so the gate protecting an ADMIN-only server verb had no test at all.
        //
        // The role decision now lives in _lib/bulk-action-policy and is
        // asserted per role in tests/unit/controls-bulk-action-policy.test.ts.
        // This checks the page actually DEFERS to it, which the literal match
        // cannot tell you.
        const src = read('src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx');
        expect(src).toMatch(/controlBulkActionsFor\(/);
        expect(src).toMatch(/allowedBulkActions\.includes\(/);
    });

    it('there are 8 bulk/delete API routes', () => {
        const routes = walk(path.join(ROOT, 'src/app/api'))
            .filter((f) => /[/\\]bulk[/\\]delete[/\\]route\.ts$/.test(f));
        expect(routes.length).toBe(8);
        // each calls a bulkDelete usecase
        for (const r of routes) {
            expect(codeOf(fs.readFileSync(r, 'utf8'))).toMatch(/bulkDelete[A-Z]/);
        }
    });

    it('every bulk-delete usecase soft-deletes via deleteMany + audits', () => {
        for (const { usecase } of ENTITIES) {
            const start = usecaseSrc.indexOf(`export async function ${usecase}(`);
            expect(start).toBeGreaterThan(-1);
            // Extract the WHOLE function body — from its declaration to the
            // next top-level `export async function` (or EOF). A fixed-size
            // char window silently truncates once a body grows: e.g.
            // bulkDeleteControl now builds a per-id verdict array and wraps
            // the delete+audit in an `if (rows.length > 0) { … }`, pushing
            // the audit past a naïve window while it stays firmly inside the
            // function. Scanning the real body keeps the check honest.
            const rest = usecaseSrc.slice(start + 1);
            const nextIdx = rest.indexOf('export async function ');
            const body = nextIdx === -1 ? usecaseSrc.slice(start) : usecaseSrc.slice(start, start + 1 + nextIdx);
            expect(body).toMatch(/\.deleteMany\(/);
            expect(body).toMatch(/action:\s*'SOFT_DELETE'/);
        }
    });

    it('BulkActionBar supports a confirm dialog for destructive actions (danger is the default tone)', () => {
        const bar = read('src/components/ui/bulk-action-bar.tsx');
        expect(bar).toMatch(/confirm\?:/);
        expect(bar).toMatch(/Modal\.Confirm/);
        // The confirm dialog now takes a per-action tone; `confirm: true`
        // (a bare bulk Delete) still resolves to the danger tone by default.
        expect(bar).toMatch(/tone=\{tone\}/);
        expect(bar).toMatch(/cfg\.tone \?\? 'danger'/);
    });

    it('ControlTestPlan is enrolled in SOFT_DELETE_MODELS', () => {
        expect(read('src/lib/soft-delete.ts')).toContain("'ControlTestPlan'");
    });
});
