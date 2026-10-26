/**
 * Integration coverage for `src/app-layer/usecases/inherited-control-data.ts`.
 *
 * DB-backed. Seeds an asset + risk both mapped to one control that owns
 * evidence, a test plan (with a run), and a framework requirement link.
 *
 * Branches per the 6 exported aggregators:
 *   - controlsForAsset / controlsForRisk resolve mapped controls.
 *   - non-empty controlIds → evidence/testplan/mapping queries run and
 *     each row is tagged with its owning control (byId lookup).
 *   - empty controlIds (unmapped asset/risk) → each aggregator returns []
 *     (the `controlIds.length === 0` short-circuit).
 *   - test-plan latest-run include + mapping framework relation.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import {
    getAssetInheritedEvidence,
    getRiskInheritedEvidence,
    getAssetInheritedTestPlans,
    getRiskInheritedTestPlans,
    getAssetInheritedMappings,
    getRiskInheritedMappings,
    getPolicyInheritedMappings,
} from '@/app-layer/usecases/inherited-control-data';
import { getPolicyTraceability } from '@/app-layer/usecases/traceability';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `icd-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE });

let controlId: string;
let mappedAssetId: string;
let mappedRiskId: string;
let bareAssetId: string;
let bareRiskId: string;
let mappedPolicyId: string;
let barePolicyId: string;

describeFn('inherited-control-data usecases (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: SUITE, slug: SUITE } });
        const control = await prisma.control.create({ data: { tenantId: TENANT, name: 'Ctrl', code: 'C-1' } });
        controlId = control.id;
        const asset = await prisma.asset.create({ data: { tenantId: TENANT, name: 'A', type: 'SYSTEM', status: 'ACTIVE' } });
        mappedAssetId = asset.id;
        const risk = await prisma.risk.create({ data: { tenantId: TENANT, title: 'R', score: 9 } });
        mappedRiskId = risk.id;
        const bareAsset = await prisma.asset.create({ data: { tenantId: TENANT, name: 'Bare', type: 'SYSTEM', status: 'ACTIVE' } });
        bareAssetId = bareAsset.id;
        const bareRisk = await prisma.risk.create({ data: { tenantId: TENANT, title: 'BareR', score: 4 } });
        bareRiskId = bareRisk.id;

        await prisma.controlAsset.create({ data: { tenantId: TENANT, controlId, assetId: mappedAssetId } });
        await prisma.riskControl.create({ data: { tenantId: TENANT, controlId, riskId: mappedRiskId } });

        const policy = await prisma.policy.create({ data: { tenantId: TENANT, slug: `pol-${SUITE}`, title: 'Pol' } });
        mappedPolicyId = policy.id;
        const barePolicy = await prisma.policy.create({ data: { tenantId: TENANT, slug: `pol-bare-${SUITE}`, title: 'BarePol' } });
        barePolicyId = barePolicy.id;
        await prisma.policyControlLink.create({ data: { tenantId: TENANT, policyId: mappedPolicyId, controlId } });

        const ev = await prisma.evidence.create({ data: { tenantId: TENANT, type: 'FILE', title: 'Ev' } });
        await prisma.evidenceControlLink.create({ data: { tenantId: TENANT, evidenceId: ev.id, controlId } });

        const uid = await ensureUser();
        const plan = await prisma.controlTestPlan.create({
            data: {
                tenant: { connect: { id: TENANT } },
                control: { connect: { id: controlId } },
                createdBy: { connect: { id: uid } },
                name: 'Plan',
            },
        });
        await prisma.controlTestRun.create({
            data: {
                tenant: { connect: { id: TENANT } },
                control: { connect: { id: controlId } },
                testPlan: { connect: { id: plan.id } },
                status: 'COMPLETED',
                result: 'PASS',
                executedAt: new Date(),
                createdBy: { connect: { id: uid } },
            },
        });

        const framework = await prisma.framework.create({ data: { key: `fw-${SUITE}`, name: 'FW', version: '1' } });
        const req = await prisma.frameworkRequirement.create({ data: { frameworkId: framework.id, code: 'R.1', title: 'Req 1' } });
        await prisma.controlRequirementLink.create({ data: { tenantId: TENANT, controlId, requirementId: req.id } });
    });

    let _userId: string | undefined;
    async function ensureUser(): Promise<string> {
        if (_userId) return _userId;
        const email = `${SUITE}@example.test`;
        const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        _userId = u.id;
        return u.id;
    }

    afterAll(async () => {
        await prisma.policyControlLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.policy.deleteMany({ where: { tenantId: TENANT } });
        await prisma.controlRequirementLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.frameworkRequirement.deleteMany({ where: { framework: { key: `fw-${SUITE}` } } });
        await prisma.framework.deleteMany({ where: { key: `fw-${SUITE}` } });
        await prisma.controlTestRun.deleteMany({ where: { tenantId: TENANT } });
        await prisma.controlTestPlan.deleteMany({ where: { tenantId: TENANT } });
        await prisma.evidenceControlLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.evidence.deleteMany({ where: { tenantId: TENANT } });
        await prisma.controlAsset.deleteMany({ where: { tenantId: TENANT } });
        await prisma.riskControl.deleteMany({ where: { tenantId: TENANT } });
        await prisma.control.deleteMany({ where: { tenantId: TENANT } });
        await prisma.asset.deleteMany({ where: { tenantId: TENANT } });
        await prisma.risk.deleteMany({ where: { tenantId: TENANT } });
        if (_userId) await prisma.user.deleteMany({ where: { id: _userId } });
        // AuditLog_tenantId_fkey is ON DELETE RESTRICT and the trail is
        // immutable, so any audit row written for this tenant blocks the delete
        // below unless it is cleared first, through the helper that lifts the
        // immutability trigger.
        await deleteAuditRowsForTenants(prisma, [TENANT]);
        await prisma.tenant.deleteMany({ where: { id: TENANT } });
        await prisma.$disconnect();
    });

    it('asset inherited evidence is tagged with the owning control', async () => {
        const ev = await getAssetInheritedEvidence(ctx, mappedAssetId);
        expect(ev).toHaveLength(1);
        expect(ev[0].control?.id).toBe(controlId);
    });

    it('risk inherited evidence resolves via RiskControl', async () => {
        const ev = await getRiskInheritedEvidence(ctx, mappedRiskId);
        expect(ev).toHaveLength(1);
        expect(ev[0].control?.code).toBe('C-1');
    });

    it('asset inherited test plans include the latest run + control tag', async () => {
        const plans = await getAssetInheritedTestPlans(ctx, mappedAssetId);
        expect(plans).toHaveLength(1);
        expect(plans[0].control?.id).toBe(controlId);
        expect(plans[0].runs).toHaveLength(1);
    });

    it('risk inherited test plans resolve via RiskControl', async () => {
        const plans = await getRiskInheritedTestPlans(ctx, mappedRiskId);
        expect(plans).toHaveLength(1);
    });

    it('asset inherited mappings expose the framework requirement', async () => {
        const maps = await getAssetInheritedMappings(ctx, mappedAssetId);
        expect(maps).toHaveLength(1);
        expect(maps[0].code).toBe('R.1');
        expect(maps[0].framework?.name).toBe('FW');
        expect(maps[0].control?.id).toBe(controlId);
    });

    it('risk inherited mappings resolve via RiskControl', async () => {
        const maps = await getRiskInheritedMappings(ctx, mappedRiskId);
        expect(maps).toHaveLength(1);
    });

    it('policy inherited mappings resolve via PolicyControlLink', async () => {
        const maps = await getPolicyInheritedMappings(ctx, mappedPolicyId);
        expect(maps).toHaveLength(1);
        expect(maps[0].code).toBe('R.1');
        expect(maps[0].framework?.name).toBe('FW');
        expect(maps[0].control?.id).toBe(controlId);
    });

    it('policy traceability returns linked control + risks/assets inherited via it', async () => {
        const trace = await getPolicyTraceability(ctx, mappedPolicyId);
        expect(trace.policyId).toBe(mappedPolicyId);
        expect(trace.controls).toHaveLength(1);
        expect(trace.controls[0].control.id).toBe(controlId);
        expect(trace.risks).toHaveLength(1);
        expect(trace.risks[0].risk.id).toBe(mappedRiskId);
        expect(trace.risks[0].viaControls).toBe(1);
        expect(trace.assets).toHaveLength(1);
        expect(trace.assets[0].asset.id).toBe(mappedAssetId);
        expect(trace.assets[0].viaControls).toBe(1);
    });

    it('unmapped asset/risk/policy return [] from every aggregator (empty short-circuit)', async () => {
        expect(await getAssetInheritedEvidence(ctx, bareAssetId)).toEqual([]);
        expect(await getAssetInheritedTestPlans(ctx, bareAssetId)).toEqual([]);
        expect(await getAssetInheritedMappings(ctx, bareAssetId)).toEqual([]);
        expect(await getRiskInheritedEvidence(ctx, bareRiskId)).toEqual([]);
        expect(await getRiskInheritedTestPlans(ctx, bareRiskId)).toEqual([]);
        expect(await getRiskInheritedMappings(ctx, bareRiskId)).toEqual([]);
        expect(await getPolicyInheritedMappings(ctx, barePolicyId)).toEqual([]);
        const bareTrace = await getPolicyTraceability(ctx, barePolicyId);
        expect(bareTrace.controls).toEqual([]);
        expect(bareTrace.risks).toEqual([]);
        expect(bareTrace.assets).toEqual([]);
    });
});
