/**
 * #5185 — a tenant's own members are recognised as schedule recipients.
 *
 * `User.email` is stored encrypted with a random IV, and the PII middleware
 * rewrites an equality on it to the lookup-hash column only for the queried
 * model's OWN fields, never a relation filter. The recipient check filtered
 * memberships on `user: { email: { in } }`, so through the real client a
 * member's address never matched and every internal recipient was refused.
 * The unit suite mocks Prisma and could not see it, so this runs through the
 * application client, encryption included.
 */
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import { prisma } from '@/lib/prisma';
import { resolveScheduleRecipients } from '@/app-layer/usecases/report-recipients';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('resolveScheduleRecipients through the real client (#5185)', () => {
    const tag = `rr-${randomUUID().slice(0, 8)}`;
    const email = `${tag}-ciso@acme.test`;
    let tenantId: string | undefined;
    let userId: string | undefined;

    beforeAll(async () => {
        const tenant = await prisma.tenant.create({ data: { name: tag, slug: tag } });
        tenantId = tenant.id;
        // Through the application client, so `email` is written encrypted and
        // `emailHash` is filled in, exactly as sign-up writes them.
        const user = await prisma.user.create({ data: { email } });
        userId = user.id;
        await prisma.tenantMembership.create({
            data: { tenantId, userId, role: 'ADMIN', status: 'ACTIVE' },
        });
    });

    afterAll(async () => {
        if (tenantId) {
            await deleteAuditRowsForTenants(prisma, [tenantId]).catch(() => undefined);
            await prisma.tenantMembership.deleteMany({ where: { tenantId } }).catch(() => undefined);
            await prisma.tenant.delete({ where: { id: tenantId } });
        }
        if (userId) await prisma.user.delete({ where: { id: userId } });
    });

    it('accepts an ACTIVE member as an internal recipient, whatever the casing', async () => {
        const ctx = makeRequestContext('ADMIN', { tenantId: tenantId!, userId: userId! });
        const out = await resolveScheduleRecipients(ctx, [email.toUpperCase()]);
        expect(out.internal).toEqual([email]);
        expect(out.external).toEqual([]);
    });
});
