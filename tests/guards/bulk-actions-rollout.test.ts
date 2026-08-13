/**
 * Canonical BulkActionBar rollout — Risk / Control / Vendor / Test plan.
 *
 * Phase 1 extracted <BulkActionBar> from Tasks; Phase 2 wired Assets
 * (tests/guards/bulk-asset.test.ts). This guard locks the next wave: the
 * four entities below each get bulk Set-status + Assign-owner backed by a
 * tenant-scoped `updateMany` (never a per-id loop), the same primitive in
 * `selectionControls`, and a batch-capped enum'd Zod schema.
 *
 * Evidence + Policy (assign-focused, workflow-gated status) and Audits
 * (no owner, sequential lifecycle, no DataTable yet) ship separately.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { functionBodyOf } from '../helpers/source-blocks';

const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

interface EntitySpec {
    name: string;
    statusRoute: string;
    assignRoute: string;
    usecaseFile: string;
    statusFn: RegExp;
    assignFn: RegExp;
    permission: RegExp;
    repoBulkCall: RegExp;
    repoFile: string;
    schemaStatus: RegExp;
    schemaAssign: RegExp;
    statusEnum: RegExp;
    clientFile: string;
    /**
     * The DESTRUCTIVE bulk verb and the admin-shaped gate it must carry.
     *
     * `permission` above covers set-status and assign, which are gated on a
     * plain write by design — pausing or reassigning is recoverable. Deleting
     * the register is not, so every entity gates it on an ADMIN assertion.
     * Nothing asserted that until now: `assertCanBulkManageTestPlans` had four
     * references in `src/` and zero in `tests/`, and this file's `permission`
     * regex is matched against the WHOLE usecase file — so a bulk-delete with
     * no gate at all still passed, as long as some other function in the file
     * asserted something.
     */
    deleteFn: string;
    deletePermission: RegExp;
}

