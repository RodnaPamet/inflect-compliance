/**
 * The discovered-agent review against a real database (#3668, step 1d).
 *
 * Every discovered agent here was written by the real ingest
 * (`ingestHarnessReport`, signed by a fake scanner whose key the tenant
 * registered), so the rows the facts read returns are the rows production would
 * hold. What is pinned:
 *
 *   1. A RUN WITHOUT ITS REQUIRED INPUT IS REFUSED BEFORE ITS ROW EXISTS —
 *      on either engine, so the refusal comes ahead of the driver choice, the
 *      register check and the mount gate.
 *   2. THE RUN MOUNTS EXACTLY THE TWO IAM SKILLS: a Flue run's row is pinned to
 *      the two, through the REAL mount gate reading the committed evaluation
 *      records — nothing about the gate is mocked here.
 *   3. THE FACTS READ is gated on `admin.agent_registry`, isolated per tenant,
 *      returns what the scan observed, states no level, and fails closed.
 *   4. THE STATIC ENGINE reaches it through the real tool funnel.
 *
 * ── WHAT IS MOCKED, AND WHY ─────────────────────────────────────────────────
 *
 * Only for the Flue half of item 2, as `workflow-run-skill-pin.test.ts` does:
 * a deployment that permits the engine (an env switch), a vouched registered
 * agent, and the worker the run is handed to. Each mock calls through to the
 * real module unless a test asks for the Flue path.
 */
jest.mock('@/lib/agentic/agent-driver-policy', () => {
    const actual = jest.requireActual('@/lib/agentic/agent-driver-policy');
    return { ...actual, resolveDriverForRun: jest.fn(actual.resolveDriverForRun) };
});
jest.mock('@/lib/agentic/agent-registration-gate', () => {
    const actual = jest.requireActual('@/lib/agentic/agent-registration-gate');
    return { ...actual, evaluateAgentRegistration: jest.fn(actual.evaluateAgentRegistration) };
});
jest.mock('@/app-layer/jobs/queue', () => ({
    ...jest.requireActual('@/app-layer/jobs/queue'),
    enqueue: jest.fn(async () => undefined),
}));

import { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { createFakeScanner, validReportBody } from '../helpers/agent-harness-fake-scanner';
import { resolveDriverForRun } from '@/lib/agentic/agent-driver-policy';
import { evaluateAgentRegistration } from '@/lib/agentic/agent-registration-gate';
import { enqueue } from '@/app-layer/jobs/queue';
import { createRegisteredAgent } from '@/app-layer/usecases/agent-registry';
import { ingestHarnessReport } from '@/app-layer/usecases/agent-harness-scans';
import { addHarnessScannerKey } from '@/app-layer/usecases/agent-harness-scanner-keys';
import { getDiscoveredAgentFacts } from '@/app-layer/usecases/agent-harness-facts';
import { getWorkflowRun, startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import { loadSkill } from '@/lib/agentic/flue/skills';
import { skillContentHash } from '@/lib/agentic/flue/skills/evaluation-record';
import { resetSkillCache } from '@/lib/agentic/flue/skills/resolve';
import type { HarnessReportAgent } from '@/lib/agentic/harness-contract';
import type { RequestContext } from '@/app-layer/types';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const KEY = 'discovered-agent-review';
const T1 = 'discovered-agent-review-one';
const T2 = 'discovered-agent-review-two';
const ALL_TENANTS = [T1, T2];

const DISCOVERED_ID = 'entra:sp:shadow-review-3668';
const OWNER_REF = 'usr_source_owner_3668';
const TOOL_SERVER = 'https://mcp.internal.example/crm';

const owners: Record<string, string> = {};
const others: Record<string, Record<'ADMIN' | 'EDITOR' | 'READER', string>> = {};
let discoveredAgentId = '';

const emails = (tenantId: string) => ['owner', 'admin', 'editor', 'reader'].map((r) => `${r}@${tenantId}.test`);
const ownerCtx = (tenantId: string): RequestContext =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: owners[tenantId] });
const roleCtx = (tenantId: string, role: 'ADMIN' | 'EDITOR' | 'READER'): RequestContext =>
    makeRequestContext(role, { tenantId, tenantSlug: tenantId, userId: others[tenantId][role] });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: ALL_TENANTS } };
    await prisma.workflowStep.deleteMany({ where: t });
    await prisma.workflowRun.deleteMany({ where: t });
    await prisma.agentHarnessAcceptance.deleteMany({ where: t });
    await prisma.agentHarnessScanItem.deleteMany({ where: t });
    await prisma.agentHarnessScan.deleteMany({ where: t });
    await prisma.discoveredAgent.deleteMany({ where: t });
    await prisma.agentHarnessScannerKey.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, ALL_TENANTS);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, ALL_TENANTS);
    });
    await prisma.user.deleteMany({ where: { emailHash: { in: ALL_TENANTS.flatMap(emails).map(hashForLookup) } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ALL_TENANTS } } });
}

