/**
 * Saved parameters: an edit does not take effect until a human accepts it.
 *
 * ## Why this needs a real database
 *
 * Three of the four claims here are enforced by Postgres, not by TypeScript:
 *
 *   1. a pending edit is FOUR facts or none — `pending_is_whole`. A row holding
 *      some of them would be read by the approval path as "there is something
 *      to approve" while being unable to say what, or by whom.
 *   2. a BASELINE row names no approver and an APPROVED one must —
 *      `approval_accountability`. Without it a write path that forgot the
 *      approver would produce rows indistinguishable from baselines, and "did a
 *      person accept this query" would stop being answerable from the table.
 *   3. a set belongs to exactly one tenant, under FORCE ROW LEVEL SECURITY.
 *
 * ## The one that would have shipped
 *
 * "Approval clears the proposal" looks like a formality and is not. On a
 * nullable Json column Prisma reads `undefined` as "leave it alone", so the
 * obvious spelling leaves the superseded proposal in place — and the row then
 * violates `pending_is_whole`, because the hash beside it is being nulled. The
 * assertion on `pendingParameters` being null is what distinguishes a cleared
 * proposal from one that merely stopped being reported.
 */
import { PrismaClient, MembershipStatus, Role } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import {
    approveParameterChange,
    hashParameters,
    listParameterSets,
    proposeParameterChange,
    saveParameterSet,
} from '@/app-layer/usecases/external-tool-parameters';
import { externalToolName } from '@/lib/mcp/external-tool-name';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'params-tenant-one';
const T2 = 'params-tenant-two';
const TOOL = externalToolName('cmconnaaa', 'list_alerts');

const APPROVED_QUERY = { query: 'up{job="api"} == 0', range: '5m' };
const PROPOSED_QUERY = { query: 'up{job="api"} == 0 or up{job="worker"} == 0', range: '15m' };

const seeded: Record<string, string> = {};
const ctxFor = (tenantId: string) =>
    makeRequestContext('OWNER', { tenantId, tenantSlug: tenantId, userId: seeded[tenantId] });

