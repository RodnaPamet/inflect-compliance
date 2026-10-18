/**
 * #3671 — a contained agent's Entra service principal, disabled through the
 * external write ladder, proved on real rows.
 *
 * The chain under test is the whole of it, end to end, with ONE seam mocked:
 * `callTool`, the outbound MCP transport. Nothing here reaches Graph, and
 * nothing in the code path being tested could — the request path, the
 * dispatch and the reconcile all speak to the outbound endpoint through
 * `callTool`, and that is the boundary this file stands on.
 *
 *   owner leaves → orphan pass (AUTOMATIC) kills + suspends the agent
 *     → requestServicePrincipalDisable, per the OUTBOUND connection's rung:
 *         DISABLED      nothing, not even the read
 *         DRY_RUN       a RECORDED_ONLY journal row with the prior state
 *         PROPOSE_ONLY  an EXTERNAL_WRITE proposal carrying the prior state
 *         AUTOMATIC     a PENDING journal row carrying the prior state, under a
 *                       template promoted through the real four-eyes flow
 *     → external-write-dispatch sends it, settles ACCEPTED
 *     → reconcile promotes to APPLIED only when the read shows it disabled
 *
 * Fixtures: two tenants, each with an ACTIVE agent whose owner's membership is
 * DEACTIVATED, a harness `DiscoveredAgent` reconciling it to one
 * `entra:sp:<GUID>`, an `mcp-server` connection configured for the outbound
 * endpoint, and the OWNER-nominated pairing. Each rung's test makes a FRESH
 * orphan, because the pass suspends what it contains and a suspended agent is
 * not seen by the next pass.
 */
const callToolMock = jest.fn();
jest.mock('@/app-layer/integrations/mcp/client', () => ({
    callTool: (...a: unknown[]) => callToolMock(...a),
}));
jest.mock('@/app-layer/integrations/mcp/token', () => ({
    authorizationFor: jest.fn(async () => 'Bearer conn.secret'),
}));

import { MembershipStatus, PrismaClient, Role } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { runInTenantContext } from '@/lib/db-context';
import { externalToolName } from '@/lib/mcp/external-tool-name';
import {
    CONTAINED_AGENT_SP_POPULATION,
    SERVICE_PRINCIPAL_DISABLE_TOOL,
    SERVICE_PRINCIPAL_READ_TOOL,
} from '@/lib/agentic/service-principal-disable';
import { runAgentOwnerOrphanPass } from '@/app-layer/usecases/agent-owner-orphan-pass';
import { requestServicePrincipalDisable } from '@/app-layer/usecases/agent-service-principal-disable';
import { resolveTargetPopulation } from '@/app-layer/usecases/external-tool-target-populations';
import { getJournalWrite } from '@/app-layer/usecases/external-write-journal';
import { runExternalWriteDispatch } from '@/app-layer/usecases/external-write-dispatch';
import { reconcileAcceptedExternalWrites } from '@/app-layer/usecases/external-write-reconcile';
import { approveAgentProposal } from '@/app-layer/usecases/agent-proposals';
import {
    approveParameterChange,
    proposeParameterChange,
    saveParameterSet,
    signParameterChange,
} from '@/app-layer/usecases/external-tool-parameters';
import { buildSystemContext } from '@/app-layer/context-system';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const SUITE = randomUUID().slice(0, 8);
const T1 = `spdisable-one-${SUITE}`;
const T2 = `spdisable-two-${SUITE}`;
const TENANTS = [T1, T2];
const ENDPOINT = 'https://app.example.test/api/mcp/entra-service-principal';
const LABEL = 'contained-agent-disable';

type Who = 'proposer' | 'approver' | 'departed';
const users: Record<string, Partial<Record<Who, string>>> = { [T1]: {}, [T2]: {} };
const connections: Record<string, string> = {};
let seq = 0;

const guid = () => randomUUID().toLowerCase();
const writeTool = (tenantId: string) => externalToolName(connections[tenantId], SERVICE_PRINCIPAL_DISABLE_TOOL);
const readTool = (tenantId: string) => externalToolName(connections[tenantId], SERVICE_PRINCIPAL_READ_TOOL);

const ctxFor = (tenantId: string, who: Who = 'proposer'): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: users[tenantId][who] });

/** The read tool's answer, in the envelope `callTool` returns. */
const readAnswer = (id: string, accountEnabled: boolean) => ({
    content: [
        {
            type: 'text',
            text: JSON.stringify({
                servicePrincipal: {
                    id,
                    appId: 'ffffffff-1111-2222-3333-444455556666',
                    displayName: 'contained agent principal',
                    accountEnabled,
                    servicePrincipalType: 'Application',
                    appOwnerOrganizationId: '5c459bc6-0000-4000-8000-000000000001',
                },
            }),
        },
    ],
});