async function member(tenantId: string, email: string, role: Role): Promise<string> {
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await prisma.tenantMembership.create({ data: { tenantId, userId: user.id, role, status: MembershipStatus.ACTIVE } });
    return user.id;
}

async function seedTenant(tenantId: string): Promise<void> {
    await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
    const [o, a, e, r] = emails(tenantId);
    owners[tenantId] = await member(tenantId, o, Role.OWNER);
    others[tenantId] = {
        ADMIN: await member(tenantId, a, Role.ADMIN),
        EDITOR: await member(tenantId, e, Role.EDITOR),
        READER: await member(tenantId, r, Role.READER),
    };
}

/** One shadow agent, owner-tagged at its source, with one evidenced and one unevidenced observation. */
function shadowAgent(): HarnessReportAgent {
    return {
        discoveredId: DISCOVERED_ID,
        discoveredVia: ['entra-sp', 'mcp'],
        registeredAgentId: null,
        owner: { kind: 'user', id: OWNER_REF, source: 'entra-owner-tag' },
        credentials: [{ ref: 'kv://prod/agents/review-3668', ageDays: 3, expires: true, boundToAgent: true, grant: 'delegated' }],
        tools: [{ server: TOOL_SERVER, name: 'update_opportunity', manifestHash: null, pinned: false, readOnlyHint: false }],
        skills: [],
        verdicts: [
            { criterion: 'H1.owner', met: true, evidence: 'entra-sp:servicePrincipals/shadow-review-3668#owners' },
            { criterion: 'H3.manifests_pinned', met: false, evidence: null },
        ],
    };
}

async function ingestShadow(tenantId: string): Promise<string> {
    const ctx = ownerCtx(tenantId);
    const aiSystem = await prisma.aiSystem.create({ data: { tenantId, name: 'Scanner host', ownerUserId: owners[tenantId] } });
    const scannerAgent = await createRegisteredAgent(ctx, {
        aiSystemId: aiSystem.id,
        name: `Scanner ${tenantId}`,
        autonomyLevel: 2,
        dataAccessScope: 'READ_TENANT_DATA',
        reversibility: 'COMPENSABLE',
        provenance: 'FIRST_PARTY',
        ownerUserId: owners[tenantId],
    });
    const scanner = createFakeScanner();
    await addHarnessScannerKey(ctx, { agentId: scannerAgent.id, publicKey: scanner.publicKeyHex });
    const body = validReportBody();
    body.scan = { id: `scan-${tenantId}`, asOf: '2026-10-18T03:00:00.000Z', scanner: { ...body.scan.scanner, agentId: scannerAgent.id } };
    body.population = {
        sources: [
            { kind: 'entra-sp', status: 'COMPLETE', rows: 10 },
            { kind: 'mcp', status: 'INCOMPLETE', reason: 'BYTE_CAP', rows: 1 },
        ],
    };
    body.agents = [shadowAgent()];
    body.findings = [];
    await ingestHarnessReport(ctx, scanner.serialise(body));
    const row = await prisma.discoveredAgent.findFirstOrThrow({ where: { tenantId, discoveredId: DISCOVERED_ID }, select: { id: true } });
    return row.id;
}

