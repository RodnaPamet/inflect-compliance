/**
 * Step 4d (#3681) — the agent-audit reliance pack, against the database.
 *
 * Hardening checklist, as tested here:
 *   - every control in scope has a pack entry with workpapers, internal
 *     audit's sampling records and the agreement rate;
 *   - the external auditor's access is pack-scoped (a share link of the
 *     reliance pack reads that pack and nothing else);
 * and, from the roadmap's rules: zero is never reliance, two tenants never
 * meet, and a refusal names its reason and leaves a row.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveTenantContext } from '@/lib/tenant-context';
import { setMembershipLineOfDefence } from '@/app-layer/usecases/membership-line-of-defence';
import { recordWorkpaperReview } from '@/app-layer/usecases/audit-workpaper-sample-review';
import { runAuditWorkpaperSampleReview } from '@/app-layer/jobs/audit-workpaper-sample-review';
import { assembleAgentAuditReliancePack } from '@/app-layer/usecases/agent-audit-reliance';
import {
    createAuditPack,
    freezeAuditPack,
    generateShareLink,
    getPackByShareToken,
    grantAuditorAccess,
    inviteAuditor,
} from '@/app-layer/usecases/audit-readiness';
import { addAuditPackItems } from '@/app-layer/usecases/audit-readiness/packs';
import {
    relianceSummaryEntityId,
    type RelianceControlSnapshot,
    type RelianceSummarySnapshot,
} from '@/lib/agentic/audit-reliance';
import { METRIC_DEFINITIONS } from '@/lib/agentic/report-definitions';
import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/errors/types';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T1 = 'reliance-one';
const T2 = 'reliance-two';
const TENANTS = [T1, T2];
const SEED = 'test-seed-for-reliance-pack';
const HEX = 'b'.repeat(64);

type Person = 'owner' | 'admin' | 'editor' | 'second' | 'thirdA' | 'thirdB';
const PEOPLE: Person[] = ['owner', 'admin', 'editor', 'second', 'thirdA', 'thirdB'];
const ROLE: Record<Person, Role> = {
    owner: Role.OWNER,
    admin: Role.ADMIN,
    editor: Role.EDITOR,
    second: Role.READER,
    thirdA: Role.AUDITOR,
    thirdB: Role.AUDITOR,
};
const LINES: Partial<Record<Person, 'SECOND' | 'THIRD'>> = { second: 'SECOND', thirdA: 'THIRD', thirdB: 'THIRD' };

interface TenantFixture {
    users: Record<Person, string>;
    contexts: Record<Person, RequestContext>;
    auditorId: string;
    leaverControlId: string;
    agentControlId: string;
    leaverRunId: string;
    cycleId: string;
}
const fx: Record<string, TenantFixture> = {};
const emailOf = (tenantId: string, who: Person) => `${who}@${tenantId}.test`;
let seq = 0;

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.auditorPackAccess.deleteMany({ where: t });
    await prisma.auditorAccount.deleteMany({ where: t });
    await prisma.auditPackShare.deleteMany({ where: t });
    await prisma.auditPackItem.deleteMany({ where: t });
    await prisma.auditPack.deleteMany({ where: t });
    await prisma.auditCycle.deleteMany({ where: t });
    await prisma.auditWorkpaper.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.aiDecisionLog.deleteMany({ where: t });
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.controlTestRun.deleteMany({ where: t });
    await prisma.controlTestPlan.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.tenantSecuritySettings.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: TENANTS.flatMap((tn) => PEOPLE.map((p) => hashForLookup(emailOf(tn, p)))) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

/** A workpaper of the leaver procedure on the leaver control's run. */
async function makeWorkpaper(tenantId: string, periodLabel: string, conclusion: 'PASS' | 'FAIL' = 'PASS') {
    seq += 1;
    const fail = conclusion === 'FAIL';
    return prisma.auditWorkpaper.create({
        data: {
            tenantId,
            procedureId: 'iam.leaver_timeliness',
            catalogueVersion: 1,
            periodLabel,
            populationDefinition: 'Employee rows with status TERMINATED and endDate inside the period',
            populationCount: 4,
            populationDigest: HEX,
            sampleEpoch: `iam.leaver_timeliness@${periodLabel}`,
            seedFingerprint: HEX,
            sampleSize: 2,
            sampledUnitIds: ['emp_1', 'emp_2'],
            attributesTested: ['L1', 'L2'],
            itemOutcomesJson: [
                { unitId: 'emp_1', outcome: fail ? 'EXCEPTION' : 'PASS', code: fail ? 'ACCESS_NOT_REVOKED' : null },
                { unitId: 'emp_2', outcome: 'PASS', code: null },
            ],
            exceptionsJson: fail ? [{ unitId: 'emp_1', code: 'ACCESS_NOT_REVOKED' }] : [],
            exceptionCount: fail ? 1 : 0,
            conclusion,
            conclusionBasis: fail ? 'EXCEPTION_FOUND' : 'ALL_SAMPLED_UNITS_PASSED',
            auditorAgentId: fx[tenantId].auditorId,
            controlTestRunId: fx[tenantId].leaverRunId,
        },
        select: { id: true },
    });
}

