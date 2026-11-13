/**
 * The framework tree does not count a soft-deleted control as covering a
 * requirement (#5268). Its link read had no `deletedAt` filter, so a control
 * moved to the trash still turned its requirement compliant on the tree while
 * the coverage report and the SoA, which both exclude it, said otherwise.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { getFrameworkTree } from '@/app-layer/usecases/framework';
import type { FrameworkTreeNode } from '@/lib/framework-tree/types';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `ftd-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const FW_KEY = `TREEDEL_${SUITE}`;
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE, userId: `u-${SUITE}` });

function requirementNodes(nodes: FrameworkTreeNode[]): FrameworkTreeNode[] {
    return nodes.flatMap((n) => (n.kind === 'requirement' ? [n] : requirementNodes(n.children ?? [])));
}

describeFn('framework tree and soft-deleted controls (real DB)', () => {
    let frameworkId: string | undefined;

    beforeAll(async () => {
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: SUITE, slug: SUITE } });
        const email = `${SUITE}@example.test`;
        await prisma.user.upsert({ where: { id: ctx.userId }, update: {}, create: { id: ctx.userId, email, emailHash: hashForLookup(email) } });
        const fw = await prisma.framework.create({ data: { key: FW_KEY, name: 'Tree test', version: '1' } });
        frameworkId = fw.id;
        const live = await prisma.frameworkRequirement.create({ data: { frameworkId: fw.id, code: 'T.1', title: 'Covered by a live control', section: 'T', sortOrder: 0 } });
        const trashed = await prisma.frameworkRequirement.create({ data: { frameworkId: fw.id, code: 'T.2', title: 'Covered only by a trashed control', section: 'T', sortOrder: 1 } });
        const done = { status: 'IMPLEMENTED' as const, applicability: 'APPLICABLE' as const };
        const a = await prisma.control.create({ data: { tenantId: TENANT, name: 'Live', code: 'L-1', ...done } });
        const b = await prisma.control.create({ data: { tenantId: TENANT, name: 'Trashed', code: 'D-1', ...done, deletedAt: new Date() } });
        await prisma.controlRequirementLink.createMany({
            data: [
                { tenantId: TENANT, controlId: a.id, requirementId: live.id },
                { tenantId: TENANT, controlId: b.id, requirementId: trashed.id },
            ],
        });
    });

    afterAll(async () => {
        await deleteAuditRowsForTenants(prisma, TENANT);
        await prisma.controlRequirementLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.control.deleteMany({ where: { tenantId: TENANT } });
        if (frameworkId) {
            await prisma.frameworkRequirement.deleteMany({ where: { frameworkId } });
            await prisma.framework.deleteMany({ where: { id: frameworkId } });
        }
        await prisma.$disconnect();
    });

    it('a requirement covered only by a trashed control is not compliant', async () => {
        const tree = await getFrameworkTree(ctx, FW_KEY);
        const byCode = new Map(requirementNodes(tree.nodes).map((n) => [n.code, n]));
        expect(byCode.get('T.1')?.complianceStatus).toBe('compliant');
        expect(byCode.get('T.2')?.complianceStatus).not.toBe('compliant');
    });
});