const runsOf = (tenantId: string) => prisma.workflowRun.count({ where: { tenantId, workflowKey: KEY } });

/** Ask for the Flue path for one test: a permitting deployment and a vouched agent. */
function asFlue(): void {
    jest.mocked(resolveDriverForRun).mockImplementation(async () => ({ driver: 'flue', reason: null }) as Awaited<ReturnType<typeof resolveDriverForRun>>);
    jest.mocked(evaluateAgentRegistration).mockImplementation(
        async () => ({ standing: 'vouched' }) as Awaited<ReturnType<typeof evaluateAgentRegistration>>,
    );
}

beforeAll(async () => {
    resetSkillCache();
    await clearOwnRows();
    for (const t of ALL_TENANTS) await seedTenant(t);
    discoveredAgentId = await ingestShadow(T1);
});

afterEach(() => {
    const realDriver = jest.requireActual('@/lib/agentic/agent-driver-policy').resolveDriverForRun;
    const realGate = jest.requireActual('@/lib/agentic/agent-registration-gate').evaluateAgentRegistration;
    jest.mocked(resolveDriverForRun).mockClear().mockImplementation(realDriver);
    jest.mocked(evaluateAgentRegistration).mockClear().mockImplementation(realGate);
    jest.mocked(enqueue).mockClear();
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

describe('a run without its required input is refused before its row exists', () => {
    it.each([
        ['nothing at all', {}],
        ['an empty string', { discoveredAgentId: '' }],
        ['only whitespace', { discoveredAgentId: '   ' }],
        ['a non-string', { discoveredAgentId: 42 }],
    ])('refuses a static run given %s, and writes no run', async (_label, input) => {
        const before = await runsOf(T1);
        await expect(startWorkflowRun(ownerCtx(T1), KEY, input as Record<string, unknown>)).rejects.toThrow(
            /requires a non-empty discoveredAgentId/,
        );
        expect(await runsOf(T1)).toBe(before);
    });

    it('refuses a Flue run the same way — ahead of the driver, the register and the mount gate', async () => {
        asFlue();
        const before = await runsOf(T1);
        await expect(startWorkflowRun(ownerCtx(T1), KEY, {})).rejects.toThrow(/requires a non-empty discoveredAgentId/);
        expect(await runsOf(T1)).toBe(before);
        // Refused at the door: neither the deployment nor the register was asked.
        expect(jest.mocked(resolveDriverForRun)).not.toHaveBeenCalled();
        expect(jest.mocked(evaluateAgentRegistration)).not.toHaveBeenCalled();
        expect(jest.mocked(enqueue)).not.toHaveBeenCalled();
    });
});

describe('the workflow mounts exactly the two IAM skills, through the real mount gate', () => {
    it('pins a Flue run to the two skills, by name, version and hash, and hands it to the worker', async () => {
        asFlue();
        const { runId, status } = await startWorkflowRun(ownerCtx(T1), KEY, { discoveredAgentId });
        expect(status).toBe('RUNNING');
        const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { mountedSkills: true } });
        expect(row.mountedSkills).toEqual(
            ['harness-level-assessment', 'nhi-ownership-attribution'].map((name) => {
                const s = loadSkill(name);
                return { name, version: s.metadata.version, contentHash: skillContentHash(s.instructions) };
            }),
        );
        expect(jest.mocked(enqueue)).toHaveBeenCalledWith('agent-run-execute', { tenantId: T1, runId });
    });

    it('a static run of the same workflow mounts nothing, and records that as an empty list', async () => {
        const { runId } = await startWorkflowRun(ownerCtx(T1), KEY, { discoveredAgentId });
        const row = await prisma.workflowRun.findUniqueOrThrow({ where: { id: runId }, select: { mountedSkills: true } });
        expect(row.mountedSkills).toEqual([]);
    });
});

