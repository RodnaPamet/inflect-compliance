/**
 * Behavioural test for `usecases/issue.ts` after the `/issues` work-item
 * routes were retired.
 *
 * Two invariants:
 *
 *   1. **One work-item implementation.** `usecases/issue.ts` used to
 *      carry a parallel bulk surface (`bulkSetStatus`, `bulkAssign`,
 *      `bulkSetDueDate`) that hit the same `WorkItemRepository` rows
 *      while skipping the four-eyes reviewer gate, the
 *      assignee≠reviewer SoD guard, `assertActiveMembers`, source
 *      reconciliation and `bumpEntityCacheVersion`. Its routes are
 *      gone, so the functions are gone. This asserts the module cannot
 *      be re-wired as a second implementation, and that the gated
 *      `usecases/task.ts` equivalents are the ones that exist.
 *
 *   2. **The surviving bundle surface fails closed.** Three
 *      `/api/t/:slug/issues/:issueId/bundles*` routes still call in
 *      here. The underlying Prisma models were removed, so the
 *      repository is a deprecated stub — but the policy gate must
 *      still run FIRST. A caller without permission must get an
 *      authorization error, never the deprecation notice: the
 *      deprecation notice is a statement about our schema, and an
 *      unauthorized caller has no business learning it.
 *
 * Hits a real DB (project convention) — the read paths run inside
 * `runInTenantContext`.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import * as issueUsecase from '@/app-layer/usecases/issue';
import * as taskUsecase from '@/app-layer/usecases/task';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `issue-bundle-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

let ownerUserId: string;
let readerUserId: string;
let ctx: ReturnType<typeof makeRequestContext>;
let reader: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string, role: Role): Promise<string> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: u.id, role, status: MembershipStatus.ACTIVE },
    });
    return u.id;
}

describeFn('issue usecase — evidence-bundle surface only', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        ownerUserId = await makeUser('owner', Role.OWNER);
        readerUserId = await makeUser('reader', Role.READER);
        ctx = makeRequestContext('OWNER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: ownerUserId });
        reader = makeRequestContext('READER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: readerUserId });
    });

    afterAll(async () => {
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = $1`, TENANT_ID);
        });
        await globalPrisma.user.deleteMany({ where: { id: { in: [ownerUserId, readerUserId] } } });
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    describe('one work-item implementation', () => {
        // The retired trio, plus the rest of the parallel work-item
        // surface that lost its HTTP entry point with it.
        const RETIRED = [
            'bulkSetStatus',
            'bulkAssign',
            'bulkSetDueDate',
            'listIssues',
            'getIssue',
            'createIssue',
            'updateIssue',
            'setIssueStatus',
            'assignIssue',
            'addIssueLink',
            'removeIssueLink',
            'addIssueComment',
            'addIssueWatcher',
            'removeIssueWatcher',
            'getIssueMetrics',
            'getIssueActivity',
            'findOverdueIssuesAndEmitEvents',
            'listIssuesByControl',
        ] as const;

        it.each(RETIRED)('does not export a second %s implementation', (name) => {
            expect((issueUsecase as Record<string, unknown>)[name]).toBeUndefined();
        });

        it('exports exactly the evidence-bundle surface the live routes call', () => {
            expect(Object.keys(issueUsecase).sort()).toEqual([
                'addBundleItem',
                'createBundle',
                'freezeBundle',
                'getBundle',
                'listBundleItems',
                'listBundles',
            ]);
        });

        it('the gated task usecase still owns every work-item bulk mutation', () => {
            expect(typeof taskUsecase.bulkSetTaskStatus).toBe('function');
            expect(typeof taskUsecase.bulkAssignTasks).toBe('function');
            expect(typeof taskUsecase.bulkSetTaskDueDate).toBe('function');
        });
    });

    describe('the bundle surface fails closed', () => {
        it('denies a READER before the deprecation stub is reached', async () => {
            // Every one of these must be an authorization failure, NOT
            // the "no longer supported" deprecation message — the gate
            // runs first.
            const denied = [
                () => issueUsecase.createBundle(reader, 'iss', 'b'),
                () => issueUsecase.freezeBundle(reader, 'bid'),
                () => issueUsecase.addBundleItem(reader, 'bid', { entityType: 'X', entityId: 'y' }),
            ];
            for (const call of denied) {
                await expect(call()).rejects.toThrow(/permission/i);
                await expect(call()).rejects.not.toThrow(/no longer supported/i);
            }
        });

        it('allows a READER the bundle reads, which resolve empty', async () => {
            await expect(issueUsecase.listBundles(reader, 'iss')).resolves.toEqual([]);
            await expect(issueUsecase.listBundleItems(reader, 'bid')).resolves.toEqual([]);
            await expect(issueUsecase.getBundle(reader, 'bid')).resolves.toBeNull();
        });

        it('surfaces the deprecation to an authorized writer as a typed error', async () => {
            await expect(issueUsecase.createBundle(ctx, 'iss', 'b')).rejects.toThrow(
                /no longer supported/i,
            );
            await expect(issueUsecase.freezeBundle(ctx, 'bid')).rejects.toThrow(
                /no longer supported/i,
            );
            await expect(
                issueUsecase.addBundleItem(ctx, 'bid', { entityType: 'X', entityId: 'y' }),
            ).rejects.toThrow(/no longer supported/i);
        });

        it('writes no audit row for a bundle write that never landed', async () => {
            const before = await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID } });
            await expect(issueUsecase.createBundle(ctx, 'iss', 'b')).rejects.toThrow();
            const after = await globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID } });
            expect(after).toBe(before);
        });
    });
});
