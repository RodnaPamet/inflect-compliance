/**
 * The agent-register backfill, executed from the migration file itself.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * Both tables the backfill adopts from (`AgentProposal`, `WorkflowRun`) are
 * EMPTY in production, so the shipped statements adopt nothing on the deploy
 * that runs them. That makes them the most dangerous kind of SQL: correct-
 * looking, and never once observed doing its job. A staging or self-hosted
 * database may not be empty.
 *
 * So this reads the `-- ── Backfill ──` section OUT OF the migration and runs
 * it against seeded fixtures. It is deliberately not a re-typed copy of the
 * statements: a copy would prove that the copy works.
 *
 * Three behaviours are pinned — adoption, the no-ACTIVE-OWNER skip, and
 * idempotence — because each is a different way the deploy could go wrong, and
 * only the first is the happy path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(30_000);

const MIGRATION = path.resolve(
    __dirname,
    '../../prisma/migrations/20260904120000_agentic_agent_registry/migration.sql',
);

const TAG = `bf-${randomUUID().slice(0, 8)}`;
/** Has proposals AND two ACTIVE OWNERs — the adoption case. */
const ADOPTED = `${TAG}-adopted`;
/** Has a run but NO ACTIVE OWNER — the skip case. */
const OWNERLESS = `${TAG}-ownerless`;
/** Has an ACTIVE OWNER but no agentic rows at all — must get no placeholder. */
const UNTOUCHED = `${TAG}-untouched`;
const TENANTS = [ADOPTED, OWNERLESS, UNTOUCHED];

/**
 * The statements the migration ships, split out of the file. Splitting on `;`
 * is safe here only because the backfill section contains no semicolons inside
 * literals or comments — asserted below rather than assumed, since a future
 * edit that broke it would otherwise silently run a truncated backfill.
 */
function backfillStatements(): string[] {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const marker = sql.indexOf('-- ── Backfill ─');
    if (marker === -1) throw new Error('Backfill section marker not found in the migration');
    return sql
        .slice(marker)
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.split('\n').every((l) => l.trim().startsWith('--')));
}

async function runBackfill(): Promise<void> {
    for (const statement of backfillStatements()) {
        await prisma.$executeRawUnsafe(statement);
    }
}

const createdUserIds: string[] = [];

async function makeUser(label: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    createdUserIds.push(u.id);
    return u.id;
}

async function cleanup(): Promise<void> {
    const t = { tenantId: { in: TENANTS } };
    await prisma.agentProposal.deleteMany({ where: t });
    await prisma.workflowRun.deleteMany({ where: t });
    await prisma.registeredAgent.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        // The last-OWNER guard fires on an ordinary DELETE of a membership.
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
            TENANTS,
        );
    });
    // By id, not by a filter over the encrypted email column: an `undefined`
    // filter value is DROPPED by Prisma, and a dropped filter on a deleteMany
    // is a whole-table delete.
    if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

let olderOwnerId = '';
let newerOwnerId = '';

beforeAll(async () => {
    await cleanup();
    for (const id of TENANTS) {
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }

    // ADOPTED: two ACTIVE OWNERs, created a day apart. The backfill must pick
    // the OLDER one — "some owner" is not the same claim.
    olderOwnerId = await makeUser('owner-older');
    newerOwnerId = await makeUser('owner-newer');
    await prisma.tenantMembership.create({
        data: {
            tenantId: ADOPTED,
            userId: olderOwnerId,
            role: Role.OWNER,
            status: MembershipStatus.ACTIVE,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
    });
    await prisma.tenantMembership.create({
        data: {
            tenantId: ADOPTED,
            userId: newerOwnerId,
            role: Role.OWNER,
            status: MembershipStatus.ACTIVE,
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
        },
    });
    await prisma.agentProposal.create({
        data: { tenantId: ADOPTED, kind: 'RISK', payloadJson: '{"title":"legacy"}' },
    });
    await prisma.workflowRun.create({ data: { tenantId: ADOPTED, workflowKey: 'legacy-flow' } });

    // OWNERLESS: agentic history, but the only membership is an ADMIN. An
    // ADMIN is not an OWNER, and the backfill must not quietly promote one.
    const adminId = await makeUser('admin');
    await prisma.tenantMembership.create({
        data: {
            tenantId: OWNERLESS,
            userId: adminId,
            role: Role.ADMIN,
            status: MembershipStatus.ACTIVE,
        },
    });
    await prisma.workflowRun.create({ data: { tenantId: OWNERLESS, workflowKey: 'orphan-flow' } });

    // UNTOUCHED: a perfectly healthy tenant that never ran an agent.
    const untouchedOwner = await makeUser('untouched-owner');
    await prisma.tenantMembership.create({
        data: {
            tenantId: UNTOUCHED,
            userId: untouchedOwner,
            role: Role.OWNER,
            status: MembershipStatus.ACTIVE,
        },
    });

    await runBackfill();
});

afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
});