/** Draw every workpaper (rate 100) and return each one's review row. */
async function sweep(tenantId: string) {
    await runAuditWorkpaperSampleReview(prisma, { tenantId, now: new Date(), seed: SEED });
    return prisma.auditWorkpaperSampleReview.findMany({ where: { tenantId } });
}

/** Answer a review as its assigned reviewer. */
async function answer(tenantId: string, reviewId: string, outcome: 'CONCURRED' | 'DISSENTED' | 'INDETERMINATE') {
    const row = await prisma.auditWorkpaperSampleReview.findUniqueOrThrow({ where: { id: reviewId } });
    const who = (Object.entries(fx[tenantId].users).find(([, id]) => id === row.assignedToUserId)?.[0] as Person) ?? null;
    if (!who) throw new Error('review is unassigned');
    const body = outcome === 'DISSENTED' ? { outcome, dissentCodes: ['ATTRIBUTE_NOT_TESTED'] } : { outcome };
    return recordWorkpaperReview(fx[tenantId].contexts[who], reviewId, body);
}

async function reasonOf(p: Promise<unknown>): Promise<string | undefined> {
    try {
        await p;
    } catch (e) {
        if (e instanceof ConflictError) return (e.details as { reason?: string } | undefined)?.reason;
        throw e;
    }
    return undefined;
}

