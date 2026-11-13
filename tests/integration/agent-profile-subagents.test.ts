/**
 * INLINE SUB-AGENTS IN THE PROFILE VERSION, through the real usecases and the
 * real database (Step 2e of `docs/claude-tool-runner-design.md`, "Delegation
 * → 1. The model", #4594).
 *
 * A version's sub-agents are data on the version: written by the profile
 * usecase alone, each a subset of the version's tools and skills, sanitised and
 * scanned, encrypted at rest, frozen by the version trigger, and covered by the
 * content hash the approver names and the resolver recomputes. Every rule is a
 * refusal BY NAME, and nothing is stored when one fires.
 *
 * The flag is mocked at the env boundary, and so is the tenant's engine
 * decision (the Tool Runner); the usecases, the resolver, admission and the
 * database are real.
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

import { createHash, randomUUID } from 'crypto';
import { PrismaClient, type Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

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
import { profileRunKey, serializeProfileSubagents } from '@/lib/agentic/agent-profile';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `apsub-${randomUUID().slice(0, 8)}`;
const TA = `ta-${SUITE}`;
const TB = `tb-${SUITE}`;
const USERS = { authorA: `ua-author-${SUITE}`, reviewerA: `ua-reviewer-${SUITE}`, authorB: `ub-author-${SUITE}` };
const AGENTS = {
    refusals: `ag-ref-${SUITE}`,
    hashed: `ag-hash-${SUITE}`,
    frozen: `ag-frozen-${SUITE}`,
    b: `ag-b-${SUITE}`,
};

const ctx = (tenantId: string, role: Role, userId: string, over: Partial<RequestContext> = {}): RequestContext =>
    makeRequestContext(role, { tenantId, tenantSlug: tenantId, userId, ...over });
const authorA = (over: Partial<RequestContext> = {}) => ctx(TA, 'OWNER', USERS.authorA, over);
const reviewerA = () => ctx(TA, 'ADMIN', USERS.reviewerA);
const authorB = (over: Partial<RequestContext> = {}) => ctx(TB, 'OWNER', USERS.authorB, over);

const INSTRUCTIONS = 'Answer questions about the open risks, delegating the reading to the risk reader.';
const SUB_TEXT = 'Read the open risks with list_risks and list each one with its owner.';

type SubInput = NonNullable<AgentProfileVersionInput['subagents']>[number];
const subagent = (over: Partial<SubInput> = {}): SubInput => ({
    name: 'risk_reader',
    instructions: SUB_TEXT,
    toolNames: ['list_risks'],
    skillRefs: [],
    maxTurns: 4,
    ...over,
});
const version = (over: Partial<AgentProfileVersionInput> = {}): AgentProfileVersionInput => ({
    instructions: INSTRUCTIONS,
    toolNames: ['list_risks', 'list_controls'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN', 'ASK'],
    subagents: [subagent()],
    ...over,
});

async function refusalOf(p: Promise<unknown>): Promise<{ reason: string; details: Record<string, unknown> } | 'NO_REFUSAL'> {
    try {
        await p;
    } catch (err) {
        const details = ((err as { details?: Record<string, unknown> }).details ?? {}) as Record<string, unknown>;
        return { reason: typeof details.reason === 'string' ? details.reason : `THREW:${(err as Error).message}`, details };
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

describeFn('inline sub-agents in the profile version (real DB)', () => {
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
        await agent(TA, AGENTS.refusals, USERS.authorA, both);
        await agent(TA, AGENTS.hashed, USERS.authorA, both);
        await agent(TA, AGENTS.frozen, USERS.authorA, both);
        await agent(TB, AGENTS.b, USERS.authorB, both);
    });

    afterAll(async () => {
        await cleanup();
        await prisma.$disconnect();
    });

    it('refuses every rule BY NAME at save, naming the sub-agent and what it named, and stores nothing', async () => {
        const before = await prisma.agentProfileVersion.count({ where: { tenantId: TA } });
        const save = (over: Partial<AgentProfileVersionInput>) => refusalOf(createAgentProfile(authorA(), AGENTS.refusals, version(over)));

        expect(await save({ subagents: ['a1', 'a2', 'a3', 'a4', 'a5'].map((name) => subagent({ name })) })).toEqual({
            reason: 'SUBAGENTS_TOO_MANY',
            details: { reason: 'SUBAGENTS_TOO_MANY', max: 4, count: 5 },
        });
        expect(
            (await save({
                toolNames: undefined,
                flow: { nodes: [{ key: 'r', kind: 'read', label: 'Read', tool: 'list_risks' }], edges: [] },
            })) as { reason: string },
        ).toMatchObject({ reason: 'SUBAGENTS_WITH_FLOW' });
        expect(await save({ subagents: [subagent({ name: 'Risk-Reader' })] })).toMatchObject({
            reason: 'SUBAGENT_NAME_INVALID',
            details: { subagent: 'Risk-Reader' },
        });
        expect(await save({ subagents: [subagent(), subagent()] })).toMatchObject({
            reason: 'SUBAGENT_NAME_DUPLICATE',
            details: { subagent: 'risk_reader' },
        });
        // Sanitised first: markup alone is no instructions.
        expect(await save({ subagents: [subagent({ instructions: '<b></b>  ' })] })).toMatchObject({
            reason: 'SUBAGENT_INSTRUCTIONS_EMPTY',
            details: { subagent: 'risk_reader' },
        });
        expect(await save({ subagents: [subagent({ instructions: 'x'.repeat(16_001) })] })).toMatchObject({
            reason: 'SUBAGENT_INSTRUCTIONS_TOO_LONG',
            details: { subagent: 'risk_reader', maxChars: 16_000 },
        });
        // Text naming a tool outside THIS sub-agent's subset, though inside the version's.
        expect(await save({ subagents: [subagent({ instructions: 'Read them with list_controls instead.' })] })).toMatchObject({
            reason: 'SUBAGENT_INSTRUCTIONS_REFUSED',
            details: { subagent: 'risk_reader', rules: ['skill.undeclared_tool'] },
        });
        expect(await save({ subagents: [subagent({ toolNames: [] })] })).toMatchObject({
            reason: 'SUBAGENT_NAMES_NO_TOOL',
            details: { subagent: 'risk_reader' },
        });
        expect(await save({ subagents: [subagent({ toolNames: ['list_risks', 'list_findings'] })] })).toMatchObject({
            reason: 'SUBAGENT_TOOL_NOT_IN_VERSION',
            details: { subagent: 'risk_reader', tools: ['list_findings'] },
        });
        expect(
            await save({ subagents: [subagent({ skillRefs: [{ origin: 'repository', name: 'nhi-ownership-attribution' }] })] }),
        ).toMatchObject({
            reason: 'SUBAGENT_SKILL_NOT_IN_VERSION',
            details: { subagent: 'risk_reader', skills: ['repository:nhi-ownership-attribution'] },
        });
        expect(await save({ subagents: [subagent({ maxTurns: 11 })] })).toMatchObject({
            reason: 'SUBAGENT_MAX_TURNS_ABOVE_VERSION',
            details: { subagent: 'risk_reader', maxTurns: 11, versionMaxTurns: 10 },
        });

        expect(await prisma.agentProfileVersion.count({ where: { tenantId: TA } })).toBe(before);
        // The positive control: the same body with the rule satisfied saves.
        expect(await save({})).toBe('NO_REFUSAL');
    });

    it('stores the sub-agents encrypted and canonical, and the hash covers every word of them', async () => {
        // Submitted in reverse name order: the stored form, and the hash, do not depend on it.
        const created = await createAgentProfile(
            authorA(),
            AGENTS.hashed,
            version({
                subagents: [
                    subagent({ name: 'risk_reader' }),
                    subagent({ name: 'control_reader', toolNames: ['list_controls'], instructions: 'Read the controls with list_controls.' }),
                ],
            }),
        );
        const [raw] = await prisma.$queryRawUnsafe<Array<{ subagentsJson: string }>>(
            `SELECT "subagentsJson" FROM "AgentProfileVersion" WHERE "id" = $1`,
            created.versionId,
        );
        expect(raw.subagentsJson.startsWith('v2:')).toBe(true);
        expect(raw.subagentsJson).not.toContain('Read the open risks');

        const view = await getAgentProfile(authorA(), AGENTS.hashed);
        const v1 = view.versions.find((v) => v.version === 1)!;
        expect(v1.subagents.map((s) => s.name)).toEqual(['control_reader', 'risk_reader']);
        const stored = serializeProfileSubagents(v1.subagents)!;
        expect(created.instructionsHash).toBe(profileContentHash(INSTRUCTIONS, null, stored));
        expect(created.instructionsHash).not.toBe(profileInstructionsHash(INSTRUCTIONS));

        // Change ONE sub-agent's text and nothing else: a different hash.
        const changed = await createAgentProfileVersion(
            authorA(),
            AGENTS.hashed,
            version({
                subagents: [
                    subagent({ name: 'risk_reader', instructions: `${SUB_TEXT} Keep it short.` }),
                    subagent({ name: 'control_reader', toolNames: ['list_controls'], instructions: 'Read the controls with list_controls.' }),
                ],
            }),
        );
        expect(changed.instructionsHash).not.toBe(created.instructionsHash);

        // A version with none takes the hash it always took, byte for byte.
        const none = await createAgentProfileVersion(authorA(), AGENTS.hashed, version({ subagents: undefined }));
        expect(none.instructionsHash).toBe(createHash('sha256').update(INSTRUCTIONS, 'utf8').digest('hex'));
        const empty = await createAgentProfileVersion(authorA(), AGENTS.hashed, version({ subagents: [] }));
        expect(empty.instructionsHash).toBe(none.instructionsHash);
        const [emptyRow] = await prisma.$queryRawUnsafe<Array<{ subagentsJson: string | null }>>(
            `SELECT "subagentsJson" FROM "AgentProfileVersion" WHERE "id" = $1`,
            empty.versionId,
        );
        expect(emptyRow.subagentsJson).toBeNull();
    });

    it('approval re-checks the sub-agents and audits their names, never their instructions; the resolver compiles them', async () => {
        const created = await createAgentProfile(authorA(), AGENTS.frozen, version());
        await submitAgentProfileVersion(authorA(), AGENTS.frozen, 1);
        await approveAgentProfileVersion(reviewerA(), AGENTS.frozen, 1, { instructionsHash: created.instructionsHash });

        const audit = await prisma.auditLog.findMany({
            where: { tenantId: TA, entityId: created.versionId, action: 'AGENT_PROFILE_APPROVED' },
            select: { detailsJson: true },
        });
        expect(audit).toHaveLength(1);
        const after = (audit[0].detailsJson as { after: Record<string, unknown> }).after;
        expect(after.subagents).toEqual({ count: 1, names: ['risk_reader'], toolNames: { risk_reader: ['list_risks'] } });
        expect(JSON.stringify(audit[0].detailsJson)).not.toContain(SUB_TEXT);

        const key = profileRunKey(created.profileId, 1);
        const { def } = await resolveRunDefinition(authorA({ agentId: AGENTS.frozen }), key, { trigger: 'ASK' });
        expect(def.profile?.subagents).toEqual([
            { name: 'risk_reader', instructions: SUB_TEXT, toolNames: ['list_risks'], skillRefs: [], maxTurns: 4 },
        ]);

        // Admission: a version with sub-agents is never run without them. On an
        // engine that does not run them it is refused before the run row exists.
        expect(
            await refusalOf(startWorkflowRun(authorA({ agentId: AGENTS.frozen }), key, {}, { profileTrigger: 'ASK' })),
        ).toMatchObject({ reason: 'PROFILE_SUBAGENTS_NOT_RUNNABLE' });
        expect(await prisma.workflowRun.count({ where: { tenantId: TA, workflowKey: key } })).toBe(0);
    });

    it('the database freezes an approved version\'s sub-agents for every role; a swapped ciphertext fails the hash', async () => {
        const row = await prisma.agentProfileVersion.findFirstOrThrow({
            where: { tenantId: TA, profile: { agentId: AGENTS.frozen }, version: 1 },
            select: { id: true, profileId: true, status: true },
        });
        expect(row.status).toBe('APPROVED');
        await expect(
            prisma.$executeRawUnsafe(`UPDATE "AgentProfileVersion" SET "subagentsJson" = '[{"name":"x"}]' WHERE "id" = $1`, row.id),
        ).rejects.toThrow(/IMMUTABLE_AGENT_PROFILE_VERSION/);
        await expect(
            prisma.$executeRawUnsafe(`UPDATE "AgentProfileVersion" SET "subagentsJson" = NULL WHERE "id" = $1`, row.id),
        ).rejects.toThrow(/IMMUTABLE_AGENT_PROFILE_VERSION/);

        // The one admitted change, the rotation sweeps' re-wrap, passes the
        // trigger: another version's ciphertext of the same tenant. The
        // recomputed content hash is what refuses it.
        const other = await createAgentProfileVersion(
            authorA(),
            AGENTS.frozen,
            version({ subagents: [subagent({ instructions: `${SUB_TEXT} And their scores.` })] }),
        );
        await prisma.$executeRawUnsafe(
            `UPDATE "AgentProfileVersion" SET "subagentsJson" = (SELECT "subagentsJson" FROM "AgentProfileVersion" WHERE "id" = $2) WHERE "id" = $1`,
            row.id,
            other.versionId,
        );
        expect(
            await refusalOf(resolveRunDefinition(authorA({ agentId: AGENTS.frozen }), profileRunKey(row.profileId, 1), { trigger: 'ASK' })),
        ).toMatchObject({ reason: 'PROFILE_HASH_MISMATCH' });
    });

    it('another tenant cannot resolve, read or name a sub-agent of this tenant\'s version (two tenants)', async () => {
        const a = await prisma.agentProfile.findFirstOrThrow({ where: { tenantId: TA, agentId: AGENTS.hashed }, select: { id: true } });
        // B resolving A's key reads nothing: the key names no profile in B.
        expect(
            await refusalOf(resolveRunDefinition(authorB({ agentId: AGENTS.b }), profileRunKey(a.id, 1), { trigger: 'ASK' })),
        ).toMatchObject({ reason: 'PROFILE_NOT_FOUND' });
        // B's own version with a sub-agent is B's alone, and A's text is in none of B's reads.
        await createAgentProfile(authorB(), AGENTS.b, version({ subagents: [subagent({ name: 'b_reader' })] }));
        const viewB = await getAgentProfile(authorB(), AGENTS.b);
        expect(viewB.versions.flatMap((v) => v.subagents.map((s) => s.name))).toEqual(['b_reader']);
        expect(JSON.stringify(viewB)).not.toContain('control_reader');
        // A's view never shows B's.
        const viewA = await getAgentProfile(authorA(), AGENTS.hashed);
        expect(JSON.stringify(viewA)).not.toContain('b_reader');
    });
});
