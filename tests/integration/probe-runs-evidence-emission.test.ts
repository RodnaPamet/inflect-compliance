/**
 * A month of probe runs becomes evidence (active flavour, step 8c) — and a month
 * in which an agent was not shown to resist is never emitted as complete.
 *
 * Every run here goes through the real ingest (`ingestProbeReport`, signed by a
 * fake prober whose key the tenant registered, under a scope a registered
 * approver signed), and every artefact through the real emitter against a real
 * database. The owner's decisions of 2026-11-25 pinned here:
 *
 *   1. CONTROLS. ASI01, ASI02, ISO 27001 A.8.29 and SOC 2 CC4.1 — each resolved
 *      through a framework of its family, A.8.29 through the bare `8.29` an
 *      ISO catalogue numbers it with.
 *   2. STATUS IS COMPLETENESS. APPROVED only when every run in the month
 *      concluded, none was stopped, and every prober that held a key in the
 *      month sent a run; NEEDS_REVIEW otherwise, with the reason in the body.
 *      The emitter corrects in one direction: an unsafe approval is put back, a
 *      review decision stands.
 *   3. ZERO IS NEVER COMPLETE. A month with no run is NO PROBE RUN RECEIVED; a
 *      tenant that never registered a prober key gets no artefact.
 *   4. A MONTH IS NOT CLOSED BY ITS LAST TICK. A run backfilled into a closed
 *      month reaches its artefact through `reconcileClosedProbePeriods`.
 *   5. REDACTION. No endpoint, no excerpt, no tool name reaches Evidence — each
 *      planted as a canary in the report first.
 *
 * The probers' keys are backdated to before every month here, so the
 * silent-prober rule applies to the months the suite evidences.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import { acted, approverFingerprint, MCP, noReply, probesBody, resisted } from '../helpers/probe-fake-report';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { addAgentProberKey } from '@/app-layer/usecases/agent-prober-keys';
import { addProbeApproverKey } from '@/app-layer/usecases/probe-approver-keys';
import { ingestProbeReport } from '@/app-layer/usecases/probe-runs';
import { emitAgenticEvidence, reconcileClosedProbePeriods } from '@/app-layer/usecases/agentic-evidence-emission';
import { ARTEFACT_KIND_PROBE_RUNS, ASI_LIBRARY_URN } from '@/lib/agentic/evidence-artefact';
import { ISO27001_FAMILY_URN, SOC2_FAMILY_URN } from '@/app-layer/domain/framework-representation';
import { isCoverageQualifyingEvidence } from '@/lib/compliance/coverage-evidence';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(180_000);

const T = 'probe-evidence-tenant';
/** Holds the four controls and never registers a prober key. */
const T_NO_KEY = 'probe-evidence-no-key';
const ALL_TENANTS = [T, T_NO_KEY];

/** One framework per family, each under a key of this suite's own. */
const FRAMEWORKS = [
    { key: 'TEST-PROBE-EV-ASI', sourceUrn: ASI_LIBRARY_URN, codes: ['ASI01', 'ASI02'] },
    // The bare spelling: the target names `A.8.29`, an ISO catalogue numbers it `8.29`.
    { key: 'TEST-PROBE-EV-ISO', sourceUrn: ISO27001_FAMILY_URN, codes: ['8.29'] },
    { key: 'TEST-PROBE-EV-SOC2', sourceUrn: SOC2_FAMILY_URN, codes: ['CC4.1'] },
] as const;
const FRAMEWORK_KEYS = FRAMEWORKS.map((f) => f.key);

const AS_OF = new Date('2026-09-28T12:00:00.000Z');
const IN_MONTH = (day: number) => new Date(Date.UTC(2026, 8, day, 3, 0, 0)).toISOString();
const EMPTY_MONTH = new Date('2026-07-15T12:00:00.000Z');
const KEYS_REGISTERED = new Date('2026-06-01T00:00:00.000Z');

// Canaries — each reaches the stored run and must never reach Evidence.
const ENDPOINT_CANARY = 'https://probe-endpoint-canary-8c.example/support/chat';
const EXCERPT_CANARY = 'Excerpt canary 8c: the joined code is OKAPI-77.';
const TOOL_CANARY = 'tool_canary_8c_lookup';

const seeded: {
    ownerUserId: string;
    noKeyOwnerUserId: string;
    approver: FakeScanner;
    proberA: { agentId: string; prober: FakeScanner };
    proberB: { agentId: string; prober: FakeScanner };
    controls: Record<string, string>;
} = {} as never;

const ownerCtx = (): RequestContext =>
    makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: seeded.ownerUserId });
const noKeyCtx = (): RequestContext =>
    makeRequestContext('OWNER', { tenantId: T_NO_KEY, tenantSlug: T_NO_KEY, userId: seeded.noKeyOwnerUserId });

