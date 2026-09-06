/**
 * THE ASSESSOR-FACING REPORTS — every count computed by hand, under two tenants.
 *
 * ## Why the expected numbers are written out longhand below
 *
 * Asserting whatever the code returns proves only that it is deterministic. So
 * every figure in this suite is derived from the fixture in a comment beside the
 * assertion — five agents, three of them ACTIVE, one of them stale — and the
 * assertion is against the derivation, not against a recorded output. If the
 * implementation changes what a number MEANS, the arithmetic here stops matching
 * and the test says so, which is the whole point of a report test.
 *
 * ## Why three tenants
 *
 * Two are the isolation pair. `T1` is richly populated and `T2` holds a
 * DIFFERENT, smaller, non-zero set — different on purpose, because two tenants
 * with the same data cannot distinguish "isolated" from "coincidentally equal".
 * A report is precisely the surface where an isolation mistake is both most
 * likely and most damaging, because it AGGREGATES: a leak does not show up as
 * another tenant's row appearing on a page, it shows up as a number being wrong
 * by an amount nobody can see.
 *
 * The third, `T3`, is EMPTY — no agents, no kills, no drills, no proposals. It
 * exists for the distinction the whole pack is built on: a tenant with nothing
 * must not report the same figures as a tenant with something that measured
 * zero. `T2` runs one drill that let nothing through (MEASURED 0) and `T3` has
 * run none (NO_POPULATION), and those two are asserted side by side.
 *
 * The fourth, `T4`, exists because that pair was not enough, and the way it was
 * not enough is worth stating. `T2` and `T3` disagree, so they look like a test
 * of the distinction — but they disagree about whether any drill row EXISTS,
 * and the guard they were checking was `drills.length === 0`. Every case where
 * a row exists but proved nothing fell in the gap between them, and the pack's
 * flagship claim was being handed out there. `T4` has run exactly one drill and
 * it ERRORED: a row, so not empty, and `toolCallsAfterKill` still on its schema
 * default of 0. It must render as neither of the other two.
 *
 * ## The fixture is written with raw Prisma, deliberately
 *
 * Agents go in through `createRegisteredAgent` so the encryption and
 * sanitisation seams are the real ones. Everything else — lifecycle status,
 * scored tiers, completed assessments, kills, drills, breakers, decided
 * proposals — is written directly, because the usecases that normally write
 * them have their own rescoring, alerting and clock behaviour, and a fixture
 * built through them would make the arithmetic below depend on machinery this
 * suite is not testing.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import {
    buildAgentGovernancePack,
    buildAgentInventoryReport,
    buildApprovalStatisticsReport,
    buildAsiCoverageReport,
    buildIncidentHistoryReport,
    buildThirdPartyAssessmentReport,
    REPORT_IDS,
} from '@/app-layer/usecases/agent-governance-reports';
import { METRIC_DEFINITIONS } from '@/lib/agentic/report-definitions';
import { KILL_SWITCH_DRILL_AGENT_ID } from '@/lib/agentic/kill-switch';
import type { Measure } from '@/lib/agentic/report-measures';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'agrep-tenant-one';
const T2 = 'agrep-tenant-two';
const T3 = 'agrep-tenant-empty';
const T4 = 'agrep-tenant-errored-drill';
const TENANTS = [T1, T2, T3, T4] as const;

const DAY = 24 * 60 * 60 * 1000;
/**
 * ONE clock reading for the whole fixture.
 *
 * `ago()` used to read `Date.now()` per call, so the kill engaged at `ago(10)`
 * and lifted at `ago(1)` were nine days apart PLUS however many milliseconds
 * elapsed between the two reads — and `longest_kill_minutes` is asserted as an
 * exact 12960. That is a one-millisecond flake hiding inside an exact-equality
 * assertion, which fails perhaps one run in three and looks like a bug in the
 * code under test. Pinning the base instant makes every fixture interval exact.
 */
const CLOCK = Date.now();
const ago = (days: number) => new Date(CLOCK - days * DAY);

interface Seeded {
    ownerUserId: string;
    secondUserId: string;
    thirdUserId: string;
    agents: Record<string, string>;
    vendors: Record<string, string>;
}
const seeded: Record<string, Seeded> = {};

const ctxFor = (tenantId: string) =>
    makeRequestContext('OWNER', {
        tenantId,
        tenantSlug: tenantId,
        userId: seeded[tenantId].ownerUserId,
    });

/** The requirement ids of the three-risk ASI framework this suite installs. */
const asiRequirementIds: Record<string, string> = {};

/**
 * `resetDatabase` truncates a fixed table list that includes none of the agentic
 * tables, so this suite clears its own rows — otherwise it passes exactly once
 * on a fresh database and fails every re-run, and CI always starts clean, which
 * is what would hide it.
 *
 * The AuditLog / TenantMembership deletes go through `session_replication_role
 * = 'replica'`: the immutable-audit-log trigger and the last-OWNER guard both
 * fire on an ordinary DELETE and would take the teardown — and therefore the
 * whole suite — down with them.
 */
async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [...TENANTS] } };
    await prisma.agentProposalSampleAudit.deleteMany({ where: t });
    await prisma.agentProposalApproval.deleteMany({ where: t });
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.agentKillSwitchDrill.deleteMany({ where: t });
    await prisma.agentKillSwitch.deleteMany({ where: t });
    await prisma.agentCircuitBreaker.deleteMany({ where: t });
    await prisma.agentBehaviourWindow.deleteMany({ where: t });
    await prisma.agentPolicyCardVersion.deleteMany({ where: t });
    await prisma.agentPolicyCard.deleteMany({ where: t });
    await prisma.agentRiskAssessmentAnswer.deleteMany({ where: t });
    await prisma.agentRiskAssessment.deleteMany({ where: t });
    await prisma.registeredAgentTool.deleteMany({ where: t });
    await prisma.mcpToolManifestPin.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystemRequirementLink.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.controlRequirementLink.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    // Before the users: `VendorAssessment.requestedByUserId` is a real FK, so
    // deleting this suite's users first violates it and the failure surfaces as
    // "suite failed to run" in teardown rather than as anything legible.
    await prisma.vendorAssessment.deleteMany({ where: t });
    await prisma.vendor.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`,
            [...TENANTS],
        );
        await tx.$executeRawUnsafe(
            `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
            [...TENANTS],
        );
    });
    await prisma.user.deleteMany({
        where: {
            emailHash: {
                in: TENANTS.flatMap((t2) =>
                    ['owner', 'second', 'third'].map((who) => hashForLookup(`${who}@${t2}.test`)),
                ),
            },
        },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [...TENANTS] } } });
}

