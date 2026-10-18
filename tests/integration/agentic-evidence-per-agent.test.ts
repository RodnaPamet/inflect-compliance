/**
 * PER-AGENT EVIDENCE THAT RETIRING AN AGENT WITHDRAWS (#3700), proved on rows.
 *
 * Every artefact before #3700 described the whole tenant's month, so retiring
 * one agent could withdraw none of them. Two per-agent kinds now cut the same
 * month's receipts and decision records by the agent each is attributed to, on
 * the same controls, and retirement withdraws them for the periods still open.
 * What this suite asserts, each against a real database because each is a
 * claim about a unique index, a CHECK, a trigger or a row lock:
 *
 *   1. COUNTING. A per-agent artefact counts only its agent's records — a
 *      receipt by the credential that submitted it, a decision by the agent
 *      stamped on it — and two agents in one tenant get separate rows. A record
 *      attributed to nobody, and a receipt whose pipelock `agent_id` CLAIMS an
 *      agent, are in the tenant-wide artefact only.
 *   2. RETIREMENT withdraws the agent's OPEN-period per-agent artefacts with
 *      `AGENT_RETIRED`, archives their Evidence with a notice, and deletes
 *      nothing. Its closed periods keep their evidence; the other agent and
 *      every tenant-wide artefact are untouched, to the `updatedAt`.
 *   3. NO RESURRECTION. A second tick — even with new records attributed to the
 *      retired agent — re-emits nothing for it as CURRENT, and an emitter tick
 *      that planned before a retirement and writes after it is refused.
 *   4. THE SHAPE IS HELD BY THE DATABASE: the identity is unique with NULL
 *      agents not distinct, the kind and the agent are paired, AGENT_RETIRED is
 *      a per-agent reason only, a retired agent's artefact cannot be written
 *      CURRENT by anyone, and a decision cannot be re-attributed.
 */
import { randomBytes, randomUUID, type KeyObject, generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const mockKey: { value?: string } = {};
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env');
    return {
        ...actual,
        env: new Proxy(actual.env as Record<string, unknown>, {
            get: (target, prop) =>
                prop === 'PIPELOCK_PUBLIC_KEY' ? mockKey.value : Reflect.get(target, prop),
        }),
    };
});