function parse<T>(json: string): T {
    return JSON.parse(json) as T;
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        const users = {} as Record<Person, string>;
        const memberships = {} as Record<Person, string>;
        for (const who of PEOPLE) {
            const email = emailOf(tenantId, who);
            const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
            users[who] = user.id;
            const m = await prisma.tenantMembership.create({
                data: { tenantId, userId: user.id, role: ROLE[who], status: MembershipStatus.ACTIVE },
            });
            memberships[who] = m.id;
        }
        const contexts = {} as Record<Person, RequestContext>;
        for (const who of PEOPLE) {
            const resolved = await resolveTenantContext({ tenantId }, users[who]);
            contexts[who] = makeRequestContext(resolved.role, {
                tenantId,
                tenantSlug: tenantId,
                userId: users[who],
                permissions: resolved.permissions,
                appPermissions: resolved.appPermissions,
            });
        }
        for (const [who, line] of Object.entries(LINES) as [Person, 'SECOND' | 'THIRD'][]) {
            await setMembershipLineOfDefence(contexts.owner, memberships[who], { lineOfDefence: line });
        }
        seq += 1;
        const sys = await prisma.aiSystem.create({ data: { tenantId, name: `rel host ${seq}`, ownerUserId: users.second } });
        const auditor = await prisma.registeredAgent.create({
            data: {
                tenantId,
                aiSystemId: sys.id,
                name: `rel auditor ${seq}`,
                autonomyLevel: 1,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: users.second,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
                isAuditor: true,
            },
        });
        const leaver = await prisma.control.create({
            data: { tenantId, name: `Leaver access ${tenantId}`, code: 'A.5.16', createdByUserId: users.admin },
        });
        const agentControl = await prisma.control.create({
            data: { tenantId, name: `Agent authority ${tenantId}`, code: 'A.9.4', createdByUserId: users.admin },
        });
        const leaverPlan = await prisma.controlTestPlan.create({
            data: {
                tenantId,
                controlId: leaver.id,
                name: 'Leaver timeliness',
                createdByUserId: users.admin,
                automationConfig: {
                    procedure: 'iam.leaver_timeliness',
                    auditorAgentId: auditor.id,
                    parameters: { leaverWindowHours: 24 },
                },
            },
        });
        await prisma.controlTestPlan.create({
            data: {
                tenantId,
                controlId: agentControl.id,
                name: 'Agent authority conformance',
                createdByUserId: users.admin,
                automationConfig: { procedure: 'agent.authority_conformance', auditorAgentId: auditor.id },
            },
        });
        const run = await prisma.controlTestRun.create({
            data: { tenantId, controlId: leaver.id, testPlanId: leaverPlan.id, createdByUserId: users.admin },
        });
        const cycle = await prisma.auditCycle.create({
            data: {
                tenantId,
                frameworkKey: 'ISO42001',
                frameworkVersion: '2023',
                name: `ISO/IEC 42001 surveillance ${tenantId}`,
                periodStartAt: new Date('2026-01-01T00:00:00Z'),
                periodEndAt: new Date('2026-12-31T00:00:00Z'),
                createdByUserId: users.admin,
            },
        });
        fx[tenantId] = {
            users,
            contexts,
            auditorId: auditor.id,
            leaverControlId: leaver.id,
            agentControlId: agentControl.id,
            leaverRunId: run.id,
            cycleId: cycle.id,
        };
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

// ─── The pack ───────────────────────────────────────────────────────

describe('every control in scope has a pack with workpapers, sampling records and the agreement rate', () => {
    let packId: string;
    let papers: { id: string }[];

    beforeAll(async () => {
        papers = [
            await makeWorkpaper(T1, '2026-07'),
            await makeWorkpaper(T1, '2026-08'),
            await makeWorkpaper(T1, '2026-09', 'FAIL'),
            await makeWorkpaper(T1, '2025-12'), // outside the cycle's period
        ];
        const reviews = await sweep(T1);
        const byWp = new Map(reviews.map((r) => [r.workpaperId, r.id] as const));
        await answer(T1, byWp.get(papers[0].id)!, 'CONCURRED');
        await answer(T1, byWp.get(papers[1].id)!, 'DISSENTED');
        // papers[2] stays awaiting.
        const result = await assembleAgentAuditReliancePack(fx[T1].contexts.admin, fx[T1].cycleId);
        packId = result.packId;
        expect(result.status).toBe('FROZEN');
    });

    it('freezes one pack holding one entry per control in scope and one summary', async () => {
        const pack = await prisma.auditPack.findUniqueOrThrow({ where: { id: packId }, include: { items: true } });
        expect(pack.status).toBe('FROZEN');
        expect(pack.auditCycleId).toBe(fx[T1].cycleId);
        const controlItems = pack.items.filter((i) => i.entityType === 'CONTROL');
        expect(controlItems.map((i) => i.entityId).sort()).toEqual([fx[T1].agentControlId, fx[T1].leaverControlId].sort());
        expect(pack.items.filter((i) => i.entityType === 'FRAMEWORK_COVERAGE').map((i) => i.entityId)).toEqual([
            relianceSummaryEntityId(fx[T1].cycleId),
        ]);
        const logged = await prisma.auditLog.findMany({
            where: { tenantId: T1, action: 'AGENT_AUDIT_RELIANCE_PACK_ASSEMBLED', entityId: packId },
        });
        expect(logged).toHaveLength(1);
    });

    it('the leaver control carries each workpaper of the period with its sampling record and the rate', async () => {
        const item = await prisma.auditPackItem.findFirstOrThrow({
            where: { auditPackId: packId, entityId: fx[T1].leaverControlId },
        });
        const snap = parse<RelianceControlSnapshot>(item.snapshotJson);
        expect(snap.code).toBe('A.5.16');
        expect(snap.reliance.workpapers.map((w) => w.id).sort()).toEqual(papers.slice(0, 3).map((p) => p.id).sort());
        const state = new Map(snap.reliance.workpapers.map((w) => [w.id, w.sampling.state] as const));
        expect(state.get(papers[0].id)).toBe('CONCURRED');
        expect(state.get(papers[1].id)).toBe('DISSENTED');
        expect(state.get(papers[2].id)).toBe('AWAITING');
        for (const w of snap.reliance.workpapers) {
            expect(w.sampling.samplePercent).toBe(100);
            expect(w.sampling.samplingEpoch).toBe(`audit-workpaper-review@${w.periodLabel}`);
            expect(w.attribution).toBe('RUN');
        }
        expect(snap.reliance.sampling).toMatchObject({ concluded: 2, concurred: 1, dissented: 1, awaiting: 1, agreementRate: 0.5 });
        expect(snap.reliance.limits).toEqual(
            expect.arrayContaining(['REVIEWS_AWAITING', 'DISSENT_RECORDED', 'CONCLUSION_FAIL']),
        );
    });

    it('the control with no workpaper in the period is listed with that limit and no rate', async () => {
        const item = await prisma.auditPackItem.findFirstOrThrow({
            where: { auditPackId: packId, entityId: fx[T1].agentControlId },
        });
        const snap = parse<RelianceControlSnapshot>(item.snapshotJson);
        expect(snap.reliance.workpapers).toEqual([]);
        expect(snap.reliance.limits).toContain('NO_WORKPAPERS_IN_PERIOD');
        expect(snap.reliance.sampling.agreementRate).toBeNull();
    });

    it('the summary carries the rate with its definition, the catalogue version and its standing', async () => {
        const item = await prisma.auditPackItem.findFirstOrThrow({
            where: { auditPackId: packId, entityType: 'FRAMEWORK_COVERAGE' },
        });
        const summary = parse<RelianceSummarySnapshot>(item.snapshotJson);
        expect(summary.framework).toEqual({ key: 'ISO42001', version: '2023' });
        expect(summary.agreement).toMatchObject({ workpapers: 3, concluded: 2, agreementRate: 0.5 });
        expect(summary.definitions.map((d) => d.id)).toEqual([
            'assurance.reliance_reperformance_agreement_rate',
            'assurance.reliance_reperformance_disagreement_rate',
        ]);
        expect(summary.definitions[0].population).toBe(
            METRIC_DEFINITIONS['assurance.reliance_reperformance_agreement_rate'].population,
        );
        expect(summary.catalogue.versions).toEqual([1]);
        expect(summary.limits).toEqual(
            expect.arrayContaining(['CATALOGUE_NOT_APPROVED_BY_INTERNAL_AUDIT', 'PROCEDURE_WITHOUT_CONTROL']),
        );
    });
});

// ─── Pack-scoped access ─────────────────────────────────────────────

describe('the external auditor’s access is pack-scoped', () => {
    it('a share link of the reliance pack reads that pack and nothing of another', async () => {
        const reliance = await assembleAgentAuditReliancePack(fx[T1].contexts.admin, fx[T1].cycleId, {
            name: 'Reliance for the certification body',
        });
        // Another frozen pack in the same tenant and cycle.
        const other = await createAuditPack(fx[T1].contexts.admin, fx[T1].cycleId, 'Unrelated pack');
        await addAuditPackItems(fx[T1].contexts.admin, other.id, [{ entityType: 'CONTROL', entityId: fx[T1].leaverControlId }]);
        await freezeAuditPack(fx[T1].contexts.admin, other.id);
        const otherItemIds = (await prisma.auditPackItem.findMany({ where: { auditPackId: other.id } })).map((i) => i.id);

        const { token } = await generateShareLink(fx[T1].contexts.admin, reliance.packId);
        const shared = await getPackByShareToken(token);
        expect(shared.pack.id).toBe(reliance.packId);
        expect(shared.pack.name).toBe('Reliance for the certification body');
        const sharedIds = shared.items.map((i) => i.id);
        for (const id of otherItemIds) expect(sharedIds).not.toContain(id);
        expect(shared.items.map((i) => i.entityType).sort()).toEqual(['CONTROL', 'CONTROL', 'FRAMEWORK_COVERAGE']);

        // The auditor's grant names this one pack.
        const auditor = await inviteAuditor(fx[T1].contexts.admin, 'certification-body@example.test', 'Certification body');
        await grantAuditorAccess(fx[T1].contexts.admin, auditor.id, reliance.packId);
        const grants = await prisma.auditorPackAccess.findMany({ where: { tenantId: T1, auditorId: auditor.id } });
        expect(grants.map((g) => g.auditPackId)).toEqual([reliance.packId]);
    });
});

// ─── Two tenants ────────────────────────────────────────────────────

describe('one tenant’s pack holds nothing of another', () => {
    it('T2’s workpapers never appear in T1’s pack, and T1 cannot assemble T2’s cycle', async () => {
        const t2Paper = await makeWorkpaper(T2, '2026-07');
        await sweep(T2);
        const t2Pack = await assembleAgentAuditReliancePack(fx[T2].contexts.admin, fx[T2].cycleId);
        const t1Pack = await assembleAgentAuditReliancePack(fx[T1].contexts.admin, fx[T1].cycleId);

        const t1Items = await prisma.auditPackItem.findMany({ where: { auditPackId: t1Pack.packId } });
        for (const item of t1Items) expect(item.snapshotJson).not.toContain(t2Paper.id);
        expect(t1Items.map((i) => i.entityId)).not.toContain(fx[T2].leaverControlId);

        const t2Items = await prisma.auditPackItem.findMany({ where: { auditPackId: t2Pack.packId } });
        expect(t2Items.some((i) => i.snapshotJson.includes(t2Paper.id))).toBe(true);

        await expect(assembleAgentAuditReliancePack(fx[T1].contexts.admin, fx[T2].cycleId)).rejects.toBeInstanceOf(
            NotFoundError,
        );
    });
});

// ─── Refusals ───────────────────────────────────────────────────────

describe('zero is never reliance, and every refusal names its reason and leaves a row', () => {
    it('refuses a cycle with no period', async () => {
        const cycle = await prisma.auditCycle.create({
            data: {
                tenantId: T1,
                frameworkKey: 'ISO42001',
                frameworkVersion: '2023',
                name: 'No period',
                createdByUserId: fx[T1].users.admin,
            },
        });
        expect(await reasonOf(assembleAgentAuditReliancePack(fx[T1].contexts.admin, cycle.id))).toBe(
            'CYCLE_PERIOD_REQUIRED',
        );
        expect(await prisma.auditPack.count({ where: { auditCycleId: cycle.id } })).toBe(0);
        const rows = await prisma.auditLog.findMany({
            where: { tenantId: T1, action: 'AGENT_AUDIT_RELIANCE_PACK_REFUSED', entityId: cycle.id },
        });
        expect(rows).toHaveLength(1);
    });

    it('refuses a period with no workpaper and writes no pack', async () => {
        const cycle = await prisma.auditCycle.create({
            data: {
                tenantId: T1,
                frameworkKey: 'ISO42001',
                frameworkVersion: '2023',
                name: 'An empty year',
                periodStartAt: new Date('2024-01-01T00:00:00Z'),
                periodEndAt: new Date('2024-12-31T00:00:00Z'),
                createdByUserId: fx[T1].users.admin,
            },
        });
        expect(await reasonOf(assembleAgentAuditReliancePack(fx[T1].contexts.admin, cycle.id))).toBe(
            'NO_WORKPAPERS_IN_PERIOD',
        );
        expect(await prisma.auditPack.count({ where: { auditCycleId: cycle.id } })).toBe(0);
    });
});

// ─── Who may assemble ───────────────────────────────────────────────

describe('only the population that may freeze a pack assembles one', () => {
    it.each(['editor', 'thirdA', 'second'] as Person[])('refuses %s', async (who) => {
        const before = await prisma.auditPack.count({ where: { tenantId: T1 } });
        await expect(assembleAgentAuditReliancePack(fx[T1].contexts[who], fx[T1].cycleId)).rejects.toBeInstanceOf(
            ForbiddenError,
        );
        expect(await prisma.auditPack.count({ where: { tenantId: T1 } })).toBe(before);
    });

    it('the OWNER assembles one', async () => {
        const result = await assembleAgentAuditReliancePack(fx[T1].contexts.owner, fx[T1].cycleId);
        expect(result.status).toBe('FROZEN');
    });
});
