/**
 * Integration tests for the onboarding automation service —
 * `runStepAction` + `storeActionResult`.
 *
 * Branch-coverage focus: every switch arm, every `if (...)` branch,
 * every thrown-error / caught-error path, and the idempotent
 * skip-existing branches.
 *
 * Approach mirrors treatment-plan-monitoring.test.ts:
 *  - a raw `globalPrisma` (connects as the `test` superuser, bypasses
 *    RLS) seeds tenants / users / framework packs and verifies rows.
 *  - the usecase functions route through the app `prisma` singleton via
 *    `runInTenantContext`; because the test harness exports
 *    DATABASE_URL at the same test DB, both clients hit the same DB.
 *
 * The global framework catalog (Framework / FrameworkPack /
 * ControlTemplate) is EMPTY in this DB, so the CONTROL_BASELINE_INSTALL /
 * FRAMEWORK_SELECTION happy paths create a pack + linked templates first.
 *
 * RUN (with the test DB env exported):
 *   npx jest tests/integration/onboarding-automation-runstepaction.test.ts --runInBand
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { runStepAction, storeActionResult } from '@/app-layer/usecases/onboarding-automation';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `onb-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE}`;

let userId = '';
// The installer resolves packs by FRAMEWORK key (case-insensitive), so the
// selection must name this framework, not a hardcoded pack key.
const FW_KEY = `ISO27001-${SUITE}`;
const ISO_PACK_KEY = 'iso27001-2022-baseline';
let frameworkId = '';
let requirementId = '';

async function seedFrameworkCatalog() {
    // Global (non-tenant) catalog rows: Framework + FrameworkRequirement +
    // 2 ControlTemplates (one with a task + a requirement link, one bare),
    // linked into a FrameworkPack whose `key` matches the source's
    // FRAMEWORK_PACK_KEYS['iso27001'] mapping.
    const fw = await globalPrisma.framework.create({
        data: {
            key: FW_KEY,
            name: 'ISO 27001 (test)',
            version: '2022',
        },
    });
    frameworkId = fw.id;

    const req = await globalPrisma.frameworkRequirement.create({
        data: { frameworkId: fw.id, code: `A.5.1-${SUITE}`, title: 'Policies for information security', sortOrder: 0 },
    });
    requirementId = req.id;

    const tmplWithChildren = await globalPrisma.controlTemplate.create({
        data: { code: `OB-AC-${SUITE}`, title: 'Access Control Policy', category: 'Access Control', defaultFrequency: 'ANNUALLY' },
    });
    await globalPrisma.controlTemplateTask.create({
        data: { templateId: tmplWithChildren.id, title: 'Draft the access control policy', description: 'Write it down.' },
    });
    await globalPrisma.controlTemplateRequirementLink.create({
        data: { templateId: tmplWithChildren.id, requirementId: req.id },
    });

    const tmplBare = await globalPrisma.controlTemplate.create({
        data: { code: `OB-IR-${SUITE}`, title: 'Incident Response Plan', category: 'Incident Management', defaultFrequency: 'ANNUALLY' },
    });

    const pack = await globalPrisma.frameworkPack.create({
        data: { key: ISO_PACK_KEY, name: 'ISO 27001:2022 Baseline (test)', frameworkId: fw.id, version: '2022' },
    });
    await globalPrisma.packTemplateLink.create({ data: { packId: pack.id, templateId: tmplWithChildren.id } });
    await globalPrisma.packTemplateLink.create({ data: { packId: pack.id, templateId: tmplBare.id } });
}

async function cleanCatalog() {
    // Order matters — children before parents.
    await globalPrisma.packTemplateLink.deleteMany({ where: { pack: { key: ISO_PACK_KEY } } }).catch(() => {});
    await globalPrisma.frameworkPack.deleteMany({ where: { key: ISO_PACK_KEY } }).catch(() => {});
    await globalPrisma.controlTemplateRequirementLink.deleteMany({ where: { template: { code: { contains: SUITE } } } }).catch(() => {});
    await globalPrisma.controlTemplateTask.deleteMany({ where: { template: { code: { contains: SUITE } } } }).catch(() => {});
    await globalPrisma.controlTemplate.deleteMany({ where: { code: { contains: SUITE } } }).catch(() => {});
    await globalPrisma.frameworkRequirement.deleteMany({ where: { frameworkId } }).catch(() => {});
    await globalPrisma.framework.deleteMany({ where: { id: frameworkId } }).catch(() => {});
}

async function cleanTenant() {
    const where = { where: { tenantId: TENANT_ID } };
    await globalPrisma.auditLog.deleteMany(where).catch(() => {});
    await globalPrisma.controlRequirementLink.deleteMany(where).catch(() => {});
    await globalPrisma.task.deleteMany(where).catch(() => {});
    await globalPrisma.control.deleteMany(where).catch(() => {});
    await globalPrisma.risk.deleteMany(where).catch(() => {});
    await globalPrisma.asset.deleteMany(where).catch(() => {});
    await globalPrisma.tenantOnboarding.deleteMany(where).catch(() => {});
}

const ctx = () => makeRequestContext('ADMIN', { tenantId: TENANT_ID, userId });

describeFn('onboarding-automation — runStepAction & storeActionResult (integration)', () => {
    beforeAll(async () => {
        const email = `${SUITE}@example.test`;
        const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        userId = u.id;
        await globalPrisma.tenant.create({
            data: { id: TENANT_ID, name: `Tenant ${SUITE}`, slug: SUITE, maxRiskScale: 5 },
        });
        await globalPrisma.tenantMembership.create({
            data: { tenantId: TENANT_ID, userId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
        });
        await seedFrameworkCatalog();
    });

    afterAll(async () => {
        await cleanTenant();
        await cleanCatalog();
        await globalPrisma.tenantMembership.deleteMany({ where: { tenantId: TENANT_ID } }).catch(() => {});
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }).catch(() => {});
        await globalPrisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
        await globalPrisma.$disconnect().catch(() => {});
    });

    // Each test starts from a clean tenant (catalog persists for the suite).
    beforeEach(async () => {
        await cleanTenant();
    });

    // ─── Switch: default / no-automation steps ───

    it('returns null for steps with no automation (default arm)', async () => {
        expect(await runStepAction(ctx(), 'COMPANY_PROFILE', {}, {})).toBeNull();
        expect(await runStepAction(ctx(), 'REVIEW_AND_FINISH', {}, {})).toBeNull();
        expect(await runStepAction(ctx(), 'TOTALLY_UNKNOWN_STEP', {}, {})).toBeNull();
    });

    // ─── FRAMEWORK_SELECTION ───

    it('FRAMEWORK_SELECTION with empty/undefined selectedFrameworks creates nothing', async () => {
        // allData has no FRAMEWORK_SELECTION key → `|| []` branch.
        const res = await runStepAction(ctx(), 'FRAMEWORK_SELECTION', {}, {});
        expect(res).toEqual({ action: 'FRAMEWORK_INSTALL', created: 0, skipped: 0, details: '' });
    });

    it('FRAMEWORK_SELECTION with an unknown framework hits the no-pack skip branch', async () => {
        const allData = { FRAMEWORK_SELECTION: { selectedFrameworks: [`NOPACK-${SUITE}`] } };
        const res = await runStepAction(ctx(), 'FRAMEWORK_SELECTION', {}, allData);
        expect(res).toMatchObject({ action: 'FRAMEWORK_INSTALL', created: 0, skipped: 1 });
        expect(res!.details).toContain('no installable pack in catalog');
    });

    it('FRAMEWORK_SELECTION installs a framework\'s pack (happy path, case-insensitive key) then is idempotent', async () => {
        // Lowercased selection still resolves to the FW_KEY framework.
        const allData = { FRAMEWORK_SELECTION: { selectedFrameworks: [FW_KEY.toLowerCase()] } };

        const first = await runStepAction(ctx(), 'FRAMEWORK_SELECTION', {}, allData);
        // 2 templates in the pack → 2 controls created on first install.
        expect(first).toMatchObject({ action: 'FRAMEWORK_INSTALL', created: 2, skipped: 0 });
        expect(first!.details).toContain(`${FW_KEY.toLowerCase()}: 2 controls`);

        const controls = await globalPrisma.control.findMany({ where: { tenantId: TENANT_ID } });
        expect(controls).toHaveLength(2);

        // Re-run: installPack is idempotent — 0 new controls created.
        const second = await runStepAction(ctx(), 'FRAMEWORK_SELECTION', {}, allData);
        expect(second).toMatchObject({ action: 'FRAMEWORK_INSTALL', created: 0 });
        expect(await globalPrisma.control.count({ where: { tenantId: TENANT_ID } })).toBe(2);
    });

    it('FRAMEWORK_SELECTION skips a framework whose pack is absent from the catalog', async () => {
        // Delete the pack so the framework resolves to zero installable packs.
        await globalPrisma.packTemplateLink.deleteMany({ where: { pack: { key: ISO_PACK_KEY } } });
        await globalPrisma.frameworkPack.deleteMany({ where: { key: ISO_PACK_KEY } });
        try {
            const allData = { FRAMEWORK_SELECTION: { selectedFrameworks: [FW_KEY] } };
            const res = await runStepAction(ctx(), 'FRAMEWORK_SELECTION', {}, allData);
            expect(res).toMatchObject({ action: 'FRAMEWORK_INSTALL', created: 0, skipped: 1 });
            expect(res!.details).toContain('no installable pack in catalog');
        } finally {
            // Recreate the pack for the rest of the suite.
            const pack = await globalPrisma.frameworkPack.create({
                data: { key: ISO_PACK_KEY, name: 'ISO 27001:2022 Baseline (test)', frameworkId, version: '2022' },
            });
            const tmpls = await globalPrisma.controlTemplate.findMany({ where: { code: { contains: SUITE } } });
            for (const t of tmpls) {
                await globalPrisma.packTemplateLink.create({ data: { packId: pack.id, templateId: t.id } });
            }
        }
    });

    // ─── ASSET_SETUP ───

    it('ASSET_SETUP with no assets key creates nothing (|| [] + no logEvent)', async () => {
        const res = await runStepAction(ctx(), 'ASSET_SETUP', {}, {});
        expect(res).toEqual({ action: 'ASSET_CREATION', created: 0, skipped: 0, details: '0 assets created, 0 already existed' });
        // created === 0 → no audit row written.
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'ONBOARDING_ASSETS_CREATED' } })).toBe(0);
    });

    it('ASSET_SETUP creates assets (covers inferAssetType branches) and skips existing on re-run', async () => {
        // One name per inferAssetType branch — every inferred value must be a
        // real Prisma AssetType enum member or asset.create() throws. The
        // 'Customer Database' → DATA_STORE case is the regression guard for the
        // DATASTORE/DATA_STORE bug: before the fix it inferred 'DATASTORE',
        // which is NOT an enum member, so this create threw P2006-style.
        //   'Customer Portal'   → APPLICATION (keyword "portal")
        //   'Customer Database' → DATA_STORE (keyword "database")
        //   'AWS Cloud Network' → INFRASTRUCTURE (keyword "cloud"/"network")
        //   'Key Vendor Co'     → VENDOR (keyword "vendor")
        //   'Payroll Process'   → PROCESS (keyword "process"/"payroll")
        //   'Brandnewthing'     → APPLICATION (default fallback, no keyword)
        const assets = ['Customer Portal', 'Customer Database', 'AWS Cloud Network', 'Key Vendor Co', 'Payroll Process', 'Brandnewthing'];
        const allData = { ASSET_SETUP: { assets } };

        const res = await runStepAction(ctx(), 'ASSET_SETUP', {}, allData);
        expect(res).toMatchObject({ action: 'ASSET_CREATION', created: 6, skipped: 0 });

        const rows = await globalPrisma.asset.findMany({ where: { tenantId: TENANT_ID }, orderBy: { name: 'asc' } });
        expect(rows).toHaveLength(6);
        const byName = Object.fromEntries(rows.map(r => [r.name, r.type]));
        expect(byName['Customer Portal']).toBe('APPLICATION');
        expect(byName['Customer Database']).toBe('DATA_STORE');
        expect(byName['AWS Cloud Network']).toBe('INFRASTRUCTURE');
        expect(byName['Key Vendor Co']).toBe('VENDOR');
        expect(byName['Payroll Process']).toBe('PROCESS');
        expect(byName['Brandnewthing']).toBe('APPLICATION');

        // created > 0 → audit row written.
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'ONBOARDING_ASSETS_CREATED' } })).toBe(1);

        // Re-run: every asset already exists → all skipped, no new audit row.
        const again = await runStepAction(ctx(), 'ASSET_SETUP', {}, allData);
        expect(again).toMatchObject({ action: 'ASSET_CREATION', created: 0, skipped: 6 });
        expect(await globalPrisma.asset.count({ where: { tenantId: TENANT_ID } })).toBe(6);
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'ONBOARDING_ASSETS_CREATED' } })).toBe(1);
    });

    // ─── CONTROL_BASELINE_INSTALL ───

    it('CONTROL_BASELINE_INSTALL without confirmation returns early (!confirmed branch)', async () => {
        // Step key present but `.confirmed` falsy.
        const res = await runStepAction(ctx(), 'CONTROL_BASELINE_INSTALL', {}, { CONTROL_BASELINE_INSTALL: {} });
        expect(res).toEqual({ action: 'CONTROL_INSTALL', created: 0, skipped: 0, details: 'User did not confirm control installation' });

        // Step key entirely absent → the `?.` short-circuit branch of
        // `allData['CONTROL_BASELINE_INSTALL']?.confirmed`.
        const res2 = await runStepAction(ctx(), 'CONTROL_BASELINE_INSTALL', {}, {});
        expect(res2).toEqual({ action: 'CONTROL_INSTALL', created: 0, skipped: 0, details: 'User did not confirm control installation' });
    });

    it('CONTROL_BASELINE_INSTALL when confirmed re-runs the framework install', async () => {
        const allData = {
            CONTROL_BASELINE_INSTALL: { confirmed: true },
            FRAMEWORK_SELECTION: { selectedFrameworks: [FW_KEY] },
        };
        const res = await runStepAction(ctx(), 'CONTROL_BASELINE_INSTALL', {}, allData);
        // Delegates to executeFrameworkInstall → installs the 2-template pack.
        expect(res).toMatchObject({ action: 'FRAMEWORK_INSTALL', created: 2 });
        expect(await globalPrisma.control.count({ where: { tenantId: TENANT_ID } })).toBe(2);
    });

    // ─── INITIAL_RISK_REGISTER ───

    it('INITIAL_RISK_REGISTER opt-out (generate === false) creates nothing', async () => {
        const allData = { INITIAL_RISK_REGISTER: { generate: false } };
        const res = await runStepAction(ctx(), 'INITIAL_RISK_REGISTER', {}, allData);
        expect(res).toEqual({ action: 'RISK_GENERATION', created: 0, skipped: 0, details: 'User opted out of risk generation' });
        expect(await globalPrisma.risk.count({ where: { tenantId: TENANT_ID } })).toBe(0);
    });

    it('INITIAL_RISK_REGISTER with no frameworks and no assets matches nothing (assetTypes default branch, fwMatch all false)', async () => {
        // No FRAMEWORK_SELECTION, no ASSET_SETUP → selectedFrameworks=[],
        // assetNames=[] → assetTypes.size===0 → adds 'APPLICATION' (default
        // branch is exercised). EVERY STARTER_RISKS entry specifies at least
        // one framework, so with selectedFrameworks empty, fwMatch is false
        // for all of them → zero risks created. This still drives the
        // assetTypes.size===0 default branch and the filter predicate.
        const res = await runStepAction(ctx(), 'INITIAL_RISK_REGISTER', {}, {});
        expect(res).toMatchObject({ action: 'RISK_GENERATION', created: 0, skipped: 0 });
        expect(await globalPrisma.risk.count({ where: { tenantId: TENANT_ID } })).toBe(0);
        // created === 0 → no audit row written (the `if (created > 0)` false branch).
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'ONBOARDING_RISKS_GENERATED' } })).toBe(0);
    });

    it('INITIAL_RISK_REGISTER with frameworks + assets filters by framework AND asset type, then is idempotent', async () => {
        const allData = {
            FRAMEWORK_SELECTION: { selectedFrameworks: ['nis2'] },
            // 'Customer database' → DATA_STORE (in-memory only; not persisted here)
            ASSET_SETUP: { assets: ['Customer database'] },
        };
        const res = await runStepAction(ctx(), 'INITIAL_RISK_REGISTER', {}, allData);
        const titles = (await globalPrisma.risk.findMany({ where: { tenantId: TENANT_ID }, select: { title: true, score: true } }));
        const names = titles.map(t => t.title);
        // DATA_STORE + nis2 → 'Data Backup Failure' (DATA_STORE, nis2) matches.
        expect(names).toContain('Data Backup Failure');
        // 'Data Integrity Compromise' is DATA_STORE but iso27001-only → fwMatch false.
        expect(names).not.toContain('Data Integrity Compromise');
        // APPLICATION-only risks should NOT appear (no APPLICATION asset).
        expect(names).not.toContain('Unauthorized Access to Application');
        // General risks (frameworks include nis2 OR empty) appear.
        expect(names).toContain('Regulatory Non-Compliance');
        expect(res!.created).toBeGreaterThan(0);
        expect(res!.created).toBe(names.length);
        // Score computed via maxRiskScale (tenant.maxRiskScale=5) → finite int.
        for (const t of titles) expect(Number.isInteger(t.score)).toBe(true);

        // audit row written (created > 0).
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'ONBOARDING_RISKS_GENERATED' } })).toBe(1);

        // Idempotent re-run: all existing → skipped, no new audit row.
        const again = await runStepAction(ctx(), 'INITIAL_RISK_REGISTER', {}, allData);
        expect(again!.created).toBe(0);
        expect(again!.skipped).toBe(names.length);
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'ONBOARDING_RISKS_GENERATED' } })).toBe(1);
    });

    it('mints an RSK-N key on every generated risk', async () => {
        // Onboarding used to insert via a bare `db.risk.create`, bypassing
        // the repository's atomic key counter — so every risk a tenant saw
        // on day one had `key = NULL` and a permanently blank Code column,
        // on the very screen meant to make the product feel populated. The
        // rows above are asserted by title, which a NULL key does not
        // disturb; only reading `key` back catches it.
        await runStepAction(ctx(), 'INITIAL_RISK_REGISTER', {}, {
            FRAMEWORK_SELECTION: { selectedFrameworks: ['nis2'] },
            ASSET_SETUP: { assets: ['Customer database'] },
        });

        const rows = await globalPrisma.risk.findMany({
            where: { tenantId: TENANT_ID },
            select: { key: true },
        });

        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every(r => /^RSK-\d+$/.test(r.key ?? ''))).toBe(true);
        // Keys come off a per-tenant counter, so they must also be distinct.
        expect(new Set(rows.map(r => r.key)).size).toBe(rows.length);
    });

    // ─── TEAM_SETUP ───

    it('TEAM_SETUP creates the 5 starter tasks then skips them on re-run', async () => {
        const res = await runStepAction(ctx(), 'TEAM_SETUP', {}, {});
        expect(res).toMatchObject({ action: 'TEAM_SETUP', created: 5, skipped: 0 });
        expect(await globalPrisma.task.count({ where: { tenantId: TENANT_ID } })).toBe(5);
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'ONBOARDING_TASKS_CREATED' } })).toBe(1);

        const again = await runStepAction(ctx(), 'TEAM_SETUP', {}, {});
        expect(again).toMatchObject({ action: 'TEAM_SETUP', created: 0, skipped: 5 });
        expect(await globalPrisma.task.count({ where: { tenantId: TENANT_ID } })).toBe(5);
        // created === 0 on re-run → no second audit row.
        expect(await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, action: 'ONBOARDING_TASKS_CREATED' } })).toBe(1);
    });

    // ─── storeActionResult ───

    it('storeActionResult returns early when no onboarding row exists (!existing branch)', async () => {
        // No TenantOnboarding row for this tenant.
        const result = { action: 'TEAM_SETUP', created: 1, skipped: 0, details: 'x' };
        await expect(storeActionResult(ctx(), 'TEAM_SETUP', result)).resolves.toBeUndefined();
        expect(await globalPrisma.tenantOnboarding.findUnique({ where: { tenantId: TENANT_ID } })).toBeNull();
    });

    it('storeActionResult merges into _actionResults when an onboarding row exists', async () => {
        // Seed an onboarding row with NO stepData → exercises `|| {}` defaults.
        await globalPrisma.tenantOnboarding.create({ data: { tenantId: TENANT_ID } });

        const r1 = { action: 'ASSET_CREATION', created: 3, skipped: 0, details: 'a' };
        await storeActionResult(ctx(), 'ASSET_SETUP', r1);

        type StoredStepData = {
            _actionResults: Record<
                string,
                { action: string; created: number; skipped: number; details: string }
            >;
        };
        let row = await globalPrisma.tenantOnboarding.findUnique({ where: { tenantId: TENANT_ID } });
        let data = row!.stepData as unknown as StoredStepData;
        expect(data._actionResults.ASSET_SETUP).toMatchObject({ action: 'ASSET_CREATION', created: 3 });

        // Second store: existing _actionResults present → merge branch.
        const r2 = { action: 'TEAM_SETUP', created: 5, skipped: 0, details: 'b' };
        await storeActionResult(ctx(), 'TEAM_SETUP', r2);

        row = await globalPrisma.tenantOnboarding.findUnique({ where: { tenantId: TENANT_ID } });
        data = row!.stepData as unknown as StoredStepData;
        expect(data._actionResults.ASSET_SETUP).toMatchObject({ action: 'ASSET_CREATION' });
        expect(data._actionResults.TEAM_SETUP).toMatchObject({ action: 'TEAM_SETUP', created: 5 });
    });
});