/** The directory, as the mocked transport sees it: id -> enabled. */
const directory = new Map<string, boolean>();
function answerFromDirectory(_t: unknown, name: string, args: Record<string, unknown>) {
    const id = String(args.servicePrincipalId ?? '');
    if (name === SERVICE_PRINCIPAL_READ_TOOL) {
        if (!directory.has(id)) return { content: [{ type: 'text', text: 'not found' }], isError: true };
        return readAnswer(id, directory.get(id)!);
    }
    // The WRITE. The directory takes it; the dispatch must still not call that
    // APPLIED — only the reconcile's read may.
    return { content: [{ type: 'text', text: JSON.stringify({ disabled: true }) }] };
}
const writeCalls = () => callToolMock.mock.calls.filter((c) => c[1] === SERVICE_PRINCIPAL_DISABLE_TOOL);
const readCalls = () => callToolMock.mock.calls.filter((c) => c[1] === SERVICE_PRINCIPAL_READ_TOOL);

async function person(tenantId: string, who: Who, role: Role, status: MembershipStatus) {
    const email = `${who}@${tenantId}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email), name: who } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status } });
    users[tenantId][who] = user.id;
}

/**
 * A FRESH orphan: an ACTIVE agent owned by the departed user, reconciled by
 * the harness to `principals` Entra service principals (each present and
 * ENABLED in the mocked directory). Returns the agent id and its principals.
 */
async function orphan(tenantId: string, principals = 1): Promise<{ agentId: string; sps: string[] }> {
    seq += 1;
    const owner = users[tenantId].departed as string;
    const sys = await prisma.aiSystem.create({ data: { tenantId, name: `sp host ${seq}`, ownerUserId: owner } });
    const agent = await prisma.registeredAgent.create({
        data: {
            tenantId,
            aiSystemId: sys.id,
            name: `sp probe ${seq}`,
            autonomyLevel: 2,
            dataAccessScope: 'READ_TENANT_DATA',
            reversibility: 'REVERSIBLE',
            provenance: 'FIRST_PARTY',
            ownerUserId: owner,
            status: 'ACTIVE',
            riskTier: 'LOW',
            riskTierScoredAt: new Date(),
        },
    });
    const sps: string[] = [];
    for (let i = 0; i < principals; i += 1) {
        const sp = guid();
        sps.push(sp);
        directory.set(sp, true);
        await prisma.discoveredAgent.create({
            data: {
                tenantId,
                // Upper-cased on purpose: the population and the request both
                // derive the id through one lower-casing function, and a
                // membership test over two spellings would refuse silently.
                discoveredId: `entra:sp:${sp.toUpperCase()}`,
                discoveredVia: ['entra-sp'],
                registeredAgentId: agent.id,
                firstSeenAt: new Date(),
                lastSeenAt: new Date(),
                lastScanId: `scan-${seq}-${i}`,
                lastLevel: 'H2',
                lastReach: 'WRITE_OR_EXTERNAL',
            },
        });
    }
    return { agentId: agent.id, sps };
}

async function setRung(tenantId: string, mode: string) {
    await prisma.integrationConnection.update({
        where: { id: connections[tenantId] },
        data: { externalWriteMode: mode, externalWriteModeSince: new Date('2026-09-01T00:00:00.000Z') },
    });
}

type SpRecord = { status: string; journalId?: string; proposalId?: string; rung?: string };
async function decisionFor(executionId: string | null, agentId: string): Promise<SpRecord | undefined> {
    const row = await prisma.integrationExecution.findUniqueOrThrow({ where: { id: executionId as string } });
    const decisions = (row.resultJson as { decisions: { agentId: string; servicePrincipal: SpRecord }[] }).decisions;
    return decisions.find((d) => d.agentId === agentId)?.servicePrincipal;
}

async function approvedTemplate(tenantId: string): Promise<void> {
    const set = await saveParameterSet(ctxFor(tenantId, 'proposer'), {
        toolName: writeTool(tenantId),
        label: LABEL,
        parameters: {},
    });
    const proposed = await proposeParameterChange(ctxFor(tenantId, 'proposer'), {
        id: set.id,
        parameters: {},
        openFields: { servicePrincipalId: { kind: 'target' } },
        targetPopulation: CONTAINED_AGENT_SP_POPULATION,
    });
    const hash = proposed.pending!.hash;
    await signParameterChange(ctxFor(tenantId, 'approver'), { id: set.id, expectedPendingHash: hash });
    await approveParameterChange(ctxFor(tenantId, 'approver'), { id: set.id, expectedPendingHash: hash });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    for (const tenantId of TENANTS) {
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        await person(tenantId, 'proposer', Role.OWNER, MembershipStatus.ACTIVE);
        await person(tenantId, 'approver', Role.OWNER, MembershipStatus.ACTIVE);
        await person(tenantId, 'departed', Role.EDITOR, MembershipStatus.DEACTIVATED);
        await prisma.tenantSecuritySettings.create({
            data: { tenantId, agentOrphanPassMode: 'AUTOMATIC', aiGuardMode: 'AUDIT' },
        });
        const conn = await prisma.integrationConnection.create({
            data: {
                tenantId,
                provider: 'mcp-server',
                name: 'Entra service principals',
                isEnabled: true,
                configJson: { url: ENDPOINT },
                externalWriteMode: 'DISABLED',
            },
        });
        connections[tenantId] = conn.id;
        await prisma.externalToolPriorStateRead.create({
            data: { tenantId, writeToolName: writeTool(tenantId), readToolName: readTool(tenantId) },
        });
    }
});

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.notification.deleteMany({ where: t });
    await prisma.notificationOutbox.deleteMany({ where: t });
    await prisma.integrationExecution.deleteMany({ where: t });
    await prisma.externalWriteJournal.deleteMany({ where: t });
    await prisma.agentProposalApproval.deleteMany({ where: t }).catch(() => undefined);
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.aiDecisionLog.deleteMany({ where: t });
    await prisma.externalToolParameterSetApproval.deleteMany({ where: t });
    await prisma.externalToolParameterSet.deleteMany({ where: t });
    await prisma.externalToolPriorStateRead.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.agentKillSwitch.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.integrationConnection.deleteMany({ where: t });
    await prisma.tenantSecuritySettings.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, TENANTS);
    });
    const allUsers = Object.values(users).flatMap((byWho) => Object.values(byWho)) as string[];
    await prisma.user.deleteMany({ where: { id: { in: allUsers } } });
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

beforeEach(() => {
    jest.clearAllMocks();
    callToolMock.mockImplementation(answerFromDirectory);
});

// ═════════════════════════════════════════════════════════════════════
// 1. EACH RUNG OF THE OUTBOUND CONNECTION, THROUGH THE ORPHAN PASS
// ═════════════════════════════════════════════════════════════════════

describe('the orphan pass requests the disable per the outbound connection\'s rung', () => {
    it('DISABLED: the agent is contained, and nothing is read or written about its principal', async () => {
        await setRung(T1, 'DISABLED');
        const { agentId } = await orphan(T1);
        const result = await runAgentOwnerOrphanPass({ tenantId: T1, tenantSlug: T1 });
        expect(result.status).toBe('PASSED');
        expect((await decisionFor(result.executionId, agentId))?.status).toBe('RUNG_DISABLED');
        expect(callToolMock).not.toHaveBeenCalled();
        expect(await prisma.externalWriteJournal.count({ where: { tenantId: T1 } })).toBe(0);
        expect(await prisma.agentProposal.count({ where: { tenantId: T1 } })).toBe(0);
    });

    it('DRY_RUN: the read runs and a RECORDED_ONLY intent carries it; nothing is sent', async () => {
        await setRung(T1, 'DRY_RUN');
        const { agentId, sps } = await orphan(T1);
        const result = await runAgentOwnerOrphanPass({ tenantId: T1, tenantSlug: T1 });
        const sp = await decisionFor(result.executionId, agentId);
        expect(sp?.status).toBe('RECORDED_INTENT');
        expect(readCalls()).toHaveLength(1);
        expect(writeCalls()).toHaveLength(0);

        const row = await getJournalWrite(ctxFor(T1), sp!.journalId as string);
        expect(row?.outcome).toBe('RECORDED_ONLY');
        expect(row?.mode).toBe('DRY_RUN');
        expect(JSON.parse(row!.argumentsJson)).toEqual({ servicePrincipalId: sps[0] });
        expect(JSON.parse(row!.priorStateJson)).toEqual(readAnswer(sps[0], true));
        // A dry run is evidence for the dwell and nothing the dispatch sends.
        const dispatched = await runExternalWriteDispatch({ tenantId: T1 });
        expect(dispatched.scanned).toBe(0);
        expect(writeCalls()).toHaveLength(0);
    });

    it('PROPOSE_ONLY: an EXTERNAL_WRITE proposal carries the prior state; approving it opens a PENDING row, and only the dispatch sends', async () => {
        await setRung(T1, 'PROPOSE_ONLY');
        const { agentId, sps } = await orphan(T1);
        const result = await runAgentOwnerOrphanPass({ tenantId: T1, tenantSlug: T1 });
        const sp = await decisionFor(result.executionId, agentId);
        expect(sp?.status).toBe('PROPOSED');
        expect(writeCalls()).toHaveLength(0);

        const proposal = await runInTenantContext(ctxFor(T1), (db) =>
            db.agentProposal.findFirstOrThrow({ where: { id: sp!.proposalId as string } }),
        );
        expect(proposal.kind).toBe('EXTERNAL_WRITE');
        expect(proposal.status).toBe('PENDING');
        // No agent proposed it — the contained agent is its SUBJECT.
        expect(proposal.agentId).toBeNull();
        const payload = JSON.parse(proposal.payloadJson) as Record<string, unknown>;
        expect(payload.toolName).toBe(writeTool(T1));
        expect(payload.arguments).toEqual({ servicePrincipalId: sps[0] });
        expect(payload.priorState).toEqual(readAnswer(sps[0], true));
        expect(await prisma.externalWriteJournal.count({ where: { tenantId: T1, outcome: 'PENDING' } })).toBe(0);

        // A human approves: a PENDING row, still nothing sent.
        const approved = await approveAgentProposal(ctxFor(T1, 'approver'), proposal.id);
        const journalId = (approved as { createdEntityId: string }).createdEntityId;
        expect((await getJournalWrite(ctxFor(T1), journalId))?.outcome).toBe('PENDING');
        expect(writeCalls()).toHaveLength(0);

        // The dispatch sends it and settles ACCEPTED — never APPLIED on a 2xx.
        const dispatched = await runExternalWriteDispatch({ tenantId: T1 });
        expect(dispatched).toMatchObject({ accepted: 1, applied: 0 });
        expect(writeCalls()).toHaveLength(1);
        expect(writeCalls()[0][2]).toEqual({ servicePrincipalId: sps[0] });
        expect((await getJournalWrite(ctxFor(T1), journalId))?.outcome).toBe('ACCEPTED');
    });

    it('AUTOMATIC: a PENDING row carries the prior state; the dispatch sends; APPLIED only once the read shows it disabled', async () => {
        await approvedTemplate(T1);
        await setRung(T1, 'AUTOMATIC');
        const { agentId, sps } = await orphan(T1);
        const result = await runAgentOwnerOrphanPass({ tenantId: T1, tenantSlug: T1 });
        const sp = await decisionFor(result.executionId, agentId);
        expect(sp?.status).toBe('QUEUED');
        expect(sp?.rung).toBe('AUTOMATIC');
        expect(writeCalls()).toHaveLength(0);

        // THE JOURNAL ROW CARRIES THE CAPTURED PRIOR STATE BEFORE ANYTHING IS SENT.
        const opened = await getJournalWrite(ctxFor(T1), sp!.journalId as string);
        expect(opened?.outcome).toBe('PENDING');
        expect(opened?.mode).toBe('AUTOMATIC');
        expect(opened?.parameterSetLabel).toBe(LABEL);
        expect(JSON.parse(opened!.priorStateJson)).toEqual(readAnswer(sps[0], true));
        const logs = await prisma.aiDecisionLog.findMany({
            where: { tenantId: T1, feature: 'external-write-automatic' },
        });
        expect(logs.map((l) => l.humanOutcome)).toContain('AUTONOMOUS');

        // The dispatch sends, and claims only ACCEPTED.
        const dispatched = await runExternalWriteDispatch({ tenantId: T1 });
        expect(dispatched).toMatchObject({ accepted: 1, applied: 0, refused: 0 });
        expect(writeCalls()).toHaveLength(1);
        expect((await getJournalWrite(ctxFor(T1), sp!.journalId as string))?.outcome).toBe('ACCEPTED');

        // The directory has not reflected it yet: the reconcile leaves it ACCEPTED.
        const early = await reconcileAcceptedExternalWrites({ tenantId: T1 });
        expect(early.promoted).toBe(0);
        expect((await getJournalWrite(ctxFor(T1), sp!.journalId as string))?.outcome).toBe('ACCEPTED');

        // Now the read shows it disabled: APPLIED, with that as the evidence.
        directory.set(sps[0], false);
        const late = await reconcileAcceptedExternalWrites({ tenantId: T1 });
        expect(late.promoted).toBeGreaterThanOrEqual(1);
        const settled = await getJournalWrite(ctxFor(T1), sp!.journalId as string);
        expect(settled?.outcome).toBe('APPLIED');
        expect(settled?.detail).toContain('disabled');
    });
});

// ═════════════════════════════════════════════════════════════════════
// 2. REFUSALS, ON REAL ROWS
// ═════════════════════════════════════════════════════════════════════

describe('refusals', () => {
    it('a failed prior-state read refuses the write, and the pass says it needs attention', async () => {
        await setRung(T1, 'AUTOMATIC');
        const { agentId } = await orphan(T1);
        const before = await prisma.externalWriteJournal.count({ where: { tenantId: T1 } });
        callToolMock.mockRejectedValue(new Error('endpoint unreachable'));
        const result = await runAgentOwnerOrphanPass({ tenantId: T1, tenantSlug: T1 });
        expect((await decisionFor(result.executionId, agentId))?.status).toBe('PRIOR_STATE_UNREADABLE');
        expect(result.status).toBe('PARTIAL');
        expect(await prisma.externalWriteJournal.count({ where: { tenantId: T1 } })).toBe(before);
    });

    it('an agent reconciled to two principals is refused as ambiguous', async () => {
        await setRung(T1, 'AUTOMATIC');
        const { agentId } = await orphan(T1, 2);
        const result = await runAgentOwnerOrphanPass({ tenantId: T1, tenantSlug: T1 });
        expect((await decisionFor(result.executionId, agentId))?.status).toBe('AMBIGUOUS_LINK');
        expect(readCalls()).toHaveLength(0);
    });

    it('an agent the pass did not contain is not a candidate, even with a principal', async () => {
        await setRung(T1, 'AUTOMATIC');
        // An agent with a link and NO kill: the pass never saw it (its owner is
        // the ACTIVE proposer), so nothing has contained it.
        seq += 1;
        const sys = await prisma.aiSystem.create({
            data: { tenantId: T1, name: `healthy ${seq}`, ownerUserId: users[T1].proposer as string },
        });
        const healthy = await prisma.registeredAgent.create({
            data: {
                tenantId: T1,
                aiSystemId: sys.id,
                name: `healthy ${seq}`,
                autonomyLevel: 2,
                dataAccessScope: 'READ_TENANT_DATA',
                reversibility: 'REVERSIBLE',
                provenance: 'FIRST_PARTY',
                ownerUserId: users[T1].proposer as string,
                status: 'ACTIVE',
                riskTier: 'LOW',
                riskTierScoredAt: new Date(),
            },
        });
        const out = await requestServicePrincipalDisable(
            buildSystemContext({ tenantId: T1, job: 'agent-owner-orphan-pass' }),
            { agentId: healthy.id },
        );
        expect(out.status).toBe('NOT_CONTAINED');
        expect(callToolMock).not.toHaveBeenCalled();
    });
});

// ═════════════════════════════════════════════════════════════════════
// 3. THE POPULATION, AND TWO TENANTS
// ═════════════════════════════════════════════════════════════════════

describe('the contained-agent population is this tenant\'s, and only its contained agents', () => {
    it('admits a contained agent\'s one principal, never another tenant\'s, never an ambiguous agent\'s', async () => {
        await setRung(T2, 'DISABLED');
        const t2 = await orphan(T2);
        await runAgentOwnerOrphanPass({ tenantId: T2, tenantSlug: T2 });

        const one = await resolveTargetPopulation(ctxFor(T1), CONTAINED_AGENT_SP_POPULATION);
        const two = await resolveTargetPopulation(ctxFor(T2), CONTAINED_AGENT_SP_POPULATION);
        expect(one.state).toBe('ok');
        expect(two.state).toBe('ok');
        const oneValues = one.state === 'ok' ? [...one.values] : [];
        const twoValues = two.state === 'ok' ? [...two.values] : [];
        expect(twoValues).toEqual([t2.sps[0]]);
        expect(oneValues).not.toContain(t2.sps[0]);
        expect(oneValues.length).toBeGreaterThan(0);

        // T1 asking about T2's agent finds nothing contained.
        const crossed = await requestServicePrincipalDisable(
            buildSystemContext({ tenantId: T1, job: 'agent-owner-orphan-pass' }),
            { agentId: t2.agentId },
        );
        expect(crossed.status).toBe('NOT_CONTAINED');
    });
});