async function clearOwnRows(): Promise<void> {
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.externalToolParameterSet.deleteMany({ where: t });
    await deleteAuditRowsForTenants(prisma, [T1, T2]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(
            `DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`,
            [T1, T2],
        );
    });
    await prisma.user.deleteMany({
        where: { emailHash: { in: [T1, T2].map((t2) => hashForLookup(`owner@${t2}.test`)) } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
}

beforeAll(async () => {
    await resetDatabase(prisma);
    await clearOwnRows();
    for (const [id, name] of [[T1, 'Params One'], [T2, 'Params Two']] as const) {
        await prisma.tenant.create({ data: { id, name, slug: id } });
        const email = `owner@${id}.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
        await prisma.tenantMembership.create({
            data: {
                tenantId: id,
                userId: user.id,
                role: Role.OWNER,
                status: MembershipStatus.ACTIVE,
            },
        });
        seeded[id] = user.id;
    }
});

afterAll(async () => {
    await clearOwnRows();
    await prisma.$disconnect();
});

beforeEach(async () => {
    await prisma.externalToolParameterSet.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
});

const baseline = () =>
    saveParameterSet(ctxFor(T1), { toolName: TOOL, label: 'prod alerts', parameters: APPROVED_QUERY });

describe('the first save is a baseline', () => {
    it('names no approver, because there was nothing to compare', async () => {
        const set = await baseline();
        expect(set).toMatchObject({
            toolName: TOOL,
            label: 'prod alerts',
            revision: 1,
            approvalSource: 'BASELINE',
            approvedByUserId: null,
            parametersHash: hashParameters(APPROVED_QUERY),
            pending: null,
        });
    });

    it('refuses parameters for a built-in tool', async () => {
        await expect(
            saveParameterSet(ctxFor(T1), {
                toolName: 'list_risks',
                label: 'x',
                parameters: { q: 1 },
            }),
        ).rejects.toThrow(/not an external tool/);
    });
});

describe('a proposed change does not take effect', () => {
    it('leaves the agent dispatching what was approved', async () => {
        const set = await baseline();
        const after = await proposeParameterChange(ctxFor(T1), {
            id: set.id,
            parameters: PROPOSED_QUERY,
        });

        // Still in force: the OLD query, at the OLD revision.
        expect(after.parameters).toEqual(APPROVED_QUERY);
        expect(after.revision).toBe(1);
        // And the proposal is recorded, whole, with its author.
        expect(after.pending).toMatchObject({
            parameters: PROPOSED_QUERY,
            hash: hashParameters(PROPOSED_QUERY),
            byUserId: seeded[T1],
        });
    });

    it('refuses a proposal identical to what is already in force', async () => {
        const set = await baseline();
        await expect(
            proposeParameterChange(ctxFor(T1), { id: set.id, parameters: APPROVED_QUERY }),
        ).rejects.toThrow(/already in force/);
    });
});

describe('approval', () => {
    it('promotes the proposal, advances the revision, and CLEARS the pending columns', async () => {
        const set = await baseline();
        await proposeParameterChange(ctxFor(T1), { id: set.id, parameters: PROPOSED_QUERY });

        const approved = await approveParameterChange(ctxFor(T1), {
            id: set.id,
            expectedPendingHash: hashParameters(PROPOSED_QUERY),
        });

        expect(approved).toMatchObject({
            parameters: PROPOSED_QUERY,
            parametersHash: hashParameters(PROPOSED_QUERY),
            revision: 2,
            approvalSource: 'APPROVED',
            approvedByUserId: seeded[T1],
            pending: null,
        });

        // Read the COLUMN, not the projection. `pending: null` above would also
        // be true of a row whose proposal survived under a nulled hash — which
        // is the exact state `Prisma.DbNull` exists to prevent and which
        // `pending_is_whole` would then reject.
        const raw = await prisma.externalToolParameterSet.findUnique({
            where: { id: set.id },
            select: { pendingParameters: true, pendingHash: true, previousHash: true },
        });
        expect(raw).toEqual({
            pendingParameters: null,
            pendingHash: null,
            previousHash: hashParameters(APPROVED_QUERY),
        });
    });

    it('refuses a hash that is not the one on file', async () => {
        const set = await baseline();
        await proposeParameterChange(ctxFor(T1), { id: set.id, parameters: PROPOSED_QUERY });
        await expect(
            approveParameterChange(ctxFor(T1), {
                id: set.id,
                expectedPendingHash: 'the-hash-the-operator-read-earlier',
            }),
        ).rejects.toThrow(/changed since they were reviewed/);
    });

    it('refuses when there is nothing pending', async () => {
        const set = await baseline();
        await expect(
            approveParameterChange(ctxFor(T1), {
                id: set.id,
                expectedPendingHash: hashParameters(PROPOSED_QUERY),
            }),
        ).rejects.toThrow(/no pending change/);
    });
});

describe('the database enforces the invariants, not just the usecase', () => {
    it('rejects half a pending edit', async () => {
        const set = await baseline();
        await expect(
            prisma.externalToolParameterSet.update({
                where: { id: set.id },
                // A hash with no values, no author and no timestamp: the
                // approval path would see "something to approve" and be unable
                // to say what.
                data: { pendingHash: 'abc' },
            }),
        ).rejects.toThrow();
    });

    it('rejects an APPROVED row that names no approver', async () => {
        const set = await baseline();
        await expect(
            prisma.externalToolParameterSet.update({
                where: { id: set.id },
                data: { approvalSource: 'APPROVED' },
            }),
        ).rejects.toThrow();
    });
});

describe('a set belongs to one tenant', () => {
    it('is invisible to another tenant, and cannot be approved by one', async () => {
        const set = await baseline();

        await expect(listParameterSets(ctxFor(T2))).resolves.toEqual([]);
        await expect(
            proposeParameterChange(ctxFor(T2), { id: set.id, parameters: PROPOSED_QUERY }),
        ).rejects.toThrow(/not found/);
    });
});
