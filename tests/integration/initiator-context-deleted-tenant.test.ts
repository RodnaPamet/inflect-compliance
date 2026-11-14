/**
 * A job a member queued does not run in a tenant that has since been
 * soft-deleted (#5305).
 *
 * `deleteTenantUnderOrg` stamps `Tenant.deletedAt` and leaves the memberships
 * in place, and the tenant is meant to be inaccessible everywhere from that
 * moment. A job queued with an API key was refused (`resolveApiKeyForJob`
 * answers `tenant_deleted`), but one queued from a browser session — an
 * evidence import, a SharePoint sync — resolved the member's ACTIVE membership
 * through `resolveInitiatorContext` and went on to write into the deleted
 * tenant.
 *
 * An integration test because the refusal is a relation filter the database
 * evaluates; a mocked client would only echo the query back.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { resolveInitiatorContext } from '@/app-layer/context-system';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const SUITE = randomUUID().slice(0, 8);
const LIVE = `initiator-live-${SUITE}`;
const GONE = `initiator-gone-${SUITE}`;
let userId = '';

beforeAll(async () => {
    const email = `member@${SUITE}.test`;
    const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userId = user.id;
    for (const id of [LIVE, GONE]) {
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId, role: 'EDITOR', status: 'ACTIVE' },
        });
    }
    await prisma.tenant.update({ where: { id: GONE }, data: { deletedAt: new Date() } });
});

afterAll(async () => {
    await prisma.tenantMembership.deleteMany({ where: { userId } });
    await prisma.tenant.deleteMany({ where: { id: { in: [LIVE, GONE] } } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
});

describe('resolveInitiatorContext and a soft-deleted tenant', () => {
    it('resolves the member in a live tenant — the control', async () => {
        const ctx = await resolveInitiatorContext({ tenantId: LIVE, userId, requestId: 'req-live' });
        expect(ctx).toMatchObject({ tenantId: LIVE, userId, role: 'EDITOR' });
    });

    it('refuses the same ACTIVE membership once its tenant is soft-deleted', async () => {
        await expect(
            resolveInitiatorContext({ tenantId: GONE, userId, requestId: 'req-gone' }),
        ).resolves.toBeNull();
    });
});
