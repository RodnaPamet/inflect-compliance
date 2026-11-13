/**
 * A PROFILE VERSION'S COMPACTION THRESHOLD, through the real usecases and the
 * real database (Step 2g of `docs/claude-tool-runner-design.md`,
 * "Compaction", owner decision 2 of 2026-11-13, #5531).
 *
 * A version may turn the engine's compaction off (`0`) or lower its threshold,
 * and never raise it: refused BY NAME at save and again at approval, held by a
 * CHECK, frozen with the rest of the version by its trigger, shown to the
 * approver, compiled into the run definition, and kept out of the content
 * hash. Two tenants: one tenant's setting is never read or resolved by
 * another.
 *
 * The flag is mocked at the env boundary; the usecases, the resolver and the
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

import { randomUUID } from 'crypto';
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
    submitAgentProfileVersion,
} from '@/app-layer/usecases/agent-profiles';
import { resolveRunDefinition } from '@/app-layer/usecases/agent-profile-runs';
import type { AgentProfileVersionInput } from '@/app-layer/schemas/agent-profile.schemas';
import { AgentProfileVersionSchema } from '@/app-layer/schemas/agent-profile.schemas';
import { profileRunKey } from '@/lib/agentic/agent-profile';
import * as toolRunnerParams from '@/lib/agentic/tool-runner/params';
import type { RequestContext } from '@/app-layer/types';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `apcmp-${randomUUID().slice(0, 8)}`;
const TA = `ta-${SUITE}`;
const TB = `tb-${SUITE}`;
const USERS = { authorA: `ua-author-${SUITE}`, reviewerA: `ua-reviewer-${SUITE}`, authorB: `ub-author-${SUITE}` };
const AGENTS = { refusals: `ag-ref-${SUITE}`, approved: `ag-appr-${SUITE}`, b: `ag-b-${SUITE}` };

const ctx = (tenantId: string, role: Role, userId: string, over: Partial<RequestContext> = {}): RequestContext =>
    makeRequestContext(role, { tenantId, tenantSlug: tenantId, userId, ...over });
const authorA = (over: Partial<RequestContext> = {}) => ctx(TA, 'OWNER', USERS.authorA, over);
const reviewerA = () => ctx(TA, 'ADMIN', USERS.reviewerA);
const authorB = (over: Partial<RequestContext> = {}) => ctx(TB, 'OWNER', USERS.authorB, over);

const version = (over: Partial<AgentProfileVersionInput> = {}): AgentProfileVersionInput => ({
    instructions: 'Answer questions about the open risks.',
    toolNames: ['list_risks'],
    skillRefs: [],
    modelTier: 'balanced',
    effort: 'medium',
    maxTurns: 10,
    outputKind: 'ANSWER_ONLY',
    allowedTriggers: ['TEST_RUN', 'ASK'],
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

describeFn('a profile version\'s compaction threshold (real DB)', () => {
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
        const agent = async (tenantId: string, id: string, owner: string) => {
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
            await prisma.registeredAgentTool.create({ data: { tenantId, agentId: id, toolName: 'list_risks', grantedByUserId: owner } });
        };
        await agent(TA, AGENTS.refusals, USERS.authorA);
        await agent(TA, AGENTS.approved, USERS.authorA);
        await agent(TB, AGENTS.b, USERS.authorB);
    });

    afterAll(async () => {
        await cleanup();
        await prisma.$disconnect();
    });

    it('a version may lower the threshold or turn it off, and never raise it: refused BY NAME at save, nothing stored', async () => {
        const before = await prisma.agentProfileVersion.count({ where: { tenantId: TA } });
        expect(await refusalOf(createAgentProfile(authorA(), AGENTS.refusals, version({ compactionThresholdTokens: 150_001 })))).toEqual({
            reason: 'COMPACTION_THRESHOLD_ABOVE_TIER',
            details: { reason: 'COMPACTION_THRESHOLD_ABOVE_TIER', tier: 'balanced', max: 150_000, value: 150_001 },
        });
        expect(await refusalOf(createAgentProfile(authorA(), AGENTS.refusals, version({ compactionThresholdTokens: 9_999 })))).toMatchObject({
            reason: 'COMPACTION_THRESHOLD_BELOW_MINIMUM',
        });
        expect(await prisma.agentProfileVersion.count({ where: { tenantId: TA } })).toBe(before);
        // The schema bounds the body loosely, so the refusal by name is what an over-tier value meets.
        expect(AgentProfileVersionSchema.safeParse(version({ compactionThresholdTokens: 150_001 })).success).toBe(true);
        expect(AgentProfileVersionSchema.safeParse(version({ compactionThresholdTokens: -1 })).success).toBe(false);

        // Off, a lower value, the tier's own and the engine's default all save.
        await createAgentProfile(authorA(), AGENTS.refusals, version({ compactionThresholdTokens: 0 }));
        for (const value of [12_000, 150_000, null]) {
            await createAgentProfileVersion(authorA(), AGENTS.refusals, version({ compactionThresholdTokens: value }));
        }
        const stored = await prisma.agentProfileVersion.findMany({
            where: { tenantId: TA, profile: { agentId: AGENTS.refusals } },
            orderBy: { version: 'asc' },
            select: { compactionThresholdTokens: true },
        });
        expect(stored.map((r) => r.compactionThresholdTokens)).toEqual([0, 12_000, 150_000, null]);
    });

    it('the CHECK holds the bounds for every writer', async () => {
        const row = await prisma.agentProfileVersion.findFirstOrThrow({
            where: { tenantId: TA, profile: { agentId: AGENTS.refusals }, status: 'DRAFT' },
            select: { id: true },
        });
        // The version trigger refuses any change first; with triggers off, the
        // CHECK is what refuses an out-of-bounds value.
        for (const value of [5_000, 150_001, -1]) {
            await expect(
                prisma.$transaction(async (tx) => {
                    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
                    await tx.$executeRawUnsafe(`UPDATE "AgentProfileVersion" SET "compactionThresholdTokens" = $2 WHERE "id" = $1`, row.id, value);
                }),
            ).rejects.toThrow(/AgentProfileVersion_compaction_threshold_bounded/);
        }
        // Positive control: an in-bounds value passes the CHECK.
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`UPDATE "AgentProfileVersion" SET "compactionThresholdTokens" = 10000 WHERE "id" = $1`, row.id);
        });
    });

    it('approval re-checks it and audits it; the approver sees it; the resolver compiles it; the content hash does not cover it', async () => {
        const created = await createAgentProfile(authorA(), AGENTS.approved, version({ compactionThresholdTokens: 20_000 }));
        // The hash is the instructions' alone: the threshold is not in it.
        expect(created.instructionsHash).toBe(profileContentHash('Answer questions about the open risks.', null, null));
        await submitAgentProfileVersion(authorA(), AGENTS.approved, 1);
        const view = await getAgentProfile(reviewerA(), AGENTS.approved);
        expect(view.versions[0].compactionThresholdTokens).toBe(20_000);
        expect(view.limits.compactionThreshold).toEqual({
            min: 10_000,
            maxByTier: { balanced: 150_000, deep: 150_000 },
            engineDefaultByTier: { balanced: 30_000, deep: 30_000 },
        });
        await approveAgentProfileVersion(reviewerA(), AGENTS.approved, 1, { instructionsHash: created.instructionsHash });
        const [audit] = await prisma.auditLog.findMany({
            where: { tenantId: TA, entityId: created.versionId, action: 'AGENT_PROFILE_APPROVED' },
            select: { detailsJson: true },
        });
        expect((audit.detailsJson as { after: Record<string, unknown> }).after.compactionThresholdTokens).toBe(20_000);

        const { def } = await resolveRunDefinition(authorA({ agentId: AGENTS.approved }), profileRunKey(created.profileId, 1), { trigger: 'ASK' });
        expect(def.profile?.compactionThresholdTokens).toBe(20_000);
    });

    it('approval refuses a stored value above the tier, as a deploy that lowered the tier would leave one', async () => {
        await createAgentProfileVersion(authorA(), AGENTS.approved, version({ compactionThresholdTokens: 12_000 }));
        const v2 = await prisma.agentProfileVersion.findFirstOrThrow({
            where: { tenantId: TA, profile: { agentId: AGENTS.approved }, version: 2 },
            select: { id: true, instructionsHash: true },
        });
        // A value inside the CHECK but above a tier that a deploy lowered
        // while the version waited is what approval must catch: simulated by
        // the tier's constant moving below the stored value.
        await submitAgentProfileVersion(authorA(), AGENTS.approved, 2);
        const tiers = toolRunnerParams.COMPACTION_THRESHOLD_TOKENS as Record<string, number>;
        const original = tiers.balanced;
        Object.defineProperty(tiers, 'balanced', { value: 11_000, configurable: true });
        try {
            expect(
                await refusalOf(approveAgentProfileVersion(reviewerA(), AGENTS.approved, 2, { instructionsHash: v2.instructionsHash })),
            ).toMatchObject({ reason: 'COMPACTION_THRESHOLD_ABOVE_TIER' });
        } finally {
            Object.defineProperty(tiers, 'balanced', { value: original, configurable: true });
        }
        expect((await prisma.agentProfileVersion.findUniqueOrThrow({ where: { id: v2.id }, select: { status: true } })).status).toBe('SUBMITTED');
    });

    it('the database freezes an approved version\'s threshold for every role', async () => {
        const row = await prisma.agentProfileVersion.findFirstOrThrow({
            where: { tenantId: TA, profile: { agentId: AGENTS.approved }, version: 1 },
            select: { id: true, status: true },
        });
        expect(row.status).toBe('APPROVED');
        for (const value of [0, 12_000]) {
            await expect(
                prisma.$executeRawUnsafe(`UPDATE "AgentProfileVersion" SET "compactionThresholdTokens" = $2 WHERE "id" = $1`, row.id, value),
            ).rejects.toThrow(/IMMUTABLE_AGENT_PROFILE_VERSION/);
        }
        await expect(
            prisma.$executeRawUnsafe(`UPDATE "AgentProfileVersion" SET "compactionThresholdTokens" = NULL WHERE "id" = $1`, row.id),
        ).rejects.toThrow(/IMMUTABLE_AGENT_PROFILE_VERSION/);
    });

    it('another tenant never reads or resolves this tenant\'s setting (two tenants)', async () => {
        const a = await prisma.agentProfile.findFirstOrThrow({ where: { tenantId: TA, agentId: AGENTS.approved }, select: { id: true } });
        expect(
            await refusalOf(resolveRunDefinition(authorB({ agentId: AGENTS.b }), profileRunKey(a.id, 1), { trigger: 'ASK' })),
        ).toMatchObject({ reason: 'PROFILE_NOT_FOUND' });
        await createAgentProfile(authorB(), AGENTS.b, version({ compactionThresholdTokens: 0 }));
        const viewB = await getAgentProfile(authorB(), AGENTS.b);
        expect(viewB.versions.map((v) => v.compactionThresholdTokens)).toEqual([0]);
        // A's 20,000 and 12,000 are in none of B's reads, and B's 0 in none of A's.
        const viewA = await getAgentProfile(authorA(), AGENTS.approved);
        expect(viewA.versions.map((v) => v.compactionThresholdTokens).sort()).toEqual([12_000, 20_000]);
        // B cannot reach A's version through the tenant-scoped client either.
        const rows = await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
            await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, TB);
            return tx.$queryRawUnsafe<Array<{ c: number }>>(
                `SELECT count(*)::int AS c FROM "AgentProfileVersion" WHERE "tenantId" = $1`,
                TA,
            );
        });
        expect(rows[0].c).toBe(0);
    });
});