const emails = [`owner@${T}.test`, `owner@${T_NO_KEY}.test`];

async function clearEvidenceAndRuns(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.agenticEvidenceArtefact.deleteMany({ where: t });
    await prisma.evidenceControlLink.deleteMany({ where: t });
    await prisma.evidence.deleteMany({ where: t });
    await prisma.probeRunOutcome.deleteMany({ where: t });
    await prisma.probeRunTarget.deleteMany({ where: t });
    await prisma.probeRun.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await clearEvidenceAndRuns();
    await prisma.agentProberKey.deleteMany({ where: t });
    await prisma.probeApproverKey.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.controlRequirementLink.deleteMany({ where: t });
    await prisma.control.deleteMany({ where: t });
    await prisma.frameworkRequirement.deleteMany({ where: { framework: { key: { in: FRAMEWORK_KEYS } } } });
    await prisma.framework.deleteMany({ where: { key: { in: FRAMEWORK_KEYS } } });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({ where: { emailHash: { in: emails.map(hashForLookup) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

async function member(tenantId: string, email: string): Promise<string> {
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    return user.id;
}

async function installControls(): Promise<void> {
    const controls: Record<string, string> = {};
    for (const f of FRAMEWORKS) {
        const framework = await prisma.framework.create({
            data: { key: f.key, name: f.key, version: '1.0', kind: 'INDUSTRY_STANDARD', sourceUrn: f.sourceUrn },
        });
        for (const code of f.codes) {
            const requirement = await prisma.frameworkRequirement.create({
                data: { frameworkId: framework.id, code, title: `Requirement ${code}` },
            });
            for (const tenantId of ALL_TENANTS) {
                const control = await prisma.control.create({
                    data: { tenantId, code: `CTL-${code}`, name: `Control for ${code}`, status: 'IMPLEMENTED' },
                });
                await prisma.controlRequirementLink.create({
                    data: { tenantId, controlId: control.id, requirementId: requirement.id },
                });
                if (tenantId === T) controls[code] = control.id;
            }
        }
    }
    seeded.controls = controls;
}

async function keyedProber(name: string): Promise<{ agentId: string; prober: FakeScanner }> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId: T, name: `Host of ${name}`, ownerUserId: seeded.ownerUserId },
    });
    const agent = await createRegisteredAgent(ownerCtx(), {
        aiSystemId: aiSystem.id,
        name,
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: seeded.ownerUserId,
    });
    const prober = createFakeScanner();
    const key = await addAgentProberKey(ownerCtx(), { agentId: agent.id, publicKey: prober.publicKeyHex });
    await prisma.agentProberKey.update({ where: { id: key.id }, data: { createdAt: KEYS_REGISTERED } });
    return { agentId: agent.id, prober };
}

type Body = ReturnType<typeof probesBody>;
/** One run by prober A or B, resisted on a chat agent unless told otherwise. */
async function run(which: 'A' | 'B', startedAt: string, over: Partial<{ outcomes: Body['outcomes']; stopped: Body['run']['stopped'] }> = {}) {
    const p = which === 'A' ? seeded.proberA : seeded.proberB;
    const outcomes = over.outcomes ?? [resisted(ENDPOINT_CANARY)];
    const body = probesBody(approverFingerprint(seeded.approver.publicKeyHex), outcomes, {
        startedAt,
        stopped: over.stopped ?? null,
    });
    return ingestProbeReport(ownerCtx(), p.prober.serialise(body));
}

async function probeArtefacts(tenantId = T) {
    return prisma.agenticEvidenceArtefact.findMany({
        where: { tenantId, kind: ARTEFACT_KIND_PROBE_RUNS },
        orderBy: { controlId: 'asc' },
        select: {
            controlId: true,
            periodStart: true,
            recordCount: true,
            evidence: { select: { id: true, title: true, content: true, status: true, isArchived: true, deletedAt: true, expiredAt: true } },
        },
    });
}

async function statusChangesOf(evidenceId: string) {
    return prisma.auditLog.findMany({
        where: { tenantId: T, entity: 'Evidence', entityId: evidenceId, action: 'STATUS_CHANGE' },
        select: { detailsJson: true },
        orderBy: { createdAt: 'asc' },
    });
}

/** Run `fn` with prober B's key revoked as of `at`, restoring it after. */
async function withProberBRevokedAt<R>(at: Date, fn: () => Promise<R>): Promise<R> {
    const where = { tenantId: T, agentId: seeded.proberB.agentId };
    await prisma.agentProberKey.updateMany({ where, data: { revokedAt: at, revokedByUserId: seeded.ownerUserId } });
    try {
        return await fn();
    } finally {
        await prisma.agentProberKey.updateMany({ where, data: { revokedAt: null, revokedByUserId: null } });
    }
}

beforeAll(async () => {
    await clearOwnRows();
    for (const tenantId of ALL_TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    }
    seeded.ownerUserId = await member(T, emails[0]);
    seeded.noKeyOwnerUserId = await member(T_NO_KEY, emails[1]);
    await installControls();
    seeded.approver = createFakeScanner();
    await addProbeApproverKey(ownerCtx(), { label: 'Security lead', publicKey: seeded.approver.publicKeyHex });
    seeded.proberA = await keyedProber('Prober A');
    seeded.proberB = await keyedProber('Prober B');
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

beforeEach(clearEvidenceAndRuns);

describe('a month every prober tried, and every run concluded, is APPROVED on all four controls', () => {
    it('resolves ASI01, ASI02, ISO A.8.29 (numbered 8.29) and SOC 2 CC4.1, and counts toward each', async () => {
        await run('A', IN_MONTH(5), { outcomes: [acted(ENDPOINT_CANARY), resisted(ENDPOINT_CANARY, 'canary.role-swap.1')] });
        await run('B', IN_MONTH(6));
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });

        const rows = await probeArtefacts();
        expect(new Set(rows.map((r) => r.controlId))).toEqual(new Set(Object.values(seeded.controls)));
        for (const row of rows) {
            // An agent that ACTED is a finding, not a gap in the evidence.
            expect(row.evidence.status).toBe('APPROVED');
            expect(row.evidence.title).toMatch(/^Agent probe runs — 2026-09 — CTL-/);
            expect(row.evidence.title).not.toContain('INCOMPLETE');
            expect(row.evidence.content).toContain('Artefact completeness: COMPLETE');
            expect(row.evidence.content).toContain('acted 1');
            expect(row.recordCount).toBe(2);
            expect(isCoverageQualifyingEvidence(row.evidence)).toBe(true);
        }
    });
});

describe('a month in which an agent was not shown to resist is NEEDS_REVIEW, with the reason', () => {
    it('names a stopped run', async () => {
        await run('A', IN_MONTH(5), { stopped: 'STOPPED' });
        await run('B', IN_MONTH(6));
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        for (const row of await probeArtefacts()) {
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.title).toContain('— INCOMPLETE');
            expect(row.evidence.content).toContain('was stopped early (STOPPED)');
            expect(isCoverageQualifyingEvidence(row.evidence)).toBe(false);
        }
    });

    it('names a run that concluded nothing', async () => {
        await run('A', IN_MONTH(5), { outcomes: [noReply(ENDPOINT_CANARY)] });
        await run('B', IN_MONTH(6));
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        for (const row of await probeArtefacts()) {
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.content).toContain('concluded nothing: every outcome was inconclusive');
        }
    });

    it('names a prober that held a key in the month and sent no run', async () => {
        await run('A', IN_MONTH(5));
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        for (const row of await probeArtefacts()) {
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.content).toContain(`prober ${seeded.proberB.agentId} held a trusted key in the period but sent no run in it`);
        }
    });

    it('still counts a prober whose key was revoked DURING the month', async () => {
        await run('A', IN_MONTH(5));
        await withProberBRevokedAt(new Date(Date.UTC(2026, 8, 15)), () => emitAgenticEvidence(ownerCtx(), { asOf: AS_OF }));
        for (const row of await probeArtefacts()) expect(row.evidence.status).toBe('NEEDS_REVIEW');
    });

    it('does not count a prober whose key was revoked BEFORE the month began', async () => {
        await run('A', IN_MONTH(5));
        await withProberBRevokedAt(new Date(Date.UTC(2026, 7, 20)), () => emitAgenticEvidence(ownerCtx(), { asOf: AS_OF }));
        for (const row of await probeArtefacts()) {
            expect(row.evidence.status).toBe('APPROVED');
            expect(row.evidence.content).not.toContain(seeded.proberB.agentId);
        }
    });
});