describe('the facts read', () => {
    it('returns what the scan observed — owner as its source records it, observations as reported — and no level', async () => {
        const facts = await getDiscoveredAgentFacts(ownerCtx(T1), discoveredAgentId);
        expect(facts).toMatchObject({
            discoveredAgentId,
            discoveredId: DISCOVERED_ID,
            discoveredVia: ['entra-sp', 'mcp'],
            registeredAgentId: null,
            sourceOwner: { kind: 'user', ref: OWNER_REF },
            scan: {
                scanRef: `scan-${T1}`,
                asOf: '2026-10-18T03:00:00.000Z',
                // One source capped: the scan says so, and so does every criterion that rests on it.
                completeness: 'INCOMPLETE',
                sources: [
                    { kind: 'entra-sp', status: 'COMPLETE', rows: 10, reason: null },
                    { kind: 'mcp', status: 'INCOMPLETE', rows: 1, reason: 'BYTE_CAP' },
                ],
            },
            reach: 'WRITE_OR_EXTERNAL',
            observations: shadowAgent().verdicts,
            tools: shadowAgent().tools,
        });
        expect(facts).not.toHaveProperty('level');
        expect(facts).not.toHaveProperty('lastLevel');
        expect(facts).not.toHaveProperty('blockingNextRung');
        // Credential references never reach the facts: the ingest stores none.
        expect(JSON.stringify(facts)).not.toContain('kv://prod/agents/review-3668');
    });

    it('is gated on admin.agent_registry: ADMIN reads, EDITOR and READER are refused', async () => {
        await expect(getDiscoveredAgentFacts(roleCtx(T1, 'ADMIN'), discoveredAgentId)).resolves.toMatchObject({ discoveredAgentId });
        for (const role of ['EDITOR', 'READER'] as const) {
            await expect(getDiscoveredAgentFacts(roleCtx(T1, role), discoveredAgentId)).rejects.toThrow(/admin\.agent_registry/);
        }
    });

    it('does not reach across tenants: another tenant’s owner gets not-found', async () => {
        await expect(getDiscoveredAgentFacts(ownerCtx(T2), discoveredAgentId)).rejects.toThrow(/not found/i);
    });

    it('fails closed on stored observations and tools that no longer re-validate', async () => {
        await prisma.agentHarnessScanItem.updateMany({
            where: { tenantId: T1, discoveredAgentId },
            data: { verdictsJson: [{ criterion: 'H9.nonsense', met: true, evidence: 'x' }], toolsJson: { not: 'a list' } },
        });
        try {
            const facts = await getDiscoveredAgentFacts(ownerCtx(T1), discoveredAgentId);
            expect(facts.observations).toBeNull();
            expect(facts.tools).toBeNull();
        } finally {
            await prisma.agentHarnessScanItem.updateMany({
                where: { tenantId: T1, discoveredAgentId },
                data: { verdictsJson: shadowAgent().verdicts as object[], toolsJson: shadowAgent().tools as object[] },
            });
        }
    });
});

describe('the static engine reaches the facts through the real tool funnel', () => {
    it('completes a run for an OWNER, and its synthesis states only what was read', async () => {
        const { runId, status } = await startWorkflowRun(ownerCtx(T1), KEY, { discoveredAgentId });
        expect(status).toBe('COMPLETED');
        const run = await getWorkflowRun(ownerCtx(T1), runId);
        expect(run.summary).toBe(
            `Discovered agent ${DISCOVERED_ID}: 2 criterion observation(s) from scan scan-${T1} (INCOMPLETE). `
            + 'No level and no owner is stated here.',
        );
    });

    it('a run in another tenant cannot read this tenant’s agent — its read step fails', async () => {
        const { runId, status } = await startWorkflowRun(ownerCtx(T2), KEY, { discoveredAgentId });
        expect(status).toBe('FAILED');
        const run = await getWorkflowRun(ownerCtx(T2), runId);
        // The first step — the read — is the one that failed; nothing after it ran.
        expect(run.steps.map((s) => s.status)).toEqual(['FAILED']);
        expect(run.errorMessage).toMatch(/not found/i);
    });
});