const ENTITIES: EntitySpec[] = [
    {
        name: 'Risk',
        statusRoute: 'src/app/api/t/[tenantSlug]/risks/bulk/status/route.ts',
        assignRoute: 'src/app/api/t/[tenantSlug]/risks/bulk/assign/route.ts',
        usecaseFile: 'src/app-layer/usecases/risk.ts',
        statusFn: /export async function bulkSetRiskStatus/,
        assignFn: /export async function bulkAssignRisk/,
        permission: /assertCanWrite\(ctx\)/,
        repoBulkCall: /RiskRepository\.bulkUpdate/,
        repoFile: 'src/app-layer/repositories/RiskRepository.ts',
        schemaStatus: /BulkRiskStatusSchema/,
        schemaAssign: /BulkRiskAssignSchema/,
        statusEnum: /z\.enum\(\[\s*'OPEN'/,
        clientFile: 'src/app/t/[tenantSlug]/(app)/risks/RisksClient.tsx',
        deleteFn: 'bulkDeleteRisk',
        deletePermission: /assertCanAdmin\(ctx\)/,
    },
    {
        name: 'Control',
        statusRoute: 'src/app/api/t/[tenantSlug]/controls/bulk/status/route.ts',
        assignRoute: 'src/app/api/t/[tenantSlug]/controls/bulk/assign/route.ts',
        usecaseFile: 'src/app-layer/usecases/control/mutations.ts',
        statusFn: /export async function bulkSetControlStatus/,
        assignFn: /export async function bulkAssignControl/,
        permission: /assertCanUpdateControl\(ctx\)/,
        repoBulkCall: /ControlRepository\.bulkUpdate/,
        repoFile: 'src/app-layer/repositories/ControlRepository.ts',
        schemaStatus: /BulkControlStatusSchema/,
        schemaAssign: /BulkControlAssignSchema/,
        statusEnum: /'NOT_STARTED'/,
        clientFile: 'src/app/t/[tenantSlug]/(app)/controls/ControlsClient.tsx',
        deleteFn: 'bulkDeleteControl',
        deletePermission: /assertCanAdmin\(ctx\)/,
    },
    {
        name: 'Vendor',
        statusRoute: 'src/app/api/t/[tenantSlug]/vendors/bulk/status/route.ts',
        assignRoute: 'src/app/api/t/[tenantSlug]/vendors/bulk/assign/route.ts',
        usecaseFile: 'src/app-layer/usecases/vendor.ts',
        statusFn: /export async function bulkSetVendorStatus/,
        assignFn: /export async function bulkAssignVendor/,
        permission: /assertCanManageVendors\(ctx\)/,
        repoBulkCall: /VendorRepository\.bulkUpdate/,
        repoFile: 'src/app-layer/repositories/VendorRepository.ts',
        schemaStatus: /BulkVendorStatusSchema/,
        schemaAssign: /BulkVendorAssignSchema/,
        statusEnum: /z\.enum\(\['ACTIVE', 'ONBOARDING', 'OFFBOARDING', 'OFFBOARDED'\]\)/,
        clientFile: 'src/app/t/[tenantSlug]/(app)/vendors/VendorsClient.tsx',
        deleteFn: 'bulkDeleteVendor',
        deletePermission: /assertCanAdmin\(ctx\)/,
    },
    {
        name: 'Test plan',
        statusRoute: 'src/app/api/t/[tenantSlug]/tests/plans/bulk/status/route.ts',
        assignRoute: 'src/app/api/t/[tenantSlug]/tests/plans/bulk/assign/route.ts',
        usecaseFile: 'src/app-layer/usecases/control/test-plans.ts',
        statusFn: /export async function bulkSetTestPlanStatus/,
        assignFn: /export async function bulkAssignTestPlan/,
        permission: /assertCanManageTestPlans\(ctx\)/,
        repoBulkCall: /TestPlanRepository\.bulkUpdate/,
        repoFile: 'src/app-layer/repositories/TestPlanRepository.ts',
        schemaStatus: /BulkTestPlanStatusSchema/,
        schemaAssign: /BulkTestPlanAssignSchema/,
        statusEnum: /z\.enum\(\['ACTIVE', 'PAUSED', 'ARCHIVED'\]\)/,
        clientFile: 'src/app/t/[tenantSlug]/(app)/tests/page.tsx',
        deleteFn: 'bulkDeleteTestPlan',
        deletePermission: /assertCanBulkManageTestPlans\(ctx\)/,
    },
];

describe.each(ENTITIES)('Bulk action rollout — $name', (e) => {
    it('has bulk status + assign API routes', () => {
        expect(exists(e.statusRoute)).toBe(true);
        expect(exists(e.assignRoute)).toBe(true);
    });

    it('usecases assert permission + use a tenant-scoped bulk update', () => {
        const uc = read(e.usecaseFile);
        expect(uc).toMatch(e.statusFn);
        expect(uc).toMatch(e.assignFn);
        expect(uc).toMatch(e.permission);
        expect(uc).toMatch(e.repoBulkCall);
    });

    it('repository bulkUpdate is one updateMany filtered by tenantId', () => {
        const repo = read(e.repoFile);
        expect(repo).toMatch(/bulkUpdate/);
        expect(repo).toMatch(/updateMany/);
        expect(repo).toMatch(/tenantId: ctx\.tenantId/);
    });

    it('schemas cap the batch + enum the status', () => {
        const sch = read('src/lib/schemas/index.ts');
        expect(sch).toMatch(e.schemaStatus);
        expect(sch).toMatch(e.schemaAssign);
        expect(sch).toMatch(e.statusEnum);
        // batch cap (100) on every bulk schema
        expect(sch).toMatch(/\.min\(1\)\.max\(100\)/);
    });

    it('the bulk DELETE verb carries an admin gate, inside its own body', () => {
        // Bounded to the function, not the file. The sibling `permission`
        // assertion above scans the whole module, which is why a missing gate
        // here was invisible: some other function always satisfied it.
        const body = functionBodyOf(read(e.usecaseFile), e.deleteFn);
        expect(body).toMatch(e.deletePermission);
    });

    it('client mounts BulkActionBar with status + assign actions', () => {
        const client = read(e.clientFile);
        expect(client).toMatch(/<BulkActionBar\b/);
        expect(client).toMatch(/value: 'status'/);
        expect(client).toMatch(/value: 'assign'/);
    });
});