describe('the emitter corrects a status in one direction', () => {
    it('puts a hand-approved incomplete month back, and audits the change', async () => {
        await run('A', IN_MONTH(5));
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const [row] = await probeArtefacts();
        expect(row.evidence.status).toBe('NEEDS_REVIEW');
        await prisma.evidence.update({ where: { id: row.evidence.id }, data: { status: 'APPROVED' } });

        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const after = await prisma.evidence.findUniqueOrThrow({ where: { id: row.evidence.id }, select: { status: true } });
        expect(after.status).toBe('NEEDS_REVIEW');
        const [audit] = await statusChangesOf(row.evidence.id);
        expect(audit.detailsJson).toMatchObject({ fromStatus: 'APPROVED', toStatus: 'NEEDS_REVIEW' });
    });

    it('leaves a REJECTED month rejected when its runs later complete', async () => {
        await run('A', IN_MONTH(5));
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const [row] = await probeArtefacts();
        await prisma.evidence.update({ where: { id: row.evidence.id }, data: { status: 'REJECTED' } });

        await run('B', IN_MONTH(6));
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });
        const after = await prisma.evidence.findUniqueOrThrow({ where: { id: row.evidence.id }, select: { status: true, content: true } });
        expect(after.status).toBe('REJECTED');
        expect(after.content).toContain('Artefact completeness: COMPLETE');
    });
});

