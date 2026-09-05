/**
 * Tool-manifest pins belong to exactly one tenant.
 *
 * ## Why this needs a real database
 *
 * A pin is the statement "this tenant has accepted this tool description". Two
 * things follow, and neither is provable without Postgres:
 *
 *   1. A cross-tenant READ would let one customer's boundary clear a refusal
 *      using another customer's approval — the control would be defeated by
 *      whichever tenant approved a poisoned description first, for everybody.
 *   2. A cross-tenant WRITE would let one customer approve a description on
 *      another's behalf, silently.
 *
 * ## The boundary's read is the interesting one
 *
 * `loadApprovedManifest` runs at the MCP tool boundary with NO `RequestContext`
 * and therefore no tenant transaction — the base client is a non-`app_user`
 * session, so `superuser_bypass` applies and the `tenantId` argument is the ONLY
 * isolation it has. That is exactly the shape where an isolation bug is
 * invisible to a policy test, so it is driven directly here rather than inferred
 * from the usecase's behaviour: the two take different paths to the same table.
 *
 * The raw `app_user` assertions at the end cover the other direction — that RLS
 * would hold even if a caller forgot the predicate.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { hashToolManifest, type ToolDefinition } from '@/lib/mcp/tool-manifest';
import { toolDefinitionByName } from '@/lib/mcp/tool-definitions';
import {
    loadApprovedManifest,
    loadApprovedManifests,
    recordBaselinePins,
} from '@/lib/agentic/tool-manifest-store';
import { approveToolManifest, listToolManifests } from '@/app-layer/usecases/mcp-tool-manifest';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'toolpin-tenant-one';
const T2 = 'toolpin-tenant-two';
const TOOL = 'list_risks';

/** The definition this build carries — what tenant one will end up approving. */
const liveDef = toolDefinitionByName(TOOL)!;
const liveHashes = hashToolManifest(liveDef);

/**
 * A DIFFERENT definition of the SAME tool, pinned by tenant two. Same name and
 * schema, different description — so a leak between the two tenants shows up as
 * a hash mismatch and not as an empty result, which a bug could also produce.
 */
const otherDef: ToolDefinition = {
    ...liveDef,
    description: 'A description only tenant two ever saw.',
};
const otherHashes = hashToolManifest(otherDef);

const seeded: Record<string, string> = {};
const ctxFor = (tenantId: string) =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId] });

/** `app_user` bound to one tenant — what a real request looks like. */
async function asTenant<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        await tx.$executeRawUnsafe(`SELECT set_config('app.tenant_id', '${tenantId}', true)`);
        return fn(tx as unknown as PrismaClient);
    });
}

/** `app_user` with NO tenant bound — the "context never got set" case. */
async function asAppUserWithNoTenant<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
        return fn(tx as unknown as PrismaClient);
    });
}

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.mcpToolManifestPin.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: [T1, T2].map((t2) => hashForLookup(`owner@${t2}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const [id, name] of [[T1, 'Tenant One'], [T2, 'Tenant Two']] as const) {
        await prisma.tenant.create({ data: { id, name, slug: id } });
        const email = `owner@${id}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId: user.id, role: Role.OWNER, status: MembershipStatus.ACTIVE },
        });
        seeded[id] = user.id;
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

beforeEach(async () => {
    await prisma.mcpToolManifestPin.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await recordBaselinePins(T1, [liveDef]);
    await recordBaselinePins(T2, [otherDef]);
});

describe('the boundary read is scoped by its tenantId argument alone', () => {
    it('BOTH tenants really have a pin, and they differ — otherwise every assertion below is vacuous', async () => {
        const rows = await prisma.mcpToolManifestPin.findMany({
            where: { tenantId: { in: [T1, T2] } },
        });
        expect(rows).toHaveLength(2);
        expect(liveHashes.manifestHash).not.toBe(otherHashes.manifestHash);
    });

    it('returns each tenant its own pin and never the other tenant s', async () => {
        const one = await loadApprovedManifest(T1, TOOL);
        const two = await loadApprovedManifest(T2, TOOL);
        expect(one?.manifestHash).toBe(liveHashes.manifestHash);
        expect(two?.manifestHash).toBe(otherHashes.manifestHash);
    });

    it('returns nothing for a tenant that has pinned nothing, rather than falling back', async () => {
        const none = await loadApprovedManifest('toolpin-tenant-three', TOOL);
        expect(none).toBeNull();
    });

    it('scopes the batch read too — the path tools/list takes', async () => {
        const batch = await loadApprovedManifests(T1, [TOOL, 'list_controls']);
        expect(batch.size).toBe(1);
        expect(batch.get(TOOL)?.manifestHash).toBe(liveHashes.manifestHash);
    });
});

