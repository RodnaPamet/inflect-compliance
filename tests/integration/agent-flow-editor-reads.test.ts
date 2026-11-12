/**
 * THE FLOW EDITOR'S SERVER SIDE, through the real usecases and database
 * (Phases 3 and 4 of `docs/ai-architecture/langflow.md`).
 *
 * The editor adds two reads and no write: the subagent picker
 * (`listFlowSubagentOptions`) and the Compiled panel's preview
 * (`previewProfileRunMessage`). Its one write is the existing version usecase,
 * called with the body the editor builds. So this file proves the preview is
 * the engine's message byte for byte, the picker offers only what the save
 * accepts, and an EDITOR can read nothing and save nothing here.
 */
jest.mock('@/env', () => {
    const actual = jest.requireActual('@/env') as { env: Record<string, unknown> };
    return {
        env: new Proxy(actual.env, {
            get: (target, key) => (key === 'AGENT_PROFILES' ? '1' : Reflect.get(target, key)),
        }),
    };
});

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
    listFlowSubagentOptions,
    submitAgentProfileVersion,
} from '@/app-layer/usecases/agent-profiles';
import {
    assertEngineRunsProfiles,
    previewProfileRunMessage,
    resolveRunDefinition,
} from '@/app-layer/usecases/agent-profile-runs';
import { AGENT_DRIVERS } from '@/lib/agentic/agent-driver';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import { profileRunKey } from '@/lib/agentic/agent-profile';
import type { AgentFlow } from '@/lib/agentic/agent-flow';
import { runMessage } from '@/lib/agentic/flue/run-message';
import { draftFromFlow, flowVersionBody } from '@/lib/processes/agent-flow/agent-flow-document';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `afed-${randomUUID().slice(0, 8)}`;
const TA = `ta-${SUITE}`;
const TB = `tb-${SUITE}`;
const USERS = {
    author: `ua-author-${SUITE}`,
    reviewer: `ua-reviewer-${SUITE}`,
    editor: `ua-editor-${SUITE}`,
    authorB: `ub-author-${SUITE}`,
    reviewerB: `ub-reviewer-${SUITE}`,
};
const AGENTS = { ed: `ag-ed-${SUITE}`, sub: `ag-sub-${SUITE}`, b: `ag-b-${SUITE}` };

const ctx = (tenantId: string, role: Role, userId: string): RequestContext =>
    makeRequestContext(role, { tenantId, tenantSlug: tenantId, userId });
const author = () => ctx(TA, 'OWNER', USERS.author);
const reviewer = () => ctx(TA, 'ADMIN', USERS.reviewer);
const editor = () => ctx(TA, 'EDITOR', USERS.editor);

const FLOW: AgentFlow = {
    nodes: [
        { key: 'risks', kind: 'read', label: 'Gather the open risks', tool: 'list_risks' },
        { key: 'controls', kind: 'read', label: 'Gather the controls', tool: 'list_controls' },
        { key: 'answer', kind: 'synthesis', label: 'Summarise by owner' },
    ],
    edges: [
        { from: 'risks', to: 'answer' },
        { from: 'controls', to: 'answer' },
    ],
};

const BASE = {
    instructions: 'Summarise the open risks and controls for the weekly review.',
    skillRefs: [] as Array<{ origin: 'repository' | 'tenant'; name: string }>,
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN', 'ASK'],
};
const plain = (): AgentProfileVersionInput => ({
    ...(BASE as Omit<AgentProfileVersionInput, 'toolNames' | 'flow'>),
    toolNames: ['list_risks'],
});