describe('the statements read out of the migration are the whole backfill', () => {
    it('the section splits into the four statements it ships', () => {
        // If a future edit adds a semicolon inside a literal, this splits wrong
        // and the suite would run a truncated backfill while still passing its
        // assertions by luck. Pin the count.
        const statements = backfillStatements();
        expect(statements).toHaveLength(4);
        expect(statements.filter((s) => s.includes('INSERT INTO "AiSystem"'))).toHaveLength(1);
        expect(statements.filter((s) => s.includes('INSERT INTO "RegisteredAgent"'))).toHaveLength(1);
        expect(statements.filter((s) => s.includes('UPDATE "AgentProposal"'))).toHaveLength(1);
        expect(statements.filter((s) => s.includes('UPDATE "WorkflowRun"'))).toHaveLength(1);
    });
});

describe('a tenant with pre-register agentic work is adopted', () => {
    it('gets one placeholder agent, suspended and unscored', async () => {
        const agents = await prisma.registeredAgent.findMany({ where: { tenantId: ADOPTED } });
        expect(agents).toHaveLength(1);
        const [agent] = agents;
        expect(agent.isLegacyPlaceholder).toBe(true);
        expect(agent.status).toBe('SUSPENDED');
        expect(agent.riskTier).toBeNull();
        expect(agent.riskTierScoredAt).toBeNull();
    });

    it('the placeholder is worst-case on every axis the constraints allow', async () => {
        // An unregistered agent's real properties are unknown, and the
        // fail-closed reading of unknown is "the most dangerous thing it could
        // have been". `provenance` is FIRST_PARTY only because THIRD_PARTY
        // needs a vendor there is no way to name.
        const agent = await prisma.registeredAgent.findFirstOrThrow({
            where: { tenantId: ADOPTED },
        });
        expect(agent.autonomyLevel).toBe(6);
        expect(agent.dataAccessScope).toBe('EXTERNAL_EGRESS');
        expect(agent.reversibility).toBe('TERMINAL');
        expect(agent.provenance).toBe('FIRST_PARTY');
    });

    it('it is owned by the OLDEST active owner, not just any owner', async () => {
        const agent = await prisma.registeredAgent.findFirstOrThrow({
            where: { tenantId: ADOPTED },
        });
        expect(agent.ownerUserId).toBe(olderOwnerId);
        expect(agent.ownerUserId).not.toBe(newerOwnerId);
    });

    it('it is linked to a synthetic AI-system register entry', async () => {
        // The link is NOT NULL, so adopting legacy rows means creating the
        // register entry too. Its free-text columns stay NULL: raw SQL bypasses
        // the encryption extension, and plaintext in a ciphertext column is
        // worse than no value.
        const agent = await prisma.registeredAgent.findFirstOrThrow({
            where: { tenantId: ADOPTED },
        });
        const system = await prisma.aiSystem.findUniqueOrThrow({
            where: { id: agent.aiSystemId },
        });
        expect(system.tenantId).toBe(ADOPTED);
        expect(system.purpose).toBeNull();
        expect(system.useContext).toBeNull();
    });

    it('both pre-register rows now point at it', async () => {
        const agent = await prisma.registeredAgent.findFirstOrThrow({
            where: { tenantId: ADOPTED },
        });
        const proposals = await prisma.agentProposal.findMany({ where: { tenantId: ADOPTED } });
        const runs = await prisma.workflowRun.findMany({ where: { tenantId: ADOPTED } });
        expect(proposals.map((p) => p.agentId)).toEqual([agent.id]);
        expect(runs.map((r) => r.agentId)).toEqual([agent.id]);
    });
});

describe('a tenant with no ACTIVE OWNER is skipped, not failed', () => {
    it('gets no placeholder agent', async () => {
        const agents = await prisma.registeredAgent.findMany({ where: { tenantId: OWNERLESS } });
        expect(agents).toEqual([]);
    });

    it('its rows stay unattributed rather than being adopted by someone else', async () => {
        const runs = await prisma.workflowRun.findMany({ where: { tenantId: OWNERLESS } });
        expect(runs).toHaveLength(1);
        expect(runs[0].agentId).toBeNull();
    });
});

describe('a tenant that never ran an agent is left alone', () => {
    it('gets neither a placeholder agent nor a synthetic AI system', async () => {
        expect(await prisma.registeredAgent.count({ where: { tenantId: UNTOUCHED } })).toBe(0);
        expect(await prisma.aiSystem.count({ where: { tenantId: UNTOUCHED } })).toBe(0);
    });
});

describe('re-running the backfill changes nothing', () => {
    it('is idempotent — the NOT EXISTS guards hold on a second pass', async () => {
        const before = await prisma.registeredAgent.findMany({
            where: { tenantId: { in: TENANTS } },
            orderBy: { id: 'asc' },
        });

        await runBackfill();

        const after = await prisma.registeredAgent.findMany({
            where: { tenantId: { in: TENANTS } },
            orderBy: { id: 'asc' },
        });
        expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id));
        expect(await prisma.aiSystem.count({ where: { tenantId: { in: TENANTS } } })).toBe(1);
    });
});