describe('an approval by one tenant does not move another tenant s pin', () => {
    it('leaves the other tenant refusing exactly as it was', async () => {
        await approveToolManifest(ctxFor(T1), {
            toolName: TOOL,
            expectedManifestHash: liveHashes.manifestHash,
        });

        const two = await loadApprovedManifest(T2, TOOL);
        expect(two?.manifestHash).toBe(otherHashes.manifestHash);
        expect(two?.approvalSource).toBe('BASELINE');
        expect(two?.approvedByUserId).toBeNull();
    });

    it('shows each tenant only its own pin state through the admin list', async () => {
        const listed = await listToolManifests(ctxFor(T2));
        const row = listed.find((r) => r.toolName === TOOL);
        expect(row?.approvedManifestHash).toBe(otherHashes.manifestHash);
        // Tenant two pinned a description the build no longer carries, so the
        // boundary is refusing this tool FOR TENANT TWO ONLY.
        expect(row?.blocked).toBe(true);

        const listedOne = await listToolManifests(ctxFor(T1));
        expect(listedOne.find((r) => r.toolName === TOOL)?.blocked).toBe(false);
    });
});

describe('row-level security holds even when the predicate is forgotten', () => {
    it('shows an app_user bound to one tenant only that tenant s rows', async () => {
        const rows = await asTenant(T1, (tx) => tx.mcpToolManifestPin.findMany({}));
        expect(rows).toHaveLength(1);
        expect(rows[0].tenantId).toBe(T1);
    });

    it('shows an app_user with NO tenant bound nothing at all', async () => {
        const rows = await asAppUserWithNoTenant((tx) => tx.mcpToolManifestPin.findMany({}));
        expect(rows).toHaveLength(0);
    });

    it('refuses an INSERT naming another tenant', async () => {
        await expect(
            asTenant(T1, (tx) =>
                tx.mcpToolManifestPin.create({
                    data: {
                        tenantId: T2,
                        toolName: 'list_controls',
                        descriptionHash: 'c'.repeat(64),
                        schemaHash: 'd'.repeat(64),
                        manifestHash: 'e'.repeat(64),
                        approvalSource: 'BASELINE',
                    },
                }),
            ),
        ).rejects.toThrow();
    });
});

describe('the accountability invariant is enforced at the database', () => {
    it('refuses an APPROVED row with no approver', async () => {
        // The single question the table exists to answer is "did a person accept
        // this description". A write path that forgot the approver would produce
        // rows indistinguishable from baselines and quietly end that.
        await expect(
            prisma.$executeRawUnsafe(
                `INSERT INTO "McpToolManifestPin"
                    ("id","tenantId","toolName","descriptionHash","schemaHash","manifestHash","approvalSource","revision","updatedAt")
                 VALUES ('bad-approved-row',$1,'list_controls','h1','h2','h3','APPROVED',1,NOW())`,
                T1,
            ),
        ).rejects.toThrow();
    });

    it('refuses a BASELINE row that names one', async () => {
        await expect(
            prisma.$executeRawUnsafe(
                `INSERT INTO "McpToolManifestPin"
                    ("id","tenantId","toolName","descriptionHash","schemaHash","manifestHash","approvalSource","approvedByUserId","revision","updatedAt")
                 VALUES ('bad-baseline-row',$1,'list_controls','h1','h2','h3','BASELINE',$2,1,NOW())`,
                T1,
                seeded[T1],
            ),
        ).rejects.toThrow();
    });
});