async function cleanup(): Promise<void> {
    const tenants = [TA, TB];
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

async function approvedV1(a: RequestContext, r: RequestContext, agentId: string, input: AgentProfileVersionInput) {
    const created = await createAgentProfile(a, agentId, input);
    await submitAgentProfileVersion(a, agentId, 1);
    await approveAgentProfileVersion(r, agentId, 1, { instructionsHash: created.instructionsHash });
    return created;
}

describeFn('the flow editor’s reads, and its one write (real DB)', () => {
    let edProfileId = '';
    let subProfileId = '';

    beforeAll(async () => {
        await prisma.$connect();
        await cleanup();
        for (const t of [TA, TB]) await createTenantWithDek({ id: t, name: t, slug: t });
        const member = async (tenantId: string, id: string, role: Role) => {
            const email = `${id}@example.test`;
            await prisma.user.create({ data: { id, email, emailHash: hashForLookup(email) } });
            await prisma.tenantMembership.create({ data: { tenantId, userId: id, role, status: 'ACTIVE' } });
        };
        await member(TA, USERS.author, 'OWNER');
        await member(TA, USERS.reviewer, 'ADMIN');
        await member(TA, USERS.editor, 'EDITOR');
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
        await agent(TA, AGENTS.ed, USERS.author, ['list_risks', 'list_controls']);
        await agent(TA, AGENTS.sub, USERS.author, ['list_risks']);
        await agent(TB, AGENTS.b, USERS.authorB, ['list_risks']);

        edProfileId = (await approvedV1(author(), reviewer(), AGENTS.ed, { ...plain(), toolNames: undefined, flow: FLOW } as AgentProfileVersionInput)).profileId;
        subProfileId = (await approvedV1(author(), reviewer(), AGENTS.sub, plain())).profileId;
        await approvedV1(ctx(TB, 'OWNER', USERS.authorB), ctx(TB, 'ADMIN', USERS.reviewerB), AGENTS.b, plain());
    });

    afterAll(async () => {
        await cleanup();
        await prisma.$disconnect();
    });

    it('the Compiled panel’s message equals the engine’s, byte for byte', async () => {
        const preview = await previewProfileRunMessage(author(), AGENTS.ed, 1);
        expect(preview.state).toBe('SHOWN');
        if (preview.state !== 'SHOWN') return;
        expect(preview.runAs).toBe('RUN');
        // In force, yet no run receives it: admission refuses a flow version
        // on every engine until Phase 5, and the panel must say so.
        expect(preview.runRefused).toBe('PROFILE_FLOW_NOT_RUNNABLE');
        const { def } = await resolveRunDefinition(author(), profileRunKey(edProfileId, 1), { trigger: 'ASK' });
        for (const driver of AGENT_DRIVERS) {
            expect(() => assertEngineRunsProfiles(driver, def.profile!)).toThrow();
        }
        expect(preview.message).toBe(runMessage(def, 0));
        // And it is the flow's specification, steps in run order.
        expect(preview.message).toContain('1. [READ] Gather the open risks (tool: list_risks)');
        expect(preview.message).toContain('3. [SYNTHESIS] Summarise by owner');
        expect(preview.readOnly).toBe(true);
    });

    it('a version that does not exist on this agent has no preview', async () => {
        expect((await previewProfileRunMessage(author(), AGENTS.ed, 99)).state).toBe('NOT_FOUND');
    });

    it('the subagent picker offers approved profiles in this workspace, never the agent’s own nor another tenant’s', async () => {
        const options = await listFlowSubagentOptions(author(), AGENTS.ed);
        const ids = options.map((o) => o.profileId);
        expect(ids).toContain(subProfileId);
        expect(ids).not.toContain(edProfileId);
        expect(options.every((o) => o.agentName.startsWith('agent ag-') && !o.agentName.includes('ag-b-'))).toBe(true);
    });

    it('an EDITOR without the register key reads nothing here and saves nothing', async () => {
        const status = async (p: Promise<unknown>) => p.then(() => 200, (e: { status?: number }) => e.status ?? 500);
        expect(await status(previewProfileRunMessage(editor(), AGENTS.ed, 1))).toBe(403);
        expect(await status(listFlowSubagentOptions(editor(), AGENTS.ed))).toBe(403);
        const body = flowVersionBody(BASE, draftFromFlow(FLOW)) as AgentProfileVersionInput;
        expect(await status(createAgentProfileVersion(editor(), AGENTS.ed, body))).toBe(403);
        expect(await prisma.agentProfileVersion.count({ where: { tenantId: TA, profileId: edProfileId } })).toBe(1);
    });

    it('a canvas save is a new DRAFT version through the profile usecase, its tools derived, and audited', async () => {
        const draft = draftFromFlow(FLOW);
        draft.nodes[0].label = 'Gather every open risk';
        const body = flowVersionBody(BASE, draft) as AgentProfileVersionInput;
        const created = await createAgentProfileVersion(author(), AGENTS.ed, body);
        expect(created.version).toBe(2);
        const row = await prisma.agentProfileVersion.findUniqueOrThrow({ where: { id: created.versionId } });
        expect(row.status).toBe('DRAFT');
        expect([...row.toolNames].sort()).toEqual(['list_controls', 'list_risks']);
        const audit = await prisma.auditLog.findFirst({
            where: { tenantId: TA, entityId: created.versionId, action: 'AGENT_PROFILE_VERSION_CREATED' },
        });
        expect(audit).not.toBeNull();
        expect(JSON.stringify(audit?.detailsJson)).toContain(edProfileId);
        // A draft has no run, but the panel still shows the message it would send.
        const preview = await previewProfileRunMessage(author(), AGENTS.ed, 2);
        expect(preview.state === 'SHOWN' && preview.runAs).toBeNull();
        expect(preview.state === 'SHOWN' && preview.message).toContain('Gather every open risk');
    });
});
