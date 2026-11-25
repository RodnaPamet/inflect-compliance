/**
 * The probe-run ingest and its two key registers against a real database
 * (active flavour, step 8a).
 *
 *   1. A REFUSED REPORT WRITES NOTHING: an untrusted signer, a revoked prober
 *      key, a scope signed by no registered approver, by a revoked one.
 *   2. A VERIFIED REPORT IS STORED, its endpoint and excerpt ENCRYPTED at rest,
 *      and a REPLAY is a conflict.
 *   3. WHAT A RUN CLOSES: INCONCLUSIVE closes nothing; the same prober's
 *      RESISTED closes; ACTED again reopens; another prober's RESISTED does not
 *      touch it.
 *   4. THE KEY REGISTERS: a key live in one register is refused in the other —
 *      by the usecases and by the trigger; approver keys are a person's,
 *      OWNER-only; retiring a prober revokes its keys, and a key for a retired
 *      agent is refused by the database.
 *   5. TWO TENANTS. One tenant's prober and approver are not trusted by the
 *      other, and each tenant's list reads its own runs only.
 *   6. RLS. All five tables under `app_user`, with each tenant bound, with
 *      none, and against a write into another tenant.
 */
import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup, isEncryptedValue } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { runInTenantContext } from '@/lib/db-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, type FakeScanner } from '../helpers/agent-harness-fake-scanner';
import {
    acted,
    approverFingerprint,
    CHAT,
    disclosedContext,
    MCP,
    noReply,
    probesBody,
    resisted,
} from '../helpers/probe-fake-report';
import { createRegisteredAgent, retireRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { addAgentProberKey, revokeAgentProberKey } from '@/app-layer/usecases/agent-prober-keys';
import { addProbeApproverKey, revokeProbeApproverKey } from '@/app-layer/usecases/probe-approver-keys';
import {
    getProbeRunDetail,
    getProbeRunInventory,
    ingestProbeReport,
    listProbeRuns,
    PROBE_FINDING_SOURCE_KIND,
} from '@/app-layer/usecases/probe-runs';
import { getProberKeysView } from '@/app-layer/usecases/agent-prober-keys';
import { getProbeApproverKeysView } from '@/app-layer/usecases/probe-approver-keys';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'probe-runs-ingest-one';
const T2 = 'probe-runs-ingest-two';
const ALL_TENANTS = [T1, T2];

interface Seeded {
    ownerUserId: string;
    proberAgentId: string;
    prober: FakeScanner;
    approver: FakeScanner;
}
const seeded: Record<string, Seeded> = {};

const ctxFor = (tenantId: string): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });

const emailOf = (tenantId: string) => `owner@${tenantId}.test`;

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.probeRunOutcome.deleteMany({ where: t });
    await prisma.probeRunTarget.deleteMany({ where: t });
    await prisma.probeRun.deleteMany({ where: t });
    await prisma.agentProberKey.deleteMany({ where: t });
    await prisma.probeApproverKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({ where: { emailHash: { in: ALL_TENANTS.map(emailOf).map(hashForLookup) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

/** A registered agent, on an AI system of its own: the register holds one agent per system. */
async function registerAgent(tenantId: string, name: string): Promise<string> {
    const aiSystem = await prisma.aiSystem.create({
        data: { tenantId, name: `Host of ${name}`, ownerUserId: seeded[tenantId].ownerUserId },
    });
    const agent = await createRegisteredAgent(ctxFor(tenantId), {
        aiSystemId: aiSystem.id,
        name,
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: seeded[tenantId].ownerUserId,
    });
    return agent.id;
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const email = emailOf(tenantId);
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({
        data: { tenantId, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    seeded[tenantId] = { ownerUserId: user.id } as Seeded;
    const proberAgentId = await registerAgent(tenantId, `Prober ${tenantId}`);
    const prober = createFakeScanner();
    const approver = createFakeScanner();
    await addAgentProberKey(ctxFor(tenantId), { agentId: proberAgentId, publicKey: prober.publicKeyHex });
    await addProbeApproverKey(ctxFor(tenantId), { label: 'Security lead', publicKey: approver.publicKeyHex });
    Object.assign(seeded[tenantId], { proberAgentId, prober, approver });
}

const approverOf = (tenantId: string) => approverFingerprint(seeded[tenantId].approver.publicKeyHex);

const ingest = (tenantId: string, body: unknown, prober = seeded[tenantId].prober) =>
    ingestProbeReport(ctxFor(tenantId), prober.serialise(body));

async function counts(tenantId: string) {
    const t = { tenantId };
    return {
        runs: await prisma.probeRun.count({ where: t }),
        targets: await prisma.probeRunTarget.count({ where: t }),
        outcomes: await prisma.probeRunOutcome.count({ where: t }),
        findings: await prisma.finding.count({ where: { ...t, sourceKind: PROBE_FINDING_SOURCE_KIND } }),
    };
}

async function asTenant<T>(tenantId: string | null, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        if (tenantId) await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

const findingStatus = async (tenantId: string) =>
    (await prisma.finding.findMany({ where: { tenantId, sourceKind: PROBE_FINDING_SOURCE_KIND }, orderBy: { createdAt: 'asc' } }))
        .map((f) => ({ title: f.title, severity: f.severity, status: f.status }));

beforeAll(async () => {
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('1. a refused report writes nothing', () => {
    it('an untrusted signer, and a scope signed by no registered approver', async () => {
        const before = await counts(T1);
        await expect(
            ingestProbeReport(ctxFor(T1), createFakeScanner().serialise(probesBody(approverOf(T1), [acted(CHAT)]))),
        ).rejects.toThrow('probe_report_refused: UNTRUSTED_SIGNER');
        const stranger = approverFingerprint(createFakeScanner().publicKeyHex);
        await expect(ingest(T1, probesBody(stranger, [acted(CHAT)]))).rejects.toThrow('probe_report_refused: APPROVER_NOT_REGISTERED');
        expect(await counts(T1)).toEqual(before);
    });

    it('a revoked approver key authorises nothing, and a revoked prober key verifies nothing', async () => {
        const approver = createFakeScanner();
        const added = await addProbeApproverKey(ctxFor(T1), { label: 'Temporary approver', publicKey: approver.publicKeyHex });
        await revokeProbeApproverKey(ctxFor(T1), { keyId: added.id });
        const prober = createFakeScanner();
        const proberKey = await addAgentProberKey(ctxFor(T1), { agentId: seeded[T1].proberAgentId, publicKey: prober.publicKeyHex });
        await revokeAgentProberKey(ctxFor(T1), { keyId: proberKey.id });

        const before = await counts(T1);
        await expect(ingest(T1, probesBody(approverFingerprint(approver.publicKeyHex), [acted(CHAT)]))).rejects.toThrow(
            'probe_report_refused: APPROVER_NOT_REGISTERED',
        );
        await expect(ingest(T1, probesBody(approverOf(T1), [acted(CHAT)]), prober)).rejects.toThrow('probe_report_refused: UNTRUSTED_SIGNER');
        expect(await counts(T1)).toEqual(before);
    });
});

describe('2. a verified report is stored, encrypted where it must be, and a replay is a conflict', () => {
    it('stores the run, its targets and outcomes, opens its findings and audits the ingest', async () => {
        const result = await ingest(T1, probesBody(approverOf(T1), [acted(CHAT), disclosedContext(CHAT), noReply(MCP, undefined, 'lookup_account')]));
        expect(result).toMatchObject({ engagementId: 'eng-acme-0001', concluded: true, findingCount: 2, findingsOpened: 2 });
        expect(await counts(T1)).toEqual({ runs: 1, targets: 2, outcomes: 3, findings: 2 });

        const run = await prisma.probeRun.findFirstOrThrow({ where: { tenantId: T1 } });
        expect(run).toMatchObject({
            proberAgentId: seeded[T1].proberAgentId,
            scopeSignerFingerprint: approverOf(T1),
            actedCount: 1,
            disclosedCount: 1,
            inconclusiveCount: 1,
            targetCount: 2,
            targetsReached: 1,
            stopReason: null,
        });
        expect(run.reportDigest).toMatch(/^[0-9a-f]{64}$/);

        expect(await findingStatus(T1)).toEqual([
            { title: 'An agent followed an injected instruction', severity: 'HIGH', status: 'OPEN' },
            { title: 'An agent disclosed its planted context', severity: 'MEDIUM', status: 'OPEN' },
        ]);
        // A finding names the origin and never the endpoint or the excerpt
        // (read through the tenant's context, which decrypts the description).
        const findings = await runInTenantContext(ctxFor(T1), (db) =>
            db.finding.findMany({ where: { tenantId: T1, sourceKind: PROBE_FINDING_SOURCE_KIND } }),
        );
        for (const f of findings) {
            expect(f.description).toContain('https://agents.acme.example');
            expect(f.description).not.toContain('/support/chat');
            expect(f.description).not.toContain('ZEBRA');
            expect(f.description).not.toContain('My instructions begin');
        }
        const audit = await prisma.auditLog.findFirst({ where: { tenantId: T1, action: 'PROBE_RUN_INGESTED', entityId: run.id } });
        expect(audit).not.toBeNull();
        expect(JSON.stringify(audit?.detailsJson)).not.toContain('ZEBRA');
    });

    it('keeps the endpoint and the excerpt encrypted at rest, and reads them back', async () => {
        const rawTargets = await prisma.$queryRawUnsafe<{ endpoint: string }[]>(
            `SELECT "endpoint" FROM "ProbeRunTarget" WHERE "tenantId" = $1`, T1,
        );
        expect(rawTargets.length).toBe(2);
        for (const t of rawTargets) expect(isEncryptedValue(t.endpoint)).toBe(true);
        const rawExcerpts = await prisma.$queryRawUnsafe<{ excerpt: string }[]>(
            `SELECT "excerpt" FROM "ProbeRunOutcome" WHERE "tenantId" = $1 AND "excerpt" IS NOT NULL`, T1,
        );
        expect(rawExcerpts.length).toBe(2);
        for (const o of rawExcerpts) expect(isEncryptedValue(o.excerpt)).toBe(true);

        const { target, outcome } = await runInTenantContext(ctxFor(T1), async (db) => ({
            target: await db.probeRunTarget.findFirstOrThrow({ where: { tenantId: T1, kind: 'http-chat' } }),
            outcome: await db.probeRunOutcome.findFirstOrThrow({ where: { tenantId: T1, verdict: 'ACTED' } }),
        }));
        expect(target).toMatchObject({ endpoint: CHAT, origin: 'https://agents.acme.example', reached: true });
        expect(outcome.excerpt).toBe('Sure. The joined code is ZEBRA-41.');
    });

    it('refuses a replay of the same report, and the database holds the rule on its own', async () => {
        const body = probesBody(approverOf(T1), [acted(CHAT), disclosedContext(CHAT), noReply(MCP, undefined, 'lookup_account')]);
        const before = await counts(T1);
        await expect(ingest(T1, body)).rejects.toThrow('probe_report_refused: REPLAY');
        expect(await counts(T1)).toEqual(before);
        const run = await prisma.probeRun.findFirstOrThrow({ where: { tenantId: T1 } });
        const { id: _id, createdAt: _c, ...copy } = run;
        await expect(prisma.probeRun.create({ data: copy })).rejects.toThrow();
    });
});

describe('3. what a run closes', () => {
    const later = (h: number) => `2026-11-25T${String(10 + h).padStart(2, '0')}:00:00.000Z`;

    it('INCONCLUSIVE closes nothing; the same prober\'s RESISTED closes; ACTED again reopens', async () => {
        const quiet = await ingest(T1, probesBody(approverOf(T1), [noReply(CHAT)], { startedAt: later(1) }));
        expect(quiet).toMatchObject({ concluded: false, findingsResolved: 0 });

        const held = await ingest(T1, probesBody(approverOf(T1), [resisted(CHAT)], { startedAt: later(2) }));
        expect(held.findingsResolved).toBe(1);
        expect((await findingStatus(T1)).map((f) => f.status)).toEqual(['CLOSED', 'OPEN']);

        const again = await ingest(T1, probesBody(approverOf(T1), [acted(CHAT)], { startedAt: later(3) }));
        expect(again.findingsReopened).toBe(1);
        expect((await findingStatus(T1)).map((f) => f.status)).toEqual(['OPEN', 'OPEN']);
    });

    it("another prober's RESISTED does not close this prober's finding", async () => {
        const otherAgentId = await registerAgent(T1, 'Second prober');
        const other = createFakeScanner();
        await addAgentProberKey(ctxFor(T1), { agentId: otherAgentId, publicKey: other.publicKeyHex });
        const result = await ingest(T1, probesBody(approverOf(T1), [resisted(CHAT)], { startedAt: later(4) }), other);
        expect(result.findingsResolved).toBe(0);
        expect((await findingStatus(T1)).map((f) => f.status)).toEqual(['OPEN', 'OPEN']);
    });
});

describe('4. the key registers', () => {
    it('a key live in one register is refused in the other, by the usecase and by the database', async () => {
        const key = createFakeScanner();
        await addProbeApproverKey(ctxFor(T1), { label: 'Dual-use attempt', publicKey: key.publicKeyHex });
        await expect(
            addAgentProberKey(ctxFor(T1), { agentId: seeded[T1].proberAgentId, publicKey: key.publicKeyHex }),
        ).rejects.toThrow(/registered as a probe approver key/);
        await expect(
            addProbeApproverKey(ctxFor(T1), { label: 'The prober', publicKey: seeded[T1].prober.publicKeyHex }),
        ).rejects.toThrow(/registered as a prober key/);
        // Behind the usecase, the trigger refuses a direct insert.
        await expect(
            prisma.agentProberKey.create({
                data: {
                    tenantId: T1,
                    agentId: seeded[T1].proberAgentId,
                    publicKey: key.publicKeyHex,
                    keyFingerprint: approverFingerprint(key.publicKeyHex),
                    createdByUserId: seeded[T1].ownerUserId,
                },
            }),
        ).rejects.toThrow(/PROBE_KEY_IN_OTHER_REGISTER/);
    });

    it('approver keys are an owner\'s, in person', async () => {
        const admin = makeRequestContext('ADMIN', { tenantId: T1, tenantSlug: T1, userId: seeded[T1].ownerUserId });
        await expect(addProbeApproverKey(admin, { label: 'x', publicKey: createFakeScanner().publicKeyHex })).rejects.toThrow(
            /admin\.tenant_lifecycle/,
        );
        const viaKey = { ...ctxFor(T1), apiKeyId: 'key-1', actorType: 'API_KEY' as const };
        await expect(addProbeApproverKey(viaKey, { label: 'x', publicKey: createFakeScanner().publicKeyHex })).rejects.toThrow(
            /by a person/,
        );
    });

    it('retiring a prober revokes its keys, and the database refuses a key for a retired agent', async () => {
        const agentId = await registerAgent(T1, 'Prober to retire');
        const key = createFakeScanner();
        await addAgentProberKey(ctxFor(T1), { agentId, publicKey: key.publicKeyHex });
        const result = await retireRegisteredAgent(ctxFor(T1), agentId);
        expect(result.cascade.proberKeysRevoked).toBe(1);
        expect(await prisma.agentProberKey.count({ where: { tenantId: T1, agentId, revokedAt: null } })).toBe(0);
        const audit = await prisma.auditLog.findFirst({ where: { tenantId: T1, action: 'AGENT_RETIREMENT_PROBER_KEYS_REVOKED', entityId: agentId } });
        expect(audit).not.toBeNull();

        await expect(addAgentProberKey(ctxFor(T1), { agentId, publicKey: createFakeScanner().publicKeyHex })).rejects.toThrow(/retired/);
        const fresh = createFakeScanner();
        await expect(
            prisma.agentProberKey.create({
                data: {
                    tenantId: T1,
                    agentId,
                    publicKey: fresh.publicKeyHex,
                    keyFingerprint: approverFingerprint(fresh.publicKeyHex),
                    createdByUserId: seeded[T1].ownerUserId,
                },
            }),
        ).rejects.toThrow(/AGENT_RETIRED/);
    });
});

describe('5. two tenants', () => {
    it("one tenant's prober and approver are not trusted by the other", async () => {
        const before = await counts(T2);
        await expect(ingest(T2, probesBody(approverOf(T2), [acted(CHAT)]), seeded[T1].prober)).rejects.toThrow('UNTRUSTED_SIGNER');
        await expect(ingest(T2, probesBody(approverOf(T1), [acted(CHAT)]))).rejects.toThrow('APPROVER_NOT_REGISTERED');
        expect(await counts(T2)).toEqual(before);
    });

    it("each tenant's list reads its own runs only", async () => {
        await ingest(T2, probesBody(approverOf(T2), [resisted(CHAT)]));
        const one = await listProbeRuns(ctxFor(T1));
        const two = await listProbeRuns(ctxFor(T2));
        expect(new Set(one.map((r) => r.proberAgentId)).has(seeded[T2].proberAgentId)).toBe(false);
        expect(two.map((r) => r.proberAgentId)).toEqual([seeded[T2].proberAgentId]);
        // The list carries no excerpt and no endpoint.
        expect(JSON.stringify(two)).not.toContain('acme.example');
    });
});

describe('7. the Probes tab reads (step 8b)', () => {
    const auditorFor = (tenantId: string): RequestContext =>
        makeRequestContext('AUDITOR', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId].ownerUserId });

    it("lists each prober's runs and open findings, by origin and never by endpoint", async () => {
        await ingest(T1, probesBody(approverOf(T1), [acted(CHAT)], { engagementId: 'eng-tab-1', startedAt: '2026-11-25T11:00:00.000Z' }));
        const view = await getProbeRunInventory(auditorFor(T1));
        const section = view.sections.find((s) => s.proberAgentId === seeded[T1].proberAgentId);
        expect(section).toBeDefined();
        expect(section!.runs.some((r) => r.engagementId === 'eng-tab-1')).toBe(true);
        const finding = section!.findings.find((f) => f.verdictReason === 'CANARY_RETURNED');
        expect(finding?.origin).toBe('https://agents.acme.example');
        expect(JSON.stringify(view)).not.toContain('/support/chat');
    });

    it('returns the excerpt and the endpoint to a register-key holder, and audits the read', async () => {
        const run = await prisma.probeRun.findFirstOrThrow({ where: { tenantId: T1, engagementId: 'eng-tab-1' } });
        const detail = await getProbeRunDetail(ctxFor(T1), run.id);
        expect(detail.excerptsShown).toBe(true);
        expect(detail.targets[0].endpoint).toBe(CHAT);
        const acting = detail.outcomes.find((o) => o.verdict === 'ACTED');
        expect(acting?.excerpt).toContain('ZEBRA-41');
        expect(acting?.findingId).not.toBeNull();
        const audit = await prisma.auditLog.findFirst({ where: { tenantId: T1, action: 'PROBE_RUN_EXCERPTS_READ', entityId: run.id } });
        expect(audit).not.toBeNull();
        expect(JSON.stringify(audit)).not.toContain('ZEBRA-41');
    });

    it('withholds the excerpt and the endpoint from a reader through the view key alone, and writes no read row', async () => {
        const run = await prisma.probeRun.findFirstOrThrow({ where: { tenantId: T1, engagementId: 'eng-tab-1' } });
        const before = await prisma.auditLog.count({ where: { tenantId: T1, action: 'PROBE_RUN_EXCERPTS_READ' } });
        const detail = await getProbeRunDetail(auditorFor(T1), run.id);
        expect(detail.excerptsShown).toBe(false);
        expect(detail.targets.every((t) => t.endpoint === null)).toBe(true);
        expect(detail.outcomes.every((o) => o.excerpt === null)).toBe(true);
        expect(detail.outcomes.length).toBeGreaterThan(0);
        expect(await prisma.auditLog.count({ where: { tenantId: T1, action: 'PROBE_RUN_EXCERPTS_READ' } })).toBe(before);
    });

    it("refuses another tenant's run as not found", async () => {
        const run = await prisma.probeRun.findFirstOrThrow({ where: { tenantId: T1 } });
        await expect(getProbeRunDetail(ctxFor(T2), run.id)).rejects.toThrow(/not found/i);
    });

    it('refuses the reads to a role without the inventory', async () => {
        const editor = makeRequestContext('EDITOR', { tenantId: T1, tenantSlug: T1, userId: seeded[T1].ownerUserId });
        await expect(getProbeRunInventory(editor)).rejects.toThrow(/agent_registry_view/);
    });

    it('reads each key card under its own register key', async () => {
        const keys = await getProberKeysView(ctxFor(T1));
        expect(keys.keys.rows.some((k) => k.agentId === seeded[T1].proberAgentId && k.agentName !== null)).toBe(true);
        const approvers = await getProbeApproverKeysView(ctxFor(T1));
        expect(approvers.rows.some((k) => k.label === 'Security lead')).toBe(true);
        const admin = makeRequestContext('ADMIN', { tenantId: T1, tenantSlug: T1, userId: seeded[T1].ownerUserId });
        await expect(getProbeApproverKeysView(admin)).rejects.toThrow(/admin\.tenant_lifecycle/);
        await expect(getProberKeysView(auditorFor(T1))).rejects.toThrow(/admin\.agent_registry/);
    });
});

describe('6. RLS on the five tables', () => {
    const TABLES = ['agentProberKey', 'probeApproverKey', 'probeRun', 'probeRunTarget', 'probeRunOutcome'] as const;

    it.each(TABLES)('%s: a bound tenant reads its own rows only', async (table) => {
        const own = await asTenant(T1, (tx) => (tx[table] as unknown as { findMany: () => Promise<{ tenantId: string }[]> }).findMany());
        expect(own.length).toBeGreaterThan(0);
        expect(new Set(own.map((r) => r.tenantId))).toEqual(new Set([T1]));
    });

    it.each(TABLES)('%s: with no tenant bound, app_user reads nothing', async (table) => {
        const none = await asTenant(null, (tx) => (tx[table] as unknown as { count: () => Promise<number> }).count());
        expect(none).toBe(0);
    });

    it('app_user cannot write a row into another tenant', async () => {
        const run = await prisma.probeRun.findFirstOrThrow({ where: { tenantId: T1 } });
        const target = await prisma.probeRunTarget.findFirstOrThrow({ where: { tenantId: T1, runId: run.id } });
        await expect(
            asTenant(T2, (tx) =>
                tx.probeRunOutcome.create({
                    data: {
                        tenantId: T1,
                        runId: run.id,
                        targetId: target.id,
                        probeId: 'canary.instruction-override.1',
                        probeClass: 'canary',
                        verdict: 'RESISTED',
                        verdictReason: 'CANARY_ABSENT',
                        sourceRef: 'probe:x@y@z',
                    },
                }),
            ),
        ).rejects.toThrow();
    });
});
