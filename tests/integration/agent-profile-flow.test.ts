/**
 * THE FLOW INSIDE THE PROFILE VERSION, through the real usecases and the real
 * database (Phase 1 of `docs/ai-architecture/langflow.md`).
 *
 * A drawn flow is data on an `AgentProfileVersion`: written by the profile
 * usecase and nowhere else, its tools derived from it and held to the agent's
 * grants, sanitised, encrypted at rest, frozen by the version trigger, and
 * covered by the content hash the approver names and the resolver recomputes.
 *
 * The flag is mocked at the env boundary, as `agent-profiles.test.ts` does, and
 * so is the tenant's engine decision (the Tool Runner, the one engine that runs
 * profiles); the usecases, the resolver, admission and the database are real.
 */
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get: (target, key) => (key === 'AGENT_PROFILES' ? '1' : Reflect.get(target, key)),
        }),
    };
});

jest.mock('@/lib/agentic/agent-driver-policy', () => ({
    ...jest.requireActual('@/lib/agentic/agent-driver-policy'),
    resolveDriverForRun: jest.fn(async () => ({ driver: 'tool-runner', reason: null })),
}));

import { PrismaClient, type Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import {
    approveAgentProfileVersion,
    createAgentProfile,
    createAgentProfileVersion,
    getAgentProfile,
    profileContentHash,
    profileInstructionsHash,
    submitAgentProfileVersion,
} from '@/app-layer/usecases/agent-profiles';
import { resolveRunDefinition } from '@/app-layer/usecases/agent-profile-runs';
import { startWorkflowRun } from '@/app-layer/usecases/workflow-runs';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import { profileRunKey } from '@/lib/agentic/agent-profile';
import { serializeAgentFlow } from '@/lib/agentic/agent-flow';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `apflow-${randomUUID().slice(0, 8)}`;
const TA = `ta-${SUITE}`;
const TB = `tb-${SUITE}`;
const USERS = { authorA: `ua-author-${SUITE}`, reviewerA: `ua-reviewer-${SUITE}`, authorB: `ub-author-${SUITE}`, reviewerB: `ub-reviewer-${SUITE}` };
const AGENTS = {
    flow: `ag-flow-${SUITE}`,
    proposer: `ag-prop-${SUITE}`,
    sub: `ag-sub-${SUITE}`,
    delegator: `ag-dele-${SUITE}`,
    tamper: `ag-tamper-${SUITE}`,
    runner: `ag-runner-${SUITE}`,
    rater: `ag-rater-${SUITE}`,
    b: `ag-b-${SUITE}`,
};

const ctx = (tenantId: string, role: Role, userId: string, over: Partial<RequestContext> = {}): RequestContext =>
    makeRequestContext(role, { tenantId, tenantSlug: tenantId, userId, ...over });
const authorA = (over: Partial<RequestContext> = {}) => ctx(TA, 'OWNER', USERS.authorA, over);
const reviewerA = (over: Partial<RequestContext> = {}) => ctx(TA, 'ADMIN', USERS.reviewerA, over);
const authorB = () => ctx(TB, 'OWNER', USERS.authorB);
const reviewerB = () => ctx(TB, 'ADMIN', USERS.reviewerB);

const INSTRUCTIONS = 'Summarise the open risks and controls for the weekly review, grouped by owner.';

const READ_FLOW = {
    nodes: [
        { key: 'risks', kind: 'read', label: 'Gather the open <b>risks</b>', tool: 'list_risks' },
        { key: 'controls', kind: 'read', label: 'Gather the controls', tool: 'list_controls' },
        { key: 'answer', kind: 'synthesis', label: 'Summarise by owner' },
    ],
    edges: [
        { from: 'risks', to: 'answer' },
        { from: 'controls', to: 'answer' },
    ],
};

const version = (over: Partial<AgentProfileVersionInput> = {}): AgentProfileVersionInput => ({
    instructions: INSTRUCTIONS,
    flow: READ_FLOW,
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN', 'ASK'],
    ...over,
});
const plainVersion = (over: Partial<AgentProfileVersionInput> = {}): AgentProfileVersionInput => {
    const { flow: _flow, ...rest } = version(over);
    return { ...rest, toolNames: ['list_risks'] };
};

async function reasonOf(p: Promise<unknown>): Promise<string> {
    try {
        await p;
    } catch (err) {
        const reason = (err as { details?: { reason?: unknown } }).details?.reason;
        return typeof reason === 'string' ? reason : `THREW:${(err as Error).message}`;
    }
    return 'NO_REFUSAL';
}

async function cleanup(): Promise<void> {
    const tenants = [TA, TB];
    await prisma.workflowStep.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => {});
    await prisma.workflowRun.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => {});
    await prisma.agentProfileVersion.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => {});
    await prisma.agentProfile.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => {});
    await prisma.registeredAgentTool.deleteMany({ where: { tenantId: { in: tenants } } }).catch(() => {});
    await deleteAuditRowsForTenants(prisma, tenants).catch(() => {});
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "RegisteredAgent" WHERE "tenantId" = ANY($1::text[])`, tenants);
        await tx.$executeRawUnsafe(`DELETE FROM "AiSystem" WHERE "tenantId" = ANY($1::text[])`, tenants);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, tenants);
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tenants } } });
    await prisma.user.deleteMany({ where: { id: { in: Object.values(USERS) } } });
}

/** Create, submit and approve version 1 of `agentId`'s profile; returns the created version. */
async function approved(tenant: 'A' | 'B', agentId: string, input: AgentProfileVersionInput) {
    const [author, reviewer] = tenant === 'A' ? [authorA(), reviewerA()] : [authorB(), reviewerB()];
    const created = await createAgentProfile(author, agentId, input);
    await submitAgentProfileVersion(author, agentId, 1);
    await approveAgentProfileVersion(reviewer, agentId, 1, { instructionsHash: created.instructionsHash });
    return created;
}

describeFn('the flow inside the profile version (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        for (const t of [TA, TB]) await createTenantWithDek({ id: t, name: t, slug: t });
        const member = async (tenantId: string, id: string, role: Role) => {
            const email = `${id}@example.test`;
            await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
            await prisma.tenantMembership.create({ data: { tenantId, userId: id, role, status: 'ACTIVE' } });
        };
        await member(TA, USERS.authorA, 'OWNER');
        await member(TA, USERS.reviewerA, 'ADMIN');
        await member(TB, USERS.authorB, 'OWNER');
        await member(TB, USERS.reviewerB, 'ADMIN');
        const agent = async (tenantId: string, id: string, owner: string, tools: string[]) => {
            const sys = await prisma.aiSystem.create({ data: { tenantId, name: `sys-${id}` } });
            await prisma.registeredAgent.create({
                data: {
                    id,
                    tenantId,
                    aiSystemId: sys.id,
                    name: `agent ${id}`,
                    autonomyLevel: 2,
                    dataAccessScope: 'READ_TENANT_DATA',
                    reversibility: 'REVERSIBLE',
                    provenance: 'FIRST_PARTY',
                    ownerUserId: owner,
                    status: 'ACTIVE',
                },
            });
            for (const toolName of tools) {
                await prisma.registeredAgentTool.create({ data: { tenantId, agentId: id, toolName, grantedByUserId: owner } });
            }
        };
        const both = ['list_risks', 'list_controls'];
        await agent(TA, AGENTS.flow, USERS.authorA, both);
        await agent(TA, AGENTS.proposer, USERS.authorA, [...both, 'propose_risks']);
        await agent(TA, AGENTS.sub, USERS.authorA, ['list_risks']);
        await agent(TA, AGENTS.delegator, USERS.authorA, both);
        await agent(TA, AGENTS.tamper, USERS.authorA, both);
        await agent(TA, AGENTS.runner, USERS.authorA, both);
        await agent(TA, AGENTS.rater, USERS.authorA, ['list_risks']);
        await agent(TB, AGENTS.b, USERS.authorB, ['list_risks']);
    });

    afterAll(async () => {
        await cleanup();
        await prisma.$disconnect();
    });

    it('a version with a flow is created, approved by a second person and resolved through its run key', async () => {
        const created = await approved('A', AGENTS.flow, version());
        const row = await prisma.agentProfileVersion.findUniqueOrThrow({
            where: { id: created.versionId },
            select: { toolNames: true, flowJson: true, instructionsHash: true },
        });
        // The tools are the flow's, derived: never entered beside it.
        expect(row.toolNames).toEqual(['list_controls', 'list_risks']);
        // The hash covers the flow, so it is not the instructions' hash.
        expect(row.instructionsHash).not.toBe(profileInstructionsHash(INSTRUCTIONS));

        const raw = await prisma.$queryRawUnsafe<Array<{ flowJson: string }>>(
            `SELECT "flowJson" FROM "AgentProfileVersion" WHERE "id" = $1`,
            created.versionId,
        );
        expect(raw[0].flowJson.startsWith('v2:')).toBe(true);
        expect(raw[0].flowJson).not.toContain('Gather');

        // Read back decrypted, through the usecase: labels are sanitised
        // before they are stored and hashed, and the hash is over exactly the
        // stored, canonical flow.
        const view = await getAgentProfile(authorA(), AGENTS.flow);
        const stored = view.versions[0].flow;
        expect(stored?.nodes.map((n) => n.label)).toEqual(['Gather the open risks', 'Gather the controls', 'Summarise by owner']);
        expect(row.instructionsHash).toBe(profileContentHash(INSTRUCTIONS, serializeAgentFlow(stored!)));

        const key = profileRunKey(created.profileId, 1);
        const { def } = await resolveRunDefinition(authorA({ agentId: AGENTS.flow }), key, { trigger: 'ASK' });
        expect(def.profile?.toolNames).toEqual(['list_controls', 'list_risks']);
        expect(def.profile?.flow?.stepsSpec.map((s) => s.label)).toEqual([
            'Gather the open risks',
            'Gather the controls',
            'Summarise by owner',
        ]);
        expect(stored?.nodes.map((n) => n.key)).toEqual(['risks', 'controls', 'answer']);
    });

    it('the flow the Behaviour tab reads back is accepted unchanged as the next version\'s flow (#5374)', async () => {
        // The editor carries a version's flow through an edit by posting the
        // flow the view returned, in place of a tool list. That is only sound
        // if the stored, sanitised flow is a valid save body as it stands.
        const view = await getAgentProfile(authorA(), AGENTS.flow);
        const from = view.versions.find((v) => v.flow !== null)!;
        const next = await createAgentProfileVersion(
            authorA(),
            AGENTS.flow,
            version({ instructions: `${INSTRUCTIONS} Keep it short.`, flow: from.flow }),
        );
        const after = (await getAgentProfile(authorA(), AGENTS.flow)).versions.find((v) => v.version === next.version)!;
        expect(after.flow).toEqual(from.flow);
        expect(after.toolNames).toEqual(from.toolNames);
    });

    it('a flow version is admitted on no engine before Phase 5, and no run row is written', async () => {
        // A subagent step is the case that matters: no engine can hand work to
        // another profile, so running it would record a delegation that never
        // happened. Every flow is refused, so no drawn step is ever a line the
        // model cannot act on.
        const rater = await approved('A', AGENTS.rater, plainVersion());
        const target = await approved('A', AGENTS.runner, plainVersion());
        const flowVersion = await createAgentProfileVersion(
            authorA(),
            AGENTS.runner,
            version({
                flow: {
                    nodes: [
                        { key: 'risks', kind: 'read', label: 'Gather risks', tool: 'list_risks' },
                        { key: 'rate', kind: 'subagent', label: 'Ask the risk agent to rate each risk', profileRef: rater.profileId },
                    ],
                    edges: [{ from: 'risks', to: 'rate' }],
                },
            }),
        );
        await submitAgentProfileVersion(authorA(), AGENTS.runner, 2);
        await approveAgentProfileVersion(reviewerA(), AGENTS.runner, 2, { instructionsHash: flowVersion.instructionsHash });
        const key = profileRunKey(target.profileId, 2);

        // It resolves: created, approved by a second person, and compiled.
        const { def } = await resolveRunDefinition(authorA({ agentId: AGENTS.runner }), key, { trigger: 'ASK' });
        expect(def.profile?.flow?.stepsSpec.map((s) => s.kind)).toEqual(['READ', 'SUBAGENT']);
        // It does not run, on the one engine that runs profiles.
        expect(await reasonOf(startWorkflowRun(authorA({ agentId: AGENTS.runner }), key, {}, { profileTrigger: 'ASK' }))).toBe('PROFILE_FLOW_NOT_RUNNABLE');
        expect(await prisma.workflowRun.count({ where: { tenantId: TA, workflowKey: key } })).toBe(0);
    });

    it('a flow with no propose node runs read-only, even when the version may propose', async () => {
        const readOnly = await approved('A', AGENTS.proposer, version({ outputKind: 'ANSWER_AND_PROPOSALS' }));
        const first = await resolveRunDefinition(authorA({ agentId: AGENTS.proposer }), profileRunKey(readOnly.profileId, 1), { trigger: 'ASK' });
        expect(first.def.readOnly).toBe(true);

        const proposing = await createAgentProfileVersion(
            authorA(),
            AGENTS.proposer,
            version({
                outputKind: 'ANSWER_AND_PROPOSALS',
                flow: {
                    nodes: [
                        { key: 'risks', kind: 'read', label: 'Gather risks', tool: 'list_risks' },
                        { key: 'new', kind: 'propose', label: 'Propose the missing risks', tool: 'propose_risks' },
                    ],
                    edges: [{ from: 'risks', to: 'new' }],
                },
            }),
        );
        await submitAgentProfileVersion(authorA(), AGENTS.proposer, 2);
        await approveAgentProfileVersion(reviewerA(), AGENTS.proposer, 2, { instructionsHash: proposing.instructionsHash });
        const second = await resolveRunDefinition(authorA({ agentId: AGENTS.proposer }), profileRunKey(proposing.profileId, 2), { trigger: 'ASK' });
        expect(second.def.readOnly).toBeUndefined();
        expect(second.def.profile?.toolNames).toEqual(['list_risks', 'propose_risks']);

        // A propose step in a version that answers only would never run: refused.
        expect(
            await reasonOf(
                createAgentProfileVersion(
                    authorA(),
                    AGENTS.proposer,
                    version({ outputKind: 'ANSWER_ONLY', flow: { nodes: [{ key: 'p', kind: 'propose', label: 'p', tool: 'propose_risks' }], edges: [] } }),
                ),
            ),
        ).toBe('FLOW_OUTPUT_KIND_CONFLICT');
    });

    it('a flow cannot offer a tool the agent is not granted', async () => {
        const before = await prisma.agentProfileVersion.count({ where: { tenantId: TA } });
        let details: unknown;
        try {
            await createAgentProfileVersion(
                authorA(),
                AGENTS.flow,
                version({
                    flow: {
                        nodes: [
                            { key: 'risks', kind: 'read', label: 'Gather risks', tool: 'list_risks' },
                            { key: 'findings', kind: 'read', label: 'Gather findings', tool: 'list_findings' },
                        ],
                        edges: [],
                    },
                }),
            );
        } catch (err) {
            details = (err as { details?: unknown }).details;
        }
        expect(details).toEqual({ reason: 'TOOL_NOT_GRANTED', tools: ['list_findings'] });
        expect(await prisma.agentProfileVersion.count({ where: { tenantId: TA } })).toBe(before);
    });

    it('a cycle is refused at save, and nothing is stored', async () => {
        const before = await prisma.agentProfileVersion.count({ where: { tenantId: TA } });
        const cyclic = {
            nodes: [
                { key: 'a', kind: 'read', label: 'a', tool: 'list_risks' },
                { key: 'b', kind: 'synthesis', label: 'b' },
            ],
            edges: [
                { from: 'a', to: 'b' },
                { from: 'b', to: 'a' },
            ],
        };
        expect(await reasonOf(createAgentProfileVersion(authorA(), AGENTS.flow, version({ flow: cyclic })))).toBe('FLOW_CYCLE');
        const checkpoint = { nodes: [...READ_FLOW.nodes, { key: 'gate', kind: 'checkpoint', label: 'a human approves' }], edges: [] };
        expect(await reasonOf(createAgentProfileVersion(authorA(), AGENTS.flow, version({ flow: checkpoint })))).toBe(
            'FLOW_CHECKPOINT_UNENFORCED',
        );
        expect(await prisma.agentProfileVersion.count({ where: { tenantId: TA } })).toBe(before);
    });

    it('a tampered flow fails the hash, at approval and at the resolver', async () => {
        const good = await approved('A', AGENTS.tamper, version());
        const other = await createAgentProfileVersion(
            authorA(),
            AGENTS.tamper,
            version({ flow: { ...READ_FLOW, nodes: READ_FLOW.nodes.map((n) => ({ ...n, label: `${n.label} differently` })) } }),
        );
        await submitAgentProfileVersion(authorA(), AGENTS.tamper, 2);
        const [goodCipher] = await prisma.$queryRawUnsafe<Array<{ flowJson: string }>>(
            `SELECT "flowJson" FROM "AgentProfileVersion" WHERE "id" = $1`,
            good.versionId,
        );
        // The trigger admits one change to a version: ciphertext to v2
        // ciphertext with every other column unchanged, for the rotation
        // sweeps. Another version's ciphertext of the same tenant passes it,
        // so the recomputed content hash is what refuses the swap.
        await prisma.$executeRawUnsafe(
            `UPDATE "AgentProfileVersion" SET "flowJson" = (SELECT "flowJson" FROM "AgentProfileVersion" WHERE "id" = $2) WHERE "id" = $1`,
            good.versionId,
            other.versionId,
        );
        expect(await reasonOf(resolveRunDefinition(authorA({ agentId: AGENTS.tamper }), profileRunKey(good.profileId, 1), { trigger: 'ASK' }))).toBe(
            'PROFILE_HASH_MISMATCH',
        );
        await prisma.$executeRawUnsafe(
            `UPDATE "AgentProfileVersion" SET "flowJson" = $2 WHERE "id" = $1`,
            other.versionId,
            goodCipher.flowJson,
        );
        expect(
            await reasonOf(approveAgentProfileVersion(reviewerA(), AGENTS.tamper, 2, { instructionsHash: other.instructionsHash })),
        ).toBe('HASH_CHANGED');
    });

    it('the database freezes a flow for every role, the table owner included', async () => {
        const row = await prisma.agentProfileVersion.findFirstOrThrow({ where: { tenantId: TA }, select: { id: true } });
        await expect(
            prisma.$executeRawUnsafe(`UPDATE "AgentProfileVersion" SET "flowJson" = '{"nodes":[],"edges":[]}' WHERE "id" = $1`, row.id),
        ).rejects.toThrow(/IMMUTABLE_AGENT_PROFILE_VERSION/);
        await expect(
            prisma.$executeRawUnsafe(`UPDATE "AgentProfileVersion" SET "flowJson" = NULL WHERE "id" = $1`, row.id),
        ).rejects.toThrow(/IMMUTABLE_AGENT_PROFILE_VERSION/);
    });

    it("a subagent step names an approved profile of this workspace, never another tenant's", async () => {
        const target = await approved('A', AGENTS.sub, plainVersion());
        const foreign = await approved('B', AGENTS.b, plainVersion());
        const flowTo = (profileRef: string) => ({
            nodes: [
                { key: 'risks', kind: 'read', label: 'Gather risks', tool: 'list_risks' },
                { key: 'delegate', kind: 'subagent', label: 'Ask the risk agent', profileRef },
            ],
            edges: [{ from: 'risks', to: 'delegate' }],
        });

        let details: unknown;
        try {
            await createAgentProfile(authorA(), AGENTS.delegator, version({ flow: flowTo(foreign.profileId) }));
        } catch (err) {
            details = (err as { details?: unknown }).details;
        }
        expect(details).toEqual({ reason: 'FLOW_SUBAGENT_NOT_APPROVED', profiles: [foreign.profileId] });
        expect(await prisma.agentProfile.count({ where: { tenantId: TA, agentId: AGENTS.delegator } })).toBe(0);

        const created = await createAgentProfile(authorA(), AGENTS.delegator, version({ flow: flowTo(target.profileId) }));
        expect(created.version).toBe(1);
        // A profile cannot hand its own work to itself.
        expect(
            await reasonOf(createAgentProfileVersion(authorA(), AGENTS.delegator, version({ flow: flowTo(created.profileId) }))),
        ).toBe('FLOW_SUBAGENT_SELF');
    });
});