describe('zero is never complete', () => {
    it('emits a month with no run as NO PROBE RUN RECEIVED', async () => {
        await emitAgenticEvidence(ownerCtx(), { asOf: EMPTY_MONTH });
        const rows = await probeArtefacts();
        expect(rows).toHaveLength(4);
        for (const row of rows) {
            expect(row.evidence.status).toBe('NEEDS_REVIEW');
            expect(row.evidence.title).toContain('NO PROBE RUN RECEIVED');
            expect(row.evidence.content).toContain('UNEVIDENCED for 2026-07');
        }
    });

    it('emits nothing for a tenant that has never registered a prober key', async () => {
        await emitAgenticEvidence(noKeyCtx(), { asOf: AS_OF });
        expect(await probeArtefacts(T_NO_KEY)).toEqual([]);
    });
});

describe('a month is not closed by its last tick', () => {
    it('re-emits a closed month a run was backfilled into, and approves it once complete', async () => {
        await emitAgenticEvidence(ownerCtx(), { asOf: EMPTY_MONTH });
        const july = await probeArtefacts();
        expect(july.every((r) => r.evidence.title.includes('NO PROBE RUN RECEIVED'))).toBe(true);

        const quiet = await reconcileClosedProbePeriods(ownerCtx(), { now: new Date('2026-09-02T06:30:00.000Z') });
        expect(quiet.periodLabels).toEqual(['2026-08']);

        await run('A', '2026-07-10T03:00:00.000Z');
        await run('B', '2026-07-11T03:00:00.000Z');
        const closed = await reconcileClosedProbePeriods(ownerCtx(), { now: new Date('2026-09-02T06:30:00.000Z') });
        expect(closed.periodLabels).toEqual(['2026-08', '2026-07']);
        const after = (await probeArtefacts()).filter((r) => r.periodStart.toISOString() === '2026-07-01T00:00:00.000Z');
        expect(after.map((r) => r.evidence.id).sort()).toEqual(july.map((r) => r.evidence.id).sort());
        for (const row of after) {
            expect(row.evidence.status).toBe('APPROVED');
            expect(row.evidence.content).toContain('Artefact completeness: COMPLETE');
        }
    });

    it('puts back an incomplete closed month approved by hand long after it closed', async () => {
        await emitAgenticEvidence(ownerCtx(), { asOf: EMPTY_MONTH });
        const [row] = await probeArtefacts();
        await prisma.evidence.update({ where: { id: row.evidence.id }, data: { status: 'APPROVED' } });

        const closed = await reconcileClosedProbePeriods(ownerCtx(), { now: new Date('2026-12-02T06:30:00.000Z') });
        expect(closed.demotedEvidenceIds).toEqual([row.evidence.id]);
        const after = await prisma.evidence.findUniqueOrThrow({ where: { id: row.evidence.id }, select: { status: true } });
        expect(after.status).toBe('NEEDS_REVIEW');
    });
});

describe('what a probe artefact must not contain', () => {
    it('carries no endpoint, excerpt or tool — and states the redaction contract', async () => {
        await run('A', IN_MONTH(5), {
            outcomes: [
                { ...acted(ENDPOINT_CANARY), excerpt: EXCERPT_CANARY },
                acted(MCP, 'canary.tool-call.1', TOOL_CANARY),
            ],
        });
        await run('B', IN_MONTH(6));
        // The canaries reached the stored run (encrypted), so their absence below is the redaction, not a missed write.
        expect(await prisma.probeRunOutcome.count({ where: { tenantId: T, tool: TOOL_CANARY } })).toBe(1);
        await emitAgenticEvidence(ownerCtx(), { asOf: AS_OF });

        const rows = await probeArtefacts();
        expect(rows).toHaveLength(4);
        for (const row of rows) {
            const text = `${row.evidence.title}\n${row.evidence.content}`;
            for (const canary of [ENDPOINT_CANARY, 'probe-endpoint-canary-8c', EXCERPT_CANARY, 'OKAPI-77', MCP, 'mcp.acme.example', TOOL_CANARY]) {
                expect(text).not.toContain(canary);
            }
            expect(row.evidence.content).toContain('REDACTION CONTRACT');
        }
    });
});