import { receiptSignedMessage } from '@/lib/mcp/receipt-verification';
import { ingestReceipt } from '@/app-layer/usecases/agent-action-receipt';
import { logAiDecision } from '@/app-layer/ai/decision-log';
import {
    emitAgenticEvidence,
    withdrawStaleAgenticEvidence,
} from '@/app-layer/usecases/agentic-evidence-emission';
import { retireRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import {
    ARTEFACT_KIND_DECISIONS,
    ARTEFACT_KIND_DECISIONS_PER_AGENT,
    ARTEFACT_KIND_RECEIPTS,
    ARTEFACT_KIND_RECEIPTS_PER_AGENT,
    ASI_LIBRARY_URN,
    EU_AI_ACT_LIBRARY_URN,
    monthlyPeriod,
    sourcePopulationDigest,
} from '@/lib/agentic/evidence-artefact';
import { runInTenantContext } from '@/lib/db-context';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T = 'agentic-evidence-per-agent';
const FW_ASI = 'TEST-PER-AGENT-ASI';
const FW_EU = 'TEST-PER-AGENT-EU-AI-ACT';
const CODES = ['ASI02', 'ASI04', 'ASI09', 'Art.12'] as const;
const LOCK_WAIT_PROBE_MS = 750;

let ownerUserId = '';
let privateKey: KeyObject;
const controls: Record<string, string> = {};
let seq = 0;

/** The month containing "now" — OPEN, so a retirement in this test withdraws it. */
const OPEN = () => monthlyPeriod(new Date());
/** The month before it — CLOSED, so a retirement keeps it. */
const CLOSED = () => monthlyPeriod(new Date(OPEN().start.getTime() - 1));
/** An instant inside the open month, never in the future. */
const inOpenMonth = () => new Date(Math.max(OPEN().start.getTime(), Date.now() - 60_000));
const inClosedMonth = () => new Date(CLOSED().start.getTime() + 3 * 24 * 60 * 60 * 1000);

const ownerCtx = (): RequestContext =>
    makeRequestContext('OWNER', { tenantId: T, tenantSlug: T, userId: ownerUserId });
/** The context a request authenticated by `keyId` resolves to — the agent its binding names. */
const keyCtx = (keyId: string, agentId: string | null): RequestContext =>
    makeRequestContext('OWNER', {
        tenantId: T,
        tenantSlug: T,
        userId: ownerUserId,
        apiKeyId: keyId,
        ...(agentId ? { agentId } : {}),
    });

async function asTenant<R>(fn: (tx: PrismaClient) => Promise<R>): Promise<R> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${T}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

function signedReceipt(record: Record<string, unknown>) {
    const sig = cryptoSign(null, receiptSignedMessage(record), privateKey);
    return { action_record: record, signature: `ed25519:${sig.toString('hex')}`, signer_key: mockKey.value as string };
}

/** One verified receipt, submitted with `keyId`, at `at`. */
async function receipt(keyId: string, agentId: string | null, at: Date, extra: Record<string, unknown> = {}) {
    const record = { tool: 'list_risks', verdict: 'allow', policy: 'default', timestamp: at.toISOString(), ...extra };
    const out = await ingestReceipt(keyCtx(keyId, agentId), signedReceipt(record));
    expect(out.verified).toBe(true);
    return out.id;
}

/** One decision record written by a request speaking for `agentId` (or for nobody). */
async function decision(agentId: string | null, keyId: string | null): Promise<string> {
    const ctx = keyId ? keyCtx(keyId, agentId) : ownerCtx();
    seq += 1;
    return runInTenantContext(ctx, (db) =>
        logAiDecision(db, ctx, {
            feature: 'agent-proposal',
            provider: 'mcp-agent',
            sanitizedInput: { n: seq },
            guardVerdict: 'PASS',
        }),
    );
}

async function makeAgent(name: string) {
    seq += 1;
    const sys = await prisma.aiSystem.create({ data: { tenantId: T, name: `${name} host ${seq}`, ownerUserId } });
    return prisma.registeredAgent.create({
        data: {
            tenantId: T,
            aiSystemId: sys.id,
            name: `${name} ${seq}`,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
}

async function makeKey(agentId: string | null) {
    return prisma.tenantApiKey.create({
        data: {
            tenantId: T,
            name: `per-agent evidence ${agentId ?? 'unbound'}`,
            keyPrefix: 'iflk_pa',
            keyHash: `per-agent-evidence-${randomBytes(12).toString('hex')}`,
            createdById: ownerUserId,
            agentId,
        },
    });
}

/** Two agents with a key each, and a key bound to nobody. */
async function twoAgents() {
    const a = await makeAgent('agent A');
    const b = await makeAgent('agent B');
    return { a, b, keyA: await makeKey(a.id), keyB: await makeKey(b.id), unbound: await makeKey(null) };
}

const artefactRows = () =>
    prisma.agenticEvidenceArtefact.findMany({
        where: { tenantId: T },
        orderBy: [{ kind: 'asc' }, { periodStart: 'asc' }, { agentId: 'asc' }, { controlId: 'asc' }],
        select: {
            id: true,
            kind: true,
            agentId: true,
            controlId: true,
            periodStart: true,
            periodEnd: true,
            recordCount: true,
            sourceDigest: true,
            status: true,
            withdrawnReason: true,
            withdrawnAt: true,
            updatedAt: true,
            evidenceId: true,
            evidence: { select: { content: true, title: true, isArchived: true, status: true } },
        },
    });
type Row = Awaited<ReturnType<typeof artefactRows>>[number];
const ofKind = (rows: Row[], kind: string, agentId: string | null = null) =>
    rows.filter((r) => r.kind === kind && r.agentId === agentId);

async function installFrameworks(): Promise<void> {
    const asi = await prisma.framework.create({
        data: { key: FW_ASI, name: 'OWASP Agentic AI Top 10', version: '1.0', kind: 'INDUSTRY_STANDARD', sourceUrn: ASI_LIBRARY_URN },
    });
    const eu = await prisma.framework.create({
        data: { key: FW_EU, name: 'EU AI Act', version: '2024', kind: 'REGULATION', sourceUrn: EU_AI_ACT_LIBRARY_URN },
    });
    for (const code of CODES) {
        const requirement = await prisma.frameworkRequirement.create({
            data: { frameworkId: code === 'Art.12' ? eu.id : asi.id, code, title: code },
        });
        const control = await prisma.control.create({
            data: { tenantId: T, code: `PA-${code}`, name: `Control for ${code}`, status: 'IMPLEMENTED' },
        });
        await prisma.controlRequirementLink.create({
            data: { tenantId: T, controlId: control.id, requirementId: requirement.id },
        });
        controls[code] = control.id;
    }
}

async function clearRecords(): Promise<void> {
    const t = { tenantId: T };
    // Artefacts cascade from their Evidence; agents only after their keys.
    await prisma.agenticEvidenceArtefact.deleteMany({ where: t });
    await prisma.evidenceControlLink.deleteMany({ where: t });
    await prisma.evidence.deleteMany({ where: t });
    await prisma.agentActionReceipt.deleteMany({ where: t });
    await prisma.aiDecisionLog.deleteMany({ where: t });
    await prisma.tenantApiKey.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
}

async function clearOwnRows(): Promise<void> {
    await clearRecords();
    await prisma.controlRequirementLink.deleteMany({ where: { tenantId: T } });
    await prisma.control.deleteMany({ where: { tenantId: T } });
    await prisma.frameworkRequirement.deleteMany({ where: { framework: { key: { in: [FW_ASI, FW_EU] } } } });
    await prisma.framework.deleteMany({ where: { key: { in: [FW_ASI, FW_EU] } } });
    await deleteAuditRowsForTenants(prisma, T);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, T);
    });
    await prisma.user.deleteMany({ where: { emailHash: hashForLookup(`owner@${T}.test`) } });
    await prisma.tenant.deleteMany({ where: { id: T } });
}

beforeAll(async () => {
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    mockKey.value = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');

    await resetDatabase(prisma);
    await clearOwnRows();
    await prisma.tenant.create({ data: { id: T, name: 'Per-agent evidence', slug: T } });
    const email = `owner@${T}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    ownerUserId = user.id;
    await prisma.tenantMembership.create({
        data: { tenantId: T, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
    });
    await installFrameworks();
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

beforeEach(clearRecords);

// ─── 1. Counting ─────────────────────────────────────────────────────────────

describe('a per-agent artefact counts only its agent\'s records', () => {
    it('cuts receipts by the submitting credential and decisions by the stamped agent, one row per agent', async () => {
        const { a, b, keyA, keyB, unbound } = await twoAgents();
        await receipt(keyA.id, a.id, inOpenMonth());
        await receipt(keyA.id, a.id, inOpenMonth(), { tool: 'propose_risks' });
        await receipt(keyB.id, b.id, inOpenMonth());
        // A receipt submitted by a key bound to nobody, whose mediator record
        // CLAIMS agent A. The claim is the sender's string; it attributes nothing.
        await receipt(unbound.id, null, inOpenMonth(), { agent_id: a.id });
        const decA1 = await decision(a.id, keyA.id);
        await decision(a.id, keyA.id);
        await decision(b.id, keyB.id);
        await decision(null, null); // a person's

        // The stamp is the writing request's agent, and only that.
        expect((await prisma.aiDecisionLog.findUniqueOrThrow({ where: { id: decA1 } })).agentId).toBe(a.id);

        const report = await emitAgenticEvidence(ownerCtx(), { asOf: new Date() });
        expect(report.perAgentRefused).toBe(0);
        const rows = await artefactRows();

        // Two agents, two separate rows per kind per control.
        for (const [agent, receipts, decisions] of [[a, 2, 2], [b, 1, 1]] as const) {
            const r = ofKind(rows, ARTEFACT_KIND_RECEIPTS_PER_AGENT, agent.id);
            expect(new Set(r.map((x) => x.controlId))).toEqual(new Set([controls.ASI02, controls.ASI04]));
            expect(r.every((x) => x.recordCount === receipts && x.status === 'CURRENT')).toBe(true);
            const d = ofKind(rows, ARTEFACT_KIND_DECISIONS_PER_AGENT, agent.id);
            expect(new Set(d.map((x) => x.controlId))).toEqual(new Set([controls.ASI09, controls['Art.12']]));
            expect(d.every((x) => x.recordCount === decisions)).toBe(true);
            for (const x of [...r, ...d]) {
                expect(x.evidence.title).toContain(`agent ${agent.id}`);
                expect(x.evidence.content).toContain(`Agent: ${agent.id} (agent register id)`);
            }
            expect(r[0].evidence.content).toContain(`Mediated agent actions recorded: ${receipts}`);
        }
        // No per-agent row for anyone else — the unbound key's receipt and the
        // person's decision belong to no agent.
        expect(
            rows.filter((x) => x.agentId !== null && x.agentId !== a.id && x.agentId !== b.id),
        ).toEqual([]);

        // The tenant-wide artefacts count EVERY record, attributed or not.
        expect(ofKind(rows, ARTEFACT_KIND_RECEIPTS).map((x) => x.recordCount)).toEqual([4, 4]);
        expect(ofKind(rows, ARTEFACT_KIND_DECISIONS).map((x) => x.recordCount)).toEqual([4, 4]);
        // ...and digest exactly the facts they always did: the attribution
        // column is read beside the facts and never put into one.
        const period = OPEN();
        const raw = await prisma.agentActionReceipt.findMany({
            where: { tenantId: T, occurredAt: { gte: period.start, lt: period.end } },
            select: { id: true, toolName: true, decisionVerdict: true, verified: true, auditLogId: true, toolProvenance: true },
            orderBy: { occurredAt: 'asc' },
        });
        expect(ofKind(rows, ARTEFACT_KIND_RECEIPTS)[0].sourceDigest).toBe(
            sourcePopulationDigest(ARTEFACT_KIND_RECEIPTS, period.start, raw),
        );
        // Two agents' digests never coincide.
        expect(ofKind(rows, ARTEFACT_KIND_DECISIONS_PER_AGENT, a.id)[0].sourceDigest).not.toBe(
            ofKind(rows, ARTEFACT_KIND_DECISIONS_PER_AGENT, b.id)[0].sourceDigest,
        );
    });

    it('re-running adds nothing and changes nothing when no record moved', async () => {
        const { a, b, keyA, keyB } = await twoAgents();
        await receipt(keyA.id, a.id, inOpenMonth());
        await decision(b.id, keyB.id);
        await emitAgenticEvidence(ownerCtx(), { asOf: new Date() });
        const before = await artefactRows();

        const again = await emitAgenticEvidence(ownerCtx(), { asOf: new Date() });
        expect(again.artefacts.every((x) => x.outcome === 'unchanged')).toBe(true);
        const after = await artefactRows();
        // `updatedAt` is not compared: the unchanged branch moves only the
        // liveness stamp, and Prisma stamps `@updatedAt` on any update.
        expect(snapshot(after, false)).toEqual(snapshot(before, false));
        expect(ofKind(after, ARTEFACT_KIND_RECEIPTS_PER_AGENT, a.id)).toHaveLength(2);
        expect(ofKind(after, ARTEFACT_KIND_DECISIONS_PER_AGENT, b.id)).toHaveLength(2);
    });
});

// ─── 2. Retirement ───────────────────────────────────────────────────────────

/** A's records in the closed AND the open month, and B's in the open one; both months emitted. */
async function seedTwoMonths() {
    const agents = await twoAgents();
    const { a, b, keyA, keyB } = agents;
    await receipt(keyA.id, a.id, inClosedMonth());
    await prisma.aiDecisionLog.create({
        data: { tenantId: T, feature: 'agent-proposal', provider: 'mcp-agent', inputDigest: 'sha256:closed', agentId: a.id, createdAt: inClosedMonth() },
    });
    await receipt(keyA.id, a.id, inOpenMonth());
    await decision(a.id, keyA.id);
    await receipt(keyB.id, b.id, inOpenMonth());
    await decision(b.id, keyB.id);
    await emitAgenticEvidence(ownerCtx(), { asOf: CLOSED().start });
    await emitAgenticEvidence(ownerCtx(), { asOf: new Date() });
    return agents;
}

/**
 * What a reader of an artefact can see. `withUpdatedAt` for a comparison
 * across an act that must not WRITE the row at all (retirement); without it
 * across an emitter tick, whose unchanged branch moves only the liveness stamp
 * — and Prisma stamps `@updatedAt` on any update through the client.
 */
function snapshot(rows: Row[], withUpdatedAt = true) {
    return rows.map((x) => ({
        id: x.id,
        status: x.status,
        withdrawnReason: x.withdrawnReason,
        sourceDigest: x.sourceDigest,
        recordCount: x.recordCount,
        ...(withUpdatedAt ? { updatedAt: x.updatedAt.getTime() } : {}),
        title: x.evidence.title,
        content: x.evidence.content,
        isArchived: x.evidence.isArchived,
        evidenceStatus: x.evidence.status,
    }));
}

describe('retirement withdraws the agent\'s open-period per-agent artefacts, and nothing else', () => {
    it('withdraws AGENT_RETIRED, archives with a notice, deletes none — and keeps the closed month, the other agent and every tenant-wide row', async () => {
        const { a, b } = await seedTwoMonths();
        const before = await artefactRows();
        const open = OPEN().start.getTime();
        const aOpen = before.filter((x) => x.agentId === a.id && x.periodStart.getTime() === open);
        const aClosed = before.filter((x) => x.agentId === a.id && x.periodStart.getTime() !== open);
        const untouched = before.filter((x) => !aOpen.some((y) => y.id === x.id));
        // Vacuity guard: there is something on each side of the line.
        expect(aOpen).toHaveLength(4);
        expect(aClosed).toHaveLength(4);
        expect(untouched.filter((x) => x.agentId === null).length).toBeGreaterThan(0);
        expect(untouched.filter((x) => x.agentId === b.id)).toHaveLength(4);
        const evidenceBefore = await prisma.evidence.count({ where: { tenantId: T } });

        const result = await retireRegisteredAgent(ownerCtx(), a.id);

        const after = await artefactRows();
        // Nothing deleted: every artefact and every Evidence row is still there.
        expect(after.map((x) => x.id).sort()).toEqual(before.map((x) => x.id).sort());
        expect(await prisma.evidence.count({ where: { tenantId: T } })).toBe(evidenceBefore);
        for (const row of after.filter((x) => aOpen.some((y) => y.id === x.id))) {
            expect(row.status).toBe('WITHDRAWN');
            expect(row.withdrawnReason).toBe('AGENT_RETIRED');
            expect(row.withdrawnAt).not.toBeNull();
            expect(row.evidence.isArchived).toBe(true);
            expect(row.evidence.content).toMatch(/^WITHDRAWN \S+ — AGENT_RETIRED\n/);
            expect(row.evidence.content).toContain(`Agent: ${a.id}`);
        }
        // The closed month, agent B and the tenant-wide artefacts: byte-for-byte,
        // to the updatedAt.
        expect(snapshot(after.filter((x) => untouched.some((y) => y.id === x.id)))).toEqual(snapshot(untouched));

        expect(result.cascade).toMatchObject({
            evidenceArtefactsWithdrawn: 4,
            evidenceBasis: 'PER_AGENT_OPEN_PERIODS',
        });
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: T, entityId: a.id, action: 'AGENT_RETIREMENT_EVIDENCE_WITHDRAWN' },
        });
        expect(new Set((row.detailsJson as { artefactIds: string[] }).artefactIds)).toEqual(new Set(aOpen.map((x) => x.id)));
    });
});

// ─── 3. No resurrection ──────────────────────────────────────────────────────

describe('the emitter never re-emits a retired agent\'s artefact as CURRENT', () => {
    it('a second tick after retirement leaves the withdrawn rows withdrawn and every other row as it was', async () => {
        const { a } = await seedTwoMonths();
        await retireRegisteredAgent(ownerCtx(), a.id);
        const afterRetirement = await artefactRows();

        const tick = await emitAgenticEvidence(ownerCtx(), { asOf: new Date() });
        await withdrawStaleAgenticEvidence(ownerCtx());

        // The retired agent is not even planned, so nothing was refused either.
        expect(tick.artefacts.filter((x) => x.agentId === a.id)).toEqual([]);
        expect(tick.perAgentRefused).toBe(0);
        // Nothing moved — the population did not change, so the tenant-wide and
        // the other agent's rows are `unchanged`, and the withdrawn ones stay.
        expect(snapshot(await artefactRows(), false)).toEqual(snapshot(afterRetirement, false));
    });

    it('stays withdrawn when the retired agent\'s month GROWS — the case the update branch would otherwise revive', async () => {
        // Without the refusal, a changed digest takes the update branch, which
        // rewrites a withdrawn row to CURRENT "because its basis holds again".
        const { a, keyA } = await seedTwoMonths();
        await retireRegisteredAgent(ownerCtx(), a.id);
        // A receipt the mediator delivers late, and a decision row, both
        // attributed to the agent and both inside the still-open month.
        await receipt(keyA.id, a.id, inOpenMonth(), { tool: 'list_controls' });
        await prisma.aiDecisionLog.create({
            data: { tenantId: T, feature: 'agent-proposal', provider: 'mcp-agent', inputDigest: 'sha256:late', agentId: a.id },
        });

        const tick = await emitAgenticEvidence(ownerCtx(), { asOf: new Date() });
        expect(tick.artefacts.filter((x) => x.agentId === a.id)).toEqual([]);

        const rows = await artefactRows();
        const open = OPEN().start.getTime();
        const aOpen = rows.filter((x) => x.agentId === a.id && x.periodStart.getTime() === open);
        expect(aOpen).toHaveLength(4);
        for (const row of aOpen) {
            expect(row.status).toBe('WITHDRAWN');
            expect(row.withdrawnReason).toBe('AGENT_RETIRED');
            expect(row.evidence.isArchived).toBe(true);
            expect(row.evidence.content).toContain('AGENT_RETIRED');
        }
        // The late records ARE in the tenant-wide month — they are true.
        expect(ofKind(rows, ARTEFACT_KIND_RECEIPTS).find((x) => x.periodStart.getTime() === open)?.recordCount).toBe(3);
    });

    it('an emitter tick that planned before a retirement and writes after it is refused, not resurrected', async () => {
        // The plan is one transaction and each write another, so a retirement
        // can commit in between. Hold a transaction that has written RETIRED —
        // retirement's first write, which keeps the agent row locked — and let
        // the tick run: it plans the agent (the uncommitted status is invisible
        // to it), then its per-agent write must WAIT on the row lock and, once
        // the retirement commits, read RETIRED and refuse.
        const { a, keyA } = await twoAgents();
        await receipt(keyA.id, a.id, inOpenMonth());
        await decision(a.id, keyA.id);

        let markUpdated!: () => void;
        const updated = new Promise<void>((resolve) => (markUpdated = resolve));
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const retiring = prisma.$transaction(
            async (tx) => {
                await tx.registeredAgent.update({ where: { id: a.id }, data: { status: 'RETIRED' } });
                markUpdated();
                await held;
            },
            { timeout: 60_000, maxWait: 10_000 },
        );
        await updated;

        const state = { settled: false };
        const ticking = emitAgenticEvidence(ownerCtx(), { asOf: new Date() }).finally(() => {
            state.settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_PROBE_MS));
        expect(state.settled).toBe(false); // waiting on the agent row, not racing past it

        release();
        await retiring;
        const report = await ticking;

        // Two receipt controls and two decision controls, every one refused.
        expect(report.perAgentRefused).toBe(4);
        const rows = await artefactRows();
        expect(rows.filter((x) => x.agentId === a.id)).toEqual([]);
        // The refused writes left no orphaned Evidence behind: the only Evidence
        // rows are the tenant-wide artefacts'.
        expect(await prisma.evidence.count({ where: { tenantId: T } })).toBe(rows.length);
        expect(rows.every((x) => x.agentId === null)).toBe(true);
    });
});

// ─── 4. The database holds the shape ─────────────────────────────────────────

describe('the database refuses what the usecase never writes', () => {
    const insertArtefact = async (
        db: PrismaClient,
        input: { kind: string; agentId: string | null; status?: 'CURRENT' | 'WITHDRAWN'; reason?: string | null },
    ) => {
        const evidence = await db.evidence.create({
            data: { tenantId: T, type: 'TEXT', title: `shape probe ${input.kind}`, content: 'x', status: 'DRAFT' },
            select: { id: true },
        });
        const withdrawn = input.status === 'WITHDRAWN';
        return db.$executeRawUnsafe(
            `INSERT INTO "AgenticEvidenceArtefact"
               ("id", "tenantId", "controlId", "kind", "agentId", "periodStart", "periodEnd", "evidenceId",
                "sourceDigest", "status", "withdrawnAt", "withdrawnReason", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, '2020-01-01T00:00:00Z', '2020-02-01T00:00:00Z', $6,
                     'probe', $7, $8, $9, now())`,
            randomUUID(),
            T,
            controls.ASI02,
            input.kind,
            input.agentId,
            evidence.id,
            withdrawn ? 'WITHDRAWN' : 'CURRENT',
            withdrawn ? new Date().toISOString() : null,
            withdrawn ? (input.reason ?? 'CONTROL_REMOVED') : null,
        );
    };

    it('pairs the kind and the agent: no per-agent kind without one, no tenant-wide kind with one', async () => {
        const { a } = await twoAgents();
        await expect(insertArtefact(prisma, { kind: ARTEFACT_KIND_RECEIPTS_PER_AGENT, agentId: null })).rejects.toThrow(
            /AgenticEvidenceArtefact_agent_scope/,
        );
        await expect(insertArtefact(prisma, { kind: ARTEFACT_KIND_RECEIPTS, agentId: a.id })).rejects.toThrow(
            /AgenticEvidenceArtefact_agent_scope/,
        );
        await expect(insertArtefact(prisma, { kind: ARTEFACT_KIND_RECEIPTS_PER_AGENT, agentId: a.id })).resolves.toBe(1);
    });

    it('keeps one tenant-wide row per identity — NULL agents are not distinct — and one per agent', async () => {
        const { a, b } = await twoAgents();
        await expect(insertArtefact(prisma, { kind: ARTEFACT_KIND_RECEIPTS, agentId: null })).resolves.toBe(1);
        await expect(insertArtefact(prisma, { kind: ARTEFACT_KIND_RECEIPTS, agentId: null })).rejects.toThrow(
            /AgenticEvidenceArtefact_identity_key|Unique constraint/,
        );
        await expect(insertArtefact(prisma, { kind: ARTEFACT_KIND_RECEIPTS_PER_AGENT, agentId: a.id })).resolves.toBe(1);
        await expect(insertArtefact(prisma, { kind: ARTEFACT_KIND_RECEIPTS_PER_AGENT, agentId: a.id })).rejects.toThrow(
            /AgenticEvidenceArtefact_identity_key|Unique constraint/,
        );
        // A second agent on the same (control, kind, period) is its own row.
        await expect(insertArtefact(prisma, { kind: ARTEFACT_KIND_RECEIPTS_PER_AGENT, agentId: b.id })).resolves.toBe(1);
    });

    it('admits AGENT_RETIRED on a per-agent row only', async () => {
        const { a } = await twoAgents();
        await expect(
            insertArtefact(prisma, { kind: ARTEFACT_KIND_DECISIONS, agentId: null, status: 'WITHDRAWN', reason: 'AGENT_RETIRED' }),
        ).rejects.toThrow(/AgenticEvidenceArtefact_agent_retired_is_per_agent/);
        await expect(
            insertArtefact(prisma, { kind: ARTEFACT_KIND_DECISIONS_PER_AGENT, agentId: a.id, status: 'WITHDRAWN', reason: 'AGENT_RETIRED' }),
        ).resolves.toBe(1);
    });

    it('refuses, under app_user, any CURRENT write of a retired agent\'s artefact — insert or revival', async () => {
        const { a } = await twoAgents();
        await insertArtefact(prisma, { kind: ARTEFACT_KIND_RECEIPTS_PER_AGENT, agentId: a.id, status: 'WITHDRAWN', reason: 'AGENT_RETIRED' });
        await prisma.registeredAgent.update({ where: { id: a.id }, data: { status: 'RETIRED' } });

        await expect(
            asTenant((tx) => insertArtefact(tx, { kind: ARTEFACT_KIND_DECISIONS_PER_AGENT, agentId: a.id })),
        ).rejects.toThrow(/AGENT_RETIRED:/);
        await expect(
            asTenant((tx) =>
                tx.agenticEvidenceArtefact.updateMany({
                    where: { tenantId: T, agentId: a.id },
                    data: { status: 'CURRENT', withdrawnAt: null, withdrawnReason: null },
                }),
            ),
        ).rejects.toThrow(/AGENT_RETIRED:/);
        // Withdrawing is never refused.
        await expect(
            asTenant((tx) =>
                insertArtefact(tx, { kind: ARTEFACT_KIND_DECISIONS_PER_AGENT, agentId: a.id, status: 'WITHDRAWN', reason: 'AGENT_RETIRED' }),
            ),
        ).resolves.toBe(1);
    });

    it('keeps a decision\'s agent immutable: it can never be re-attributed', async () => {
        const { a, b, keyA } = await twoAgents();
        const id = await decision(a.id, keyA.id);
        await expect(prisma.aiDecisionLog.update({ where: { id }, data: { agentId: b.id } })).rejects.toThrow(/append-only/);
        await expect(prisma.aiDecisionLog.update({ where: { id }, data: { agentId: null } })).rejects.toThrow(/append-only/);
        // The one mutation the log admits still works.
        await expect(prisma.aiDecisionLog.update({ where: { id }, data: { humanOutcome: 'ACCEPTED' } })).resolves.toMatchObject({
            agentId: a.id,
            humanOutcome: 'ACCEPTED',
        });
    });
});