async function makeUser(tenantId: string, who: string, role: Role): Promise<string> {
    const email = `${who}@${tenantId}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role, status: MembershipStatus.ACTIVE },
    });
    return user.id;
}

/** One AiSystem per agent — the register's 1:1 link is required, not ceremony. */
async function makeAiSystem(tenantId: string, name: string, ownerUserId: string): Promise<string> {
    const row = await prisma.aiSystem.create({ data: { tenantId, name, ownerUserId } });
    return row.id;
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();

    // ── The framework. Exactly THREE risks, so "risks in framework" is a
    //    number this file owns rather than one the seed happens to carry.
    const framework = await prisma.framework.create({
        data: {
            key: 'OWASP-ASI',
            name: 'OWASP Agentic AI Top 10',
            sourceUrn: 'urn:inflect:library:owasp-agentic-top10',
        },
    });
    for (const [i, code] of ['ASI01', 'ASI02', 'ASI03'].entries()) {
        const req = await prisma.frameworkRequirement.create({
            data: {
                frameworkId: framework.id,
                code,
                title: `${code} — agentic risk`,
                sortOrder: i,
            },
        });
        asiRequirementIds[code] = req.id;
    }

    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        seeded[tenantId] = {
            ownerUserId: await makeUser(tenantId, 'owner', Role.OWNER),
            secondUserId: await makeUser(tenantId, 'second', Role.ADMIN),
            thirdUserId: await makeUser(tenantId, 'third', Role.EDITOR),
            agents: {},
            vendors: {},
        };
    }

    await seedTenantOne();
    await seedTenantTwo();
    await seedTenantFour();
    // T3 is deliberately left with a tenant, users and NOTHING else.
});

afterAll(async () => {
    await clearOwnRows();
    // Requirements before the framework — the link tables that pointed at them
    // are already gone above.
    await prisma.frameworkRequirement.deleteMany({
        where: { code: { in: ['ASI01', 'ASI02', 'ASI03'] } },
    });
    await prisma.framework.deleteMany({ where: { key: 'OWASP-ASI' } });
    await prisma.$disconnect();
});

/**
 * T1 — the rich fixture. Five agents:
 *
 *   A1 ops        FIRST_PARTY  autonomy 3  ACTIVE   MODERATE  assessed fresh  card v2  2 tools
 *   A2 sweeper    FIRST_PARTY  autonomy 5  ACTIVE   HIGH      assessed STALE  no card  0 tools
 *   A3 vendorbot  THIRD_PARTY  autonomy 2  DRAFT    unscored  never assessed  no card  0 tools
 *   A4 retired    FIRST_PARTY  autonomy 1  RETIRED  LOW       assessed fresh  card v1  1 tool
 *   A5 supplier   THIRD_PARTY  autonomy 4  ACTIVE   unscored  never assessed  no card  0 tools
 */
async function seedTenantOne(): Promise<void> {
    const s = seeded[T1];
    const ctx = ctxFor(T1);

    for (const [key, name] of [['V1', 'Assessed supplier'], ['V2', 'Unassessed supplier']] as const) {
        const vendor = await prisma.vendor.create({ data: { tenantId: T1, name } });
        s.vendors[key] = vendor.id;
    }

    const specs = [
        { key: 'A1', name: 'Ops agent', autonomy: 3, provenance: 'FIRST_PARTY', vendor: null },
        { key: 'A2', name: 'Nightly sweeper', autonomy: 5, provenance: 'FIRST_PARTY', vendor: null },
        { key: 'A3', name: 'Vendor bot', autonomy: 2, provenance: 'THIRD_PARTY', vendor: 'V1' },
        { key: 'A4', name: 'Retired helper', autonomy: 1, provenance: 'FIRST_PARTY', vendor: null },
        { key: 'A5', name: 'Supplier agent', autonomy: 4, provenance: 'THIRD_PARTY', vendor: 'V2' },
    ] as const;

    for (const spec of specs) {
        const aiSystemId = await makeAiSystem(T1, `System for ${spec.name}`, s.ownerUserId);
        const created = await createRegisteredAgent(ctx, {
            aiSystemId,
            name: spec.name,
            description: `Does ${spec.name} things`,
            autonomyLevel: spec.autonomy,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'COMPENSABLE',
            provenance: spec.provenance,
            ownerUserId: s.ownerUserId,
            ...(spec.vendor ? { vendorId: s.vendors[spec.vendor] } : {}),
        });
        s.agents[spec.key] = created.id;
    }

    // Lifecycle + scored tiers, written directly: `updateRegisteredAgent`
    // re-scores on a widen, which would make the arithmetic here depend on the
    // scorer rather than on the fixture.
    await prisma.registeredAgent.update({
        where: { id: s.agents.A1 },
        data: { status: 'ACTIVE', riskTier: 'MODERATE', riskTierScoredAt: ago(20) },
    });
    await prisma.registeredAgent.update({
        where: { id: s.agents.A2 },
        data: { status: 'ACTIVE', riskTier: 'HIGH', riskTierScoredAt: ago(30) },
    });
    await prisma.registeredAgent.update({
        where: { id: s.agents.A4 },
        data: { status: 'RETIRED', riskTier: 'LOW', riskTierScoredAt: ago(40) },
    });
    await prisma.registeredAgent.update({
        where: { id: s.agents.A5 },
        data: { status: 'ACTIVE' },
    });
    // A3 stays DRAFT and unscored — the "nobody has assessed this" state.

    await prisma.agentRiskAssessment.createMany({
        data: [
            {
                tenantId: T1, agentId: s.agents.A1, status: 'COMPLETED',
                scoredTier: 'MODERATE', completedAt: ago(20), staleAt: null, staleTriggers: [],
            },
            {
                tenantId: T1, agentId: s.agents.A2, status: 'COMPLETED',
                scoredTier: 'HIGH', completedAt: ago(30), staleAt: ago(4),
                staleTriggers: ['AUTONOMY_RAISED', 'TOOL_GRANTED'],
            },
            {
                tenantId: T1, agentId: s.agents.A4, status: 'COMPLETED',
                scoredTier: 'LOW', completedAt: ago(40), staleAt: null, staleTriggers: [],
            },
        ],
    });

    await prisma.agentPolicyCard.createMany({
        data: [
            { tenantId: T1, agentId: s.agents.A1, currentVersion: 2 },
            { tenantId: T1, agentId: s.agents.A4, currentVersion: 1 },
        ],
    });

    await prisma.registeredAgentTool.createMany({
        data: [
            { tenantId: T1, agentId: s.agents.A1, toolName: 'list_risks', grantedByUserId: s.ownerUserId },
            { tenantId: T1, agentId: s.agents.A1, toolName: 'list_controls', grantedByUserId: s.ownerUserId },
            { tenantId: T1, agentId: s.agents.A4, toolName: 'list_risks', grantedByUserId: s.ownerUserId },
        ],
    });

    // ── Coverage. Two controls, ASI03 left with none.
    const c1 = await prisma.control.create({
        data: { tenantId: T1, name: 'Agent action logging', code: 'AC-1' },
    });
    const c2 = await prisma.control.create({
        data: { tenantId: T1, name: 'Tool allowlist', code: 'AC-2' },
    });
    await prisma.controlRequirementLink.createMany({
        data: [
            { tenantId: T1, controlId: c1.id, requirementId: asiRequirementIds.ASI01 },
            { tenantId: T1, controlId: c2.id, requirementId: asiRequirementIds.ASI02 },
        ],
    });
    const a1System = await prisma.registeredAgent.findUniqueOrThrow({
        where: { id: s.agents.A1 },
        select: { aiSystemId: true },
    });
    await prisma.aiSystemRequirementLink.create({
        data: { tenantId: T1, aiSystemId: a1System.aiSystemId, requirementId: asiRequirementIds.ASI01 },
    });

    // ── The approval queue. Four decided, one pending, one expired.
    const proposals = [
        { key: 'P1', status: 'ACCEPTED', reviewer: s.ownerUserId, createdAgo: 40, latencySec: 600 },
        { key: 'P2', status: 'EDITED', reviewer: s.ownerUserId, createdAgo: 39, latencySec: 1200 },
        { key: 'P3', status: 'REJECTED', reviewer: s.secondUserId, createdAgo: 38, latencySec: 300 },
        { key: 'P6', status: 'ACCEPTED', reviewer: s.thirdUserId, createdAgo: 37, latencySec: 2 },
    ] as const;
    const proposalIds: Record<string, string> = {};
    for (const p of proposals) {
        const createdAt = ago(p.createdAgo);
        const row = await prisma.agentProposal.create({
            data: {
                tenantId: T1,
                agentId: s.agents.A1,
                kind: 'RISK',
                status: p.status,
                payloadJson: JSON.stringify({ title: 'proposed' }),
                reviewedByUserId: p.reviewer,
                reviewedAt: new Date(createdAt.getTime() + p.latencySec * 1000),
                createdAt,
            },
        });
        proposalIds[p.key] = row.id;
    }
    await prisma.agentProposal.create({
        data: {
            tenantId: T1, agentId: s.agents.A1, kind: 'CONTROL', status: 'PENDING',
            payloadJson: JSON.stringify({ title: 'waiting' }),
        },
    });
    await prisma.agentProposal.create({
        data: {
            tenantId: T1, agentId: s.agents.A1, kind: 'CONTROL', status: 'EXPIRED',
            payloadJson: JSON.stringify({ title: 'timed out' }),
        },
    });

    await prisma.agentProposalSampleAudit.createMany({
        data: [
            {
                tenantId: T1, proposalId: proposalIds.P1, samplingEpoch: '2026-09-01',
                outcome: 'CONCURRED', reviewedByUserId: s.secondUserId, reviewedAt: ago(5),
                sampledAt: ago(6),
            },
            {
                tenantId: T1, proposalId: proposalIds.P2, samplingEpoch: '2026-09-01',
                outcome: 'DISSENTED', dissentCodes: ['SHOULD_HAVE_BEEN_REJECTED'],
                reviewedByUserId: s.secondUserId, reviewedAt: ago(5), sampledAt: ago(6),
            },
            {
                tenantId: T1, proposalId: proposalIds.P3, samplingEpoch: '2026-09-01',
                outcome: 'PENDING', sampledAt: ago(6),
            },
        ],
    });

    // ── Kills. K1 lifted (9 days), K2 in force (5 days), K3 + K5 canary,
    //    K4 outside the 90-day window.
    await prisma.agentKillSwitch.createMany({
        data: [
            {
                tenantId: T1, agentId: null, reason: 'Suspected data exfiltration',
                engagedByUserId: s.ownerUserId, engagedAt: ago(10), liftedAt: ago(1),
                liftedByUserId: s.ownerUserId, liftReason: 'Cleared',
            },
            {
                tenantId: T1, agentId: seeded[T1].agents.A2, reason: 'Runaway sweeper',
                engagedByUserId: s.ownerUserId, engagedAt: ago(5), liftedAt: null,
            },
            {
                tenantId: T1, agentId: KILL_SWITCH_DRILL_AGENT_ID, reason: 'Scheduled drill',
                engagedByUserId: s.ownerUserId, engagedAt: ago(2), liftedAt: ago(2),
                liftedByUserId: s.ownerUserId, liftReason: 'Drill complete',
            },
            {
                tenantId: T1, agentId: KILL_SWITCH_DRILL_AGENT_ID, reason: 'Drill that died',
                engagedByUserId: s.ownerUserId, engagedAt: ago(3), liftedAt: null,
            },
            {
                tenantId: T1, agentId: null, reason: 'Ancient incident',
                engagedByUserId: s.ownerUserId, engagedAt: ago(200), liftedAt: ago(199),
                liftedByUserId: s.ownerUserId, liftReason: 'Closed',
            },
        ],
    });

    await prisma.agentKillSwitchDrill.createMany({
        data: [
            {
                tenantId: T1, jobRunId: 'run-1', outcome: 'PASSED', startedAt: ago(3),
                completedAt: ago(3), toolCallsAfterKill: 0, scopesHonoured: ['AGENT', 'TENANT'],
                scopesFailed: [], boundaryRefusalReason: 'agent_killed', detail: 'clean',
            },
            {
                tenantId: T1, jobRunId: 'run-2', outcome: 'FAILED', startedAt: ago(2),
                completedAt: ago(2), toolCallsAfterKill: 2, scopesHonoured: ['TENANT'],
                scopesFailed: ['AGENT'], boundaryRefusalReason: null, detail: 'two got through',
                findingId: 'finding-abc',
            },
            {
                tenantId: T1, jobRunId: 'run-3', outcome: 'ERROR', startedAt: ago(1),
                toolCallsAfterKill: 0, scopesHonoured: [], scopesFailed: [], detail: 'could not run',
            },
            {
                tenantId: T1, jobRunId: 'run-0', outcome: 'PASSED', startedAt: ago(200),
                completedAt: ago(200), toolCallsAfterKill: 0, scopesHonoured: ['AGENT'],
                scopesFailed: [], detail: 'ancient',
            },
        ],
    });

    await prisma.agentCircuitBreaker.createMany({
        data: [
            {
                tenantId: T1, agentId: s.agents.A1, state: 'CLOSED', trippedAt: ago(10),
                trippedWindow: '2026-08-27T03', trippedSignals: ['NEW_CAPABILITY_CLASS'],
                closedAt: ago(9), closedByUserId: s.ownerUserId, closeReason: 'RESOLVED',
            },
            {
                tenantId: T1, agentId: s.agents.A2, state: 'OPEN', trippedAt: ago(1),
                trippedWindow: '2026-09-05T02', trippedSignals: ['RATE_SPIKE'],
            },
        ],
    });

    await prisma.mcpToolManifestPin.createMany({
        data: [
            {
                tenantId: T1, toolName: 'list_risks', descriptionHash: 'd1', schemaHash: 's1',
                manifestHash: 'm1', approvalSource: 'BASELINE', revision: 1,
            },
            {
                tenantId: T1, toolName: 'list_controls', descriptionHash: 'd2', schemaHash: 's2',
                manifestHash: 'm2', approvalSource: 'APPROVED', approvedByUserId: s.ownerUserId,
                revision: 2, previousManifestHash: 'm2-old',
            },
        ],
    });

    await prisma.vendorAssessment.createMany({
        data: [
            {
                tenantId: T1, vendorId: s.vendors.V1, status: 'APPROVED',
                requestedByUserId: s.ownerUserId, decidedAt: ago(15), riskRating: 'LOW',
            },
            {
                tenantId: T1, vendorId: s.vendors.V2, status: 'IN_PROGRESS',
                requestedByUserId: s.ownerUserId,
            },
        ],
    });
}

/**
 * T2 — a DIFFERENT, smaller, non-zero fixture. One agent, one control, one
 * decided proposal, one kill, one PASSED drill.
 */
async function seedTenantTwo(): Promise<void> {
    const s = seeded[T2];
    const ctx = ctxFor(T2);

    const aiSystemId = await makeAiSystem(T2, 'System for B1', s.ownerUserId);
    const b1 = await createRegisteredAgent(ctx, {
        aiSystemId,
        name: 'Tenant two agent',
        description: 'Reads only',
        autonomyLevel: 0,
        dataAccessScope: 'READ_METADATA',
        reversibility: 'REVERSIBLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: s.ownerUserId,
    });
    s.agents.B1 = b1.id;

    const control = await prisma.control.create({
        data: { tenantId: T2, name: 'Tenant two logging', code: 'BC-1' },
    });
    await prisma.controlRequirementLink.create({
        data: { tenantId: T2, controlId: control.id, requirementId: asiRequirementIds.ASI01 },
    });

    await prisma.agentProposal.create({
        data: {
            tenantId: T2, agentId: b1.id, kind: 'RISK', status: 'REJECTED',
            payloadJson: JSON.stringify({ title: 'nope' }),
            reviewedByUserId: s.ownerUserId,
            reviewedAt: new Date(ago(10).getTime() + 900_000),
            createdAt: ago(10),
        },
    });

    await prisma.agentKillSwitch.create({
        data: {
            tenantId: T2, agentId: null, reason: 'Tenant two pause',
            engagedByUserId: s.ownerUserId, engagedAt: ago(7), liftedAt: ago(6),
            liftedByUserId: s.ownerUserId, liftReason: 'Resumed',
        },
    });

    await prisma.agentKillSwitchDrill.create({
        data: {
            tenantId: T2, jobRunId: 'run-t2', outcome: 'PASSED', startedAt: ago(1),
            completedAt: ago(1), toolCallsAfterKill: 0, scopesHonoured: ['TENANT'],
            scopesFailed: [], boundaryRefusalReason: 'tenant_killed', detail: 'clean',
        },
    });
}

/**
 * T4 — one drill, and it ERRORED. Nothing else at all.
 *
 * Every field is left exactly as a run that died would leave it: no
 * `completedAt`, neither scope list touched, no `boundaryRefusalReason`, and —
 * the load-bearing one — `toolCallsAfterKill` NOT PASSED, so the row carries the
 * schema's `@default(0)`. Writing `toolCallsAfterKill: 0` here would look
 * identical in the database and would be a different fixture: it would assert
 * that somebody measured zero. The point is that nobody measured anything.
 */
async function seedTenantFour(): Promise<void> {
    await prisma.agentKillSwitchDrill.create({
        data: {
            tenantId: T4,
            jobRunId: 'run-t4',
            outcome: 'ERROR',
            startedAt: ago(1),
            completedAt: null,
            scopesHonoured: [],
            scopesFailed: [],
            detail: 'could not run',
        },
    });
}

// ─── Helpers the assertions read through ────────────────────────────

function expectMeasured(m: Measure | undefined, value: number): void {
    expect(m).toBeDefined();
    expect(m?.state).toBe('MEASURED');
    expect(m?.value).toBe(value);
}

function expectAbsent(m: Measure | undefined, state: string, basis: string): void {
    expect(m).toBeDefined();
    expect(m?.state).toBe(state);
    expect(m?.value).toBeNull();
    expect(m?.basis).toBe(basis);
}

// ═══════════════════════════════════════════════════════════════════

describe('every number carries a written definition', () => {
    it('each report’s definitions cover exactly the metrics it emitted', async () => {
        const pack = await buildAgentGovernancePack(ctxFor(T1));
        const reports = [
            pack.inventory, pack.asiCoverage, pack.approvals, pack.incidents, pack.thirdParty,
        ];

        expect(reports.map((r) => r.reportId).sort()).toEqual([...REPORT_IDS].sort());

        for (const report of reports) {
            const emitted = Object.keys(report.metrics).sort();
            const defined = report.definitions.map((d) => d.id).sort();
            // Both directions. A metric with no definition is a number nobody
            // can defend; a definition with no metric is a claim the report
            // does not actually make.
            expect(defined).toEqual(emitted);
            expect(emitted.length).toBeGreaterThan(0);
        }
    });

    it('and no definition is an empty gesture', async () => {
        const report = await buildAgentInventoryReport(ctxFor(T1));
        for (const def of report.definitions) {
            expect(def.population.length).toBeGreaterThan(20);
            expect(['AS_OF_GENERATION', 'OVER_WINDOW']).toContain(def.moment);
            // `excludes` is where the arguable decisions live, so every metric
            // must have stated at least one. `includes` may legitimately be
            // empty on the one metric that is NOT_OBSERVABLE.
            expect(def.excludes.length).toBeGreaterThan(0);
        }
    });

    it('the registry’s keys are its ids — a renamed key cannot silently mismatch', () => {
        for (const [key, def] of Object.entries(METRIC_DEFINITIONS)) {
            expect(def.id).toBe(key);
        }
    });
});

describe('agent inventory', () => {
    it('counts T1’s five agents the way the fixture describes them', async () => {
        const report = await buildAgentInventoryReport(ctxFor(T1));
        const m = report.metrics;

        // Fixture: A1..A5. Three ACTIVE (A1, A2, A5); one RETIRED (A4);
        // A3 is DRAFT. Two unscored (A3, A5). One stale (A2). One at or above
        // autonomy 5 (A2). Two THIRD_PARTY (A3, A5). Three with no card
        // (A2, A3, A5).
        expectMeasured(m['inventory.registered_agents'], 5);
        expectMeasured(m['inventory.active_agents'], 3);
        expectMeasured(m['inventory.retired_agents'], 1);
        expectMeasured(m['inventory.unscored_agents'], 2);
        expectMeasured(m['inventory.stale_assessments'], 1);
        expectMeasured(m['inventory.unattended_agents'], 1);
        expectMeasured(m['inventory.third_party_agents'], 2);
        expectMeasured(m['inventory.agents_without_policy_card'], 3);

        expect(report.body.legacyPlaceholderPresent).toBe(false);
        expect(report.window).toBeNull();
    });

    it('reports the three assessment states apart — never as one tier column', async () => {
        const report = await buildAgentInventoryReport(ctxFor(T1));
        const byName = new Map(report.body.agents.map((a) => [a.name, a]));

        const a1 = byName.get('Ops agent');
        expect(a1?.assessmentState).toBe('ASSESSED');
        expect(a1?.riskTier).toBe('MODERATE');
        expect(a1?.staleTriggers).toEqual([]);

        const a2 = byName.get('Nightly sweeper');
        expect(a2?.assessmentState).toBe('ASSESSED_STALE');
        expect(a2?.riskTier).toBe('HIGH');
        expect(a2?.staleTriggers).toEqual(['AUTONOMY_RAISED', 'TOOL_GRANTED']);

        // The one that must never read as a low tier.
        const a3 = byName.get('Vendor bot');
        expect(a3?.assessmentState).toBe('NEVER_ASSESSED');
        expect(a3?.riskTier).toBeNull();
        expect(a3?.riskTierScoredAt).toBeNull();
    });

    it('keeps the kill axis, the card and the tool grants distinct per agent', async () => {
        const report = await buildAgentInventoryReport(ctxFor(T1));
        const byName = new Map(report.body.agents.map((a) => [a.name, a]));

        // A2 is ACTIVE in the register AND stopped by an agent-scoped kill.
        // Two facts, two columns.
        expect(byName.get('Nightly sweeper')?.status).toBe('ACTIVE');
        expect(byName.get('Nightly sweeper')?.killState).toBe('KILLED_BY_AGENT_SCOPE');
        expect(byName.get('Ops agent')?.killState).toBe('RUNNING');

        expect(byName.get('Ops agent')?.policyCardVersion).toBe(2);
        expect(byName.get('Nightly sweeper')?.policyCardVersion).toBeNull();
        expect(byName.get('Ops agent')?.grantedToolCount).toBe(2);
        expect(byName.get('Vendor bot')?.grantedToolCount).toBe(0);

        expect(byName.get('Ops agent')?.breakerState).toBe('CLOSED');
        expect(byName.get('Nightly sweeper')?.breakerState).toBe('OPEN');
        // No breaker row at all — NOT "closed". Never observed.
        expect(byName.get('Vendor bot')?.breakerState).toBeNull();
    });

    it('names the accountable human on every row', async () => {
        const report = await buildAgentInventoryReport(ctxFor(T1));
        expect(report.body.agents).toHaveLength(5);
        for (const row of report.body.agents) {
            expect(row.ownerUserId).toBe(seeded[T1].ownerUserId);
        }
    });

    it('and sees only T2’s single agent from T2', async () => {
        const report = await buildAgentInventoryReport(ctxFor(T2));
        const m = report.metrics;

        // Fixture: exactly one agent, DRAFT, unscored, autonomy 0, first-party.
        expectMeasured(m['inventory.registered_agents'], 1);
        // A real, measured zero: the population is non-empty and none is ACTIVE.
        expectMeasured(m['inventory.active_agents'], 0);
        expectMeasured(m['inventory.third_party_agents'], 0);
        expectMeasured(m['inventory.unscored_agents'], 1);
        expectMeasured(m['inventory.stale_assessments'], 0);

        expect(report.body.agents.map((a) => a.name)).toEqual(['Tenant two agent']);
    });

    it('and reports T3’s emptiness as NO POPULATION, not as zero', async () => {
        const report = await buildAgentInventoryReport(ctxFor(T3));
        const m = report.metrics;

        // The register itself is legitimately zero — that IS the count.
        expectMeasured(m['inventory.registered_agents'], 0);
        // But every figure ABOUT those agents has no population to be true of.
        // T2's `active_agents` above is MEASURED 0 and this is NO_POPULATION:
        // the same rendering for both would tell an assessor nothing.
        expectAbsent(m['inventory.active_agents'], 'NO_POPULATION', 'NO_AGENTS_REGISTERED');
        expectAbsent(m['inventory.unscored_agents'], 'NO_POPULATION', 'NO_AGENTS_REGISTERED');
        expectAbsent(m['inventory.third_party_agents'], 'NO_POPULATION', 'NO_AGENTS_REGISTERED');
        expect(report.body.agents).toEqual([]);
    });
});

describe('ASI01–ASI10 coverage per agent', () => {
    it('classifies T1’s three risks across five agents by hand', async () => {
        const report = await buildAsiCoverageReport(ctxFor(T1));

        expect(report.body.frameworkInstalled).toBe(true);
        expect(report.body.framework?.key).toBe('OWASP-ASI');

        // Fixture: control AC-1 → ASI01, AC-2 → ASI02, nothing → ASI03.
        // Only A1's AI system is scoped to ASI01.
        //   A1: ASI01 COVERED (scoped + direct), ASI02 PARTIAL, ASI03 UNCOVERED
        //   A2..A5: ASI01 PARTIAL, ASI02 PARTIAL, ASI03 UNCOVERED
        expectMeasured(report.metrics['asi.agents_in_scope'], 5);
        expectMeasured(report.metrics['asi.risks_in_framework'], 3);
        // Every agent leaves ASI03 uncovered, so none is fully covered. A real
        // zero over a real population.
        expectMeasured(report.metrics['asi.agents_fully_covered'], 0);
        // ASI03 alone has neither a covering nor a partially covering agent.
        expectMeasured(report.metrics['asi.risks_covered_by_no_agent'], 1);

        const byName = new Map(report.body.agents.map((a) => [a.name, a]));
        expect(byName.get('Ops agent')?.covered).toEqual(['ASI01']);
        expect(byName.get('Ops agent')?.partiallyCovered).toEqual(['ASI02']);
        expect(byName.get('Ops agent')?.uncovered).toEqual(['ASI03']);
        expect(byName.get('Nightly sweeper')?.covered).toEqual([]);
        expect(byName.get('Nightly sweeper')?.partiallyCovered).toEqual(['ASI01', 'ASI02']);
        expect(byName.get('Nightly sweeper')?.uncovered).toEqual(['ASI03']);
    });

    it('transposes to the per-risk column an assessor reads down', async () => {
        const report = await buildAsiCoverageReport(ctxFor(T1));
        const byCode = new Map(report.body.risks.map((r) => [r.code, r]));

        expect(report.body.risks.map((r) => r.code)).toEqual(['ASI01', 'ASI02', 'ASI03']);
        // ASI01: A1 covered, the other four partial.
        expect(byCode.get('ASI01')).toMatchObject({
            agentsCovered: 1, agentsPartiallyCovered: 4, agentsReviewNeeded: 0, agentsUncovered: 0,
        });
        expect(byCode.get('ASI02')).toMatchObject({
            agentsCovered: 0, agentsPartiallyCovered: 5, agentsUncovered: 0,
        });
        expect(byCode.get('ASI03')).toMatchObject({
            agentsCovered: 0, agentsPartiallyCovered: 0, agentsUncovered: 5,
        });
    });

    it('does not let T1’s controls cover T2’s agent', async () => {
        const report = await buildAsiCoverageReport(ctxFor(T2));

        // T2 has ONE control, on ASI01 only. T1's AC-2 covers ASI02 and must
        // not reach here — a leak would show up as ASI02 becoming partial.
        expectMeasured(report.metrics['asi.agents_in_scope'], 1);
        expectMeasured(report.metrics['asi.risks_in_framework'], 3);
        expectMeasured(report.metrics['asi.risks_covered_by_no_agent'], 2);

        const b1 = report.body.agents[0];
        expect(b1.name).toBe('Tenant two agent');
        expect(b1.covered).toEqual([]);
        expect(b1.partiallyCovered).toEqual(['ASI01']);
        expect(b1.uncovered).toEqual(['ASI02', 'ASI03']);
    });

    it('reports an agentless tenant’s coverage as NO POPULATION, not 0%', async () => {
        const report = await buildAsiCoverageReport(ctxFor(T3));

        expectMeasured(report.metrics['asi.agents_in_scope'], 0);
        // The framework IS installed, so this one is a real count.
        expectMeasured(report.metrics['asi.risks_in_framework'], 3);
        // These two are not zero — there is nothing to have covered anything.
        expectAbsent(report.metrics['asi.agents_fully_covered'], 'NO_POPULATION', 'NO_AGENTS_REGISTERED');
        expectAbsent(
            report.metrics['asi.risks_covered_by_no_agent'],
            'NO_POPULATION',
            'NO_AGENTS_REGISTERED',
        );
        expect(report.body.agents).toEqual([]);
    });
});

describe('approval statistics', () => {
    it('counts T1’s decisions and its automation-bias signals by hand', async () => {
        const report = await buildApprovalStatisticsReport(ctxFor(T1));
        const m = report.metrics;

        // Fixture: P1 ACCEPTED (600s), P2 EDITED (1200s), P3 REJECTED (300s),
        // P6 ACCEPTED (2s). Plus one PENDING and one EXPIRED, neither decided.
        expectMeasured(m['approvals.decided'], 4);
        expectMeasured(m['approvals.approved'], 3);
        expectMeasured(m['approvals.rejected'], 1);
        expectMeasured(m['approvals.approval_rate'], 3 / 4);
        // Three distinct humans decided something.
        expectMeasured(m['approvals.reviewers'], 3);
        // All three are below the engine's minimum reportable sample, so their
        // rate and median estimates are visibly refused rather than computed.
        expectMeasured(m['approvals.reviewers_below_reportable_sample'], 3);
        // The 2-second decision — an observation, reported at n = 1.
        expectMeasured(m['approvals.fastest_decision_seconds'], 2);
        // Exactly one pattern fires: P6 is under the 5-second implausibility
        // floor. No burst (5 approvals in 60s), no fast median (needs the
        // sample floor), no never-rejected reviewer (same floor).
        expectMeasured(m['approvals.bias_signals'], 1);
        // A snapshot, NOT window-scoped — queue depth now is what drives
        // rubber-stamping now.
        expectMeasured(m['approvals.pending_now'], 1);

        expect(report.window?.days).toBe(90);
        const codes = (report.body.signals as Array<{ code: string }>).map((s) => s.code);
        expect(codes).toEqual(['IMPLAUSIBLY_FAST_DECISION']);
    });

    it('reports the retrospective sample audit, and refuses a rate with nothing answered', async () => {
        const t1 = await buildApprovalStatisticsReport(ctxFor(T1));
        // Fixture: three drawn, two answered (one CONCURRED, one DISSENTED),
        // one still PENDING. The pending one must not improve the rate.
        expectMeasured(t1.metrics['approvals.sample_audits_answered'], 2);
        expectMeasured(t1.metrics['approvals.sample_audit_disagreement_rate'], 0.5);
        expect(t1.body.sampleAudit).toMatchObject({
            sampled: 3, answered: 2, pending: 1, concurred: 1, dissented: 1, indeterminate: 0,
        });

        const t2 = await buildApprovalStatisticsReport(ctxFor(T2));
        // T2 drew none. A perfect record and a queue nobody reviewed both
        // produce zero dissents, so the rate is refused rather than reported 0.
        expectMeasured(t2.metrics['approvals.sample_audits_answered'], 0);
        expectAbsent(
            t2.metrics['approvals.sample_audit_disagreement_rate'],
            'NOT_ASSESSED',
            'NO_ANSWERED_SAMPLE_AUDITS',
        );
    });

    it('sees only T2’s one decision from T2', async () => {
        const report = await buildApprovalStatisticsReport(ctxFor(T2));
        const m = report.metrics;

        // Fixture: one REJECTED proposal, 900s latency. Nothing pending.
        expectMeasured(m['approvals.decided'], 1);
        expectMeasured(m['approvals.approved'], 0);
        expectMeasured(m['approvals.rejected'], 1);
        expectMeasured(m['approvals.approval_rate'], 0);
        expectMeasured(m['approvals.reviewers'], 1);
        expectMeasured(m['approvals.fastest_decision_seconds'], 900);
        expectMeasured(m['approvals.bias_signals'], 0);
        expectMeasured(m['approvals.pending_now'], 0);
    });

    it('refuses an approval rate for a tenant that decided nothing', async () => {
        const report = await buildApprovalStatisticsReport(ctxFor(T3));

        expectMeasured(report.metrics['approvals.decided'], 0);
        // 0/0 is not 0. A tenant that decided nothing has not rejected
        // everything, which is what a rendered 0 would say.
        expectAbsent(report.metrics['approvals.approval_rate'], 'NO_POPULATION', 'NO_DECIDED_PROPOSALS');
        expectAbsent(
            report.metrics['approvals.fastest_decision_seconds'],
            'NO_POPULATION',
            'NO_DECIDED_PROPOSALS',
        );
    });

    it('carries the question it cannot answer rather than approximating it', async () => {
        const report = await buildApprovalStatisticsReport(ctxFor(T1));
        expect(report.body.unobservable).toContain('DIFF_EXPANSION');
    });

    it('refuses a window outside 1..365', async () => {
        await expect(buildApprovalStatisticsReport(ctxFor(T1), { windowDays: 0 })).rejects.toThrow();
        await expect(buildApprovalStatisticsReport(ctxFor(T1), { windowDays: 400 })).rejects.toThrow();
        await expect(
            buildApprovalStatisticsReport(ctxFor(T1), { windowDays: Number.NaN }),
        ).rejects.toThrow();
    });
});

describe('incident and kill-switch history', () => {
    it('counts T1’s kills, excluding the drill canary and the pre-window one', async () => {
        const report = await buildIncidentHistoryReport(ctxFor(T1));
        const m = report.metrics;

        // Fixture kills: tenant-wide 10d ago lifted 1d ago; agent-scoped on A2
        // 5d ago still in force; TWO canary kills; one 200 days ago.
        // In-window, non-canary: two.
        expectMeasured(m['incidents.kill_engagements'], 2);
        expectMeasured(m['incidents.drill_canary_engagements'], 2);
        // Snapshot: the A2 kill only. The unlifted CANARY kill must not count —
        // an exercise is not an outage.
        expectMeasured(m['incidents.kills_in_force_now'], 1);
        // The lifted tenant-wide kill ran 10d → 1d = 9 days = 12960 minutes,
        // which is longer than the 5-day kill still in force.
        expectMeasured(m['incidents.longest_kill_minutes'], 9 * 24 * 60);

        expect(report.body.kills.map((k) => k.scope).sort()).toEqual(['AGENT', 'TENANT']);
        const inForce = report.body.kills.find((k) => k.stillInForce);
        expect(inForce?.scope).toBe('AGENT');
        expect(inForce?.agentName).toBe('Nightly sweeper');
        // Measured to the generation instant while unlifted — five days, give
        // or take the runtime of the query.
        expect(inForce?.durationMinutes).toBeGreaterThan(5 * 24 * 60 - 5);
        expect(inForce?.durationMinutes).toBeLessThan(5 * 24 * 60 + 5);
    });

    it('counts T1’s drills and the calls that got through', async () => {
        const report = await buildIncidentHistoryReport(ctxFor(T1));
        const m = report.metrics;

        // Fixture: PASSED (0 through), FAILED (2 through), ERROR (0), plus one
        // 200 days old that the window excludes.
        expectMeasured(m['incidents.drills_run'], 3);
        expectMeasured(m['incidents.drills_failed'], 1);
        // ERROR is not FAILED: a drill that could not run proved nothing.
        expectMeasured(m['incidents.drills_errored'], 1);
        expectMeasured(m['incidents.tool_calls_after_kill'], 2);

        const failed = report.body.drills.find((d) => d.outcome === 'FAILED');
        expect(failed?.findingId).toBe('finding-abc');
        expect(failed?.scopesFailed).toEqual(['AGENT']);
    });

    it('counts breaker trips inside the window and open breakers as of now', async () => {
        const report = await buildIncidentHistoryReport(ctxFor(T1));
        // Fixture: A1's breaker tripped 10d ago and was closed; A2's tripped
        // 1d ago and is still open. Both trips are inside the 90-day window.
        expectMeasured(report.metrics['incidents.breaker_trips'], 2);
        expectMeasured(report.metrics['incidents.breakers_open_now'], 1);

        const open = report.body.breakers.find((b) => b.state === 'OPEN');
        expect(open?.agentName).toBe('Nightly sweeper');
        expect(open?.trippedSignals).toEqual(['RATE_SPIKE']);
        const closed = report.body.breakers.find((b) => b.state === 'CLOSED');
        expect(closed?.closeReason).toBe('RESOLVED');
    });

    it('narrows to the window when asked', async () => {
        const report = await buildIncidentHistoryReport(ctxFor(T1), { windowDays: 3 });
        // Inside 3 days: no non-canary kill was ENGAGED (10d and 5d ago), and
        // both canary kills were (2d and 3d — the 3d one lands on the boundary).
        expectMeasured(report.metrics['incidents.kill_engagements'], 0);
        // But the A2 kill is still in force, and that is a fact about now.
        expectMeasured(report.metrics['incidents.kills_in_force_now'], 1);
        // Only the FAILED (2d) and ERROR (1d) drills started inside 3 days.
        expectMeasured(report.metrics['incidents.drills_run'], 2);
        expectMeasured(report.metrics['incidents.tool_calls_after_kill'], 2);
        // A window with no engagement has no longest kill — not a zero.
        expectAbsent(report.metrics['incidents.longest_kill_minutes'], 'NO_POPULATION', 'NO_KILLS_ENGAGED');
    });

    it('sees only T2’s single kill and single drill from T2', async () => {
        const report = await buildIncidentHistoryReport(ctxFor(T2));
        const m = report.metrics;

        expectMeasured(m['incidents.kill_engagements'], 1);
        expectMeasured(m['incidents.drill_canary_engagements'], 0);
        expectMeasured(m['incidents.kills_in_force_now'], 0);
        expectMeasured(m['incidents.longest_kill_minutes'], 24 * 60);
        expectMeasured(m['incidents.drills_run'], 1);
        expectMeasured(m['incidents.drills_failed'], 0);
        // A DRILL RAN AND NOTHING GOT THROUGH. This is a measured zero, and it
        // is the strongest claim the product makes.
        expectMeasured(m['incidents.tool_calls_after_kill'], 0);
        expectMeasured(m['incidents.breaker_trips'], 0);
    });

    it('and refuses the same claim for a tenant that has never drilled', async () => {
        const report = await buildIncidentHistoryReport(ctxFor(T3));

        expectMeasured(report.metrics['incidents.drills_run'], 0);
        // NOT a zero. Summing an empty drill list gives 0, which would read as
        // "nothing got through the kill switch" from a tenant that has never
        // tested it — the same rendering T2 legitimately earned above.
        expectAbsent(
            report.metrics['incidents.tool_calls_after_kill'],
            'NO_POPULATION',
            'NO_DRILLS_RUN',
        );
        expectAbsent(
            report.metrics['incidents.longest_kill_minutes'],
            'NO_POPULATION',
            'NO_KILLS_ENGAGED',
        );
    });

    it('and refuses it AGAIN for a tenant whose only drill errored', async () => {
        const report = await buildIncidentHistoryReport(ctxFor(T4));

        // The row exists and is counted — T4 is not T3, and the pack says so.
        expectMeasured(report.metrics['incidents.drills_run'], 1);
        expectMeasured(report.metrics['incidents.drills_errored'], 1);
        // ERROR is not FAILED, so nothing here raises a Finding either.
        expectMeasured(report.metrics['incidents.drills_failed'], 0);

        // AND YET NOTHING WAS MEASURED. `toolCallsAfterKill` is on its schema
        // `@default(0)`, which a run that never reached the boundary never
        // overwrites, so summing this drill yields the pack's strongest claim
        // from a drill the schema itself calls "could not run". The population
        // a sum may run over is the drills that measured something; here that
        // population is empty while the drill population is not, which is
        // NOT_ASSESSED — the rows exist, the judgement does not.
        expectAbsent(
            report.metrics['incidents.tool_calls_after_kill'],
            'NOT_ASSESSED',
            'ALL_DRILLS_ERRORED',
        );
    });

    it('renders the three ways of arriving at zero as three different things', async () => {
        // The pair this suite shipped with — measured-zero vs never-drilled —
        // agreed that a drill ROW existed or did not, which is the question the
        // old `drills.length === 0` guard asked. Two cases that agree on the
        // predicate under test cannot detect it being the wrong predicate, and
        // that is exactly how the errored drill got through. So the assertion
        // is pairwise: all three renderings, compared to each other.
        const [proven, never, errored] = await Promise.all([
            buildIncidentHistoryReport(ctxFor(T2)), // drilled, measured 0
            buildIncidentHistoryReport(ctxFor(T3)), // never drilled
            buildIncidentHistoryReport(ctxFor(T4)), // drilled, every drill errored
        ]);
        type Incidents = Awaited<ReturnType<typeof buildIncidentHistoryReport>>;
        const claim = (r: Incidents): Measure | undefined =>
            r.metrics['incidents.tool_calls_after_kill'];

        expect(claim(proven)).toEqual({ state: 'MEASURED', value: 0, basis: null });
        expect(claim(never)).toEqual({
            state: 'NO_POPULATION',
            value: null,
            basis: 'NO_DRILLS_RUN',
        });
        expect(claim(errored)).toEqual({
            state: 'NOT_ASSESSED',
            value: null,
            basis: 'ALL_DRILLS_ERRORED',
        });

        // Three distinct renderings, stated as a count so a future collapse of
        // ANY pair fails here — including one this file forgot to name.
        const renderings = [claim(proven), claim(never), claim(errored)].map((c) =>
            JSON.stringify(c),
        );
        expect(new Set(renderings).size).toBe(3);
    });
});

describe('third-party agent assessments', () => {
    it('links T1’s third-party agents to their suppliers and the assurance held', async () => {
        const report = await buildThirdPartyAssessmentReport(ctxFor(T1));
        const m = report.metrics;

        // Fixture: A3 → V1 (APPROVED assessment), A5 → V2 (IN_PROGRESS only).
        expectMeasured(m['thirdparty.agents'], 2);
        expectMeasured(m['thirdparty.supplying_vendors'], 2);
        // Started is not finished: V2's IN_PROGRESS assessment is not assurance.
        expectMeasured(m['thirdparty.vendors_without_completed_assessment'], 1);

        const byName = new Map(report.body.agents.map((a) => [a.name, a]));
        expect(byName.get('Vendor bot')?.vendorName).toBe('Assessed supplier');
        expect(byName.get('Vendor bot')?.latestCompletedAssessment?.status).toBe('APPROVED');
        expect(byName.get('Vendor bot')?.latestCompletedAssessment?.riskRating).toBe('LOW');
        expect(byName.get('Vendor bot')?.openAssessments).toBe(0);

        expect(byName.get('Supplier agent')?.vendorName).toBe('Unassessed supplier');
        expect(byName.get('Supplier agent')?.latestCompletedAssessment).toBeNull();
        expect(byName.get('Supplier agent')?.openAssessments).toBe(1);
        expect(byName.get('Supplier agent')?.vendorUnresolved).toBe(false);
    });

    it('separates a human-approved tool definition from a trust-on-first-use one', async () => {
        const report = await buildThirdPartyAssessmentReport(ctxFor(T1));

        // Fixture: list_risks pinned BASELINE, list_controls pinned APPROVED.
        expectMeasured(report.metrics['thirdparty.tools_pinned'], 2);
        expectMeasured(report.metrics['thirdparty.tools_human_approved'], 1);

        const pinned = report.body.toolManifests.filter((t) => t.approvalSource !== null);
        expect(pinned.map((t) => t.toolName).sort()).toEqual(['list_controls', 'list_risks']);
        const approved = pinned.find((t) => t.approvalSource === 'APPROVED');
        expect(approved?.approvedByUserId).toBe(seeded[T1].ownerUserId);
        expect(approved?.revision).toBe(2);
    });

    it('names what it cannot see rather than deriving it from our own logs', async () => {
        const report = await buildThirdPartyAssessmentReport(ctxFor(T1));
        expectAbsent(
            report.metrics['thirdparty.supplier_side_agent_changes'],
            'NOT_OBSERVABLE',
            'OUTSIDE_PLATFORM_BOUNDARY',
        );
    });

    it('sees none of T1’s suppliers from T2', async () => {
        const report = await buildThirdPartyAssessmentReport(ctxFor(T2));

        // T2's only agent is FIRST_PARTY. A real, measured zero.
        expectMeasured(report.metrics['thirdparty.agents'], 0);
        // But there is no supplier population to count vendors over, so this
        // is NOT a zero — T1's two vendors must be invisible either way.
        expectAbsent(report.metrics['thirdparty.supplying_vendors'], 'NO_POPULATION', 'NO_AGENTS_IN_SCOPE');
        expectAbsent(
            report.metrics['thirdparty.vendors_without_completed_assessment'],
            'NO_POPULATION',
            'NO_SUPPLYING_VENDORS',
        );
        // T1's two pins must not appear here either.
        expectMeasured(report.metrics['thirdparty.tools_pinned'], 0);
        expectMeasured(report.metrics['thirdparty.tools_human_approved'], 0);
        expect(report.body.agents).toEqual([]);
    });
});

describe('the pack as one artefact', () => {
    it('stamps one tenant and one generation instant across all five reports', async () => {
        const pack = await buildAgentGovernancePack(ctxFor(T1));
        expect(pack.tenantId).toBe(T1);
        expect(pack.generatedAt).toBeInstanceOf(Date);
        expect(pack.inventory.reportId).toBe('agent-inventory');
        expect(pack.asiCoverage.reportId).toBe('asi-coverage');
        expect(pack.approvals.reportId).toBe('approval-statistics');
        expect(pack.incidents.reportId).toBe('incident-history');
        expect(pack.thirdParty.reportId).toBe('third-party-assessments');
    });

    it('agrees with itself about how many agents the tenant runs', async () => {
        const pack = await buildAgentGovernancePack(ctxFor(T1));
        // Two reports count agents from two different queries. A pack whose own
        // sections disagree about the denominator is the defect a governance
        // report exists to avoid.
        expect(pack.inventory.metrics['inventory.registered_agents']).toEqual(
            pack.asiCoverage.metrics['asi.agents_in_scope'],
        );
        expect(pack.inventory.metrics['inventory.third_party_agents']).toEqual(
            pack.thirdParty.metrics['thirdparty.agents'],
        );
    });

    it('and produces a wholly different pack for the second tenant', async () => {
        const one = await buildAgentGovernancePack(ctxFor(T1));
        const two = await buildAgentGovernancePack(ctxFor(T2));

        expect(two.tenantId).toBe(T2);
        expect(one.inventory.metrics['inventory.registered_agents']).not.toEqual(
            two.inventory.metrics['inventory.registered_agents'],
        );
        expect(one.approvals.metrics['approvals.decided']).not.toEqual(
            two.approvals.metrics['approvals.decided'],
        );
        expect(one.incidents.metrics['incidents.drills_run']).not.toEqual(
            two.incidents.metrics['incidents.drills_run'],
        );
    });
});
