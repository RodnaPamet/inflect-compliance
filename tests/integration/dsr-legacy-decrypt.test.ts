/**
 * DataSubjectRequest values written while the model was in the encryption
 * manifest are turned back into plaintext at container start (#5107).
 */
import { randomBytes, randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import appPrisma from '@/lib/prisma';
import { encryptField, encryptWithKey } from '@/lib/security/encryption';
import { createTenantWithDek, getTenantDek } from '@/lib/security/tenant-key-manager';
import { decryptLegacyDsrFields } from '@/lib/security/dsr-legacy-decrypt';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const db = appPrisma as unknown as Parameters<typeof decryptLegacyDsrFields>[0];
const suffix = randomUUID().slice(0, 8);
const ids = { tenant: '', subject: '', handler: '', dsrOpen: '', dsrStuck: '' };

describeFn('legacy data-subject-request values are decrypted (#5107)', () => {
    beforeAll(async () => {
        const tenant = await createTenantWithDek({ name: `DSR ${suffix}`, slug: `dsr-${suffix}` });
        ids.tenant = tenant.id;
        ids.subject = (await appPrisma.user.create({ data: { email: `subj-${suffix}@example.com`, name: 'Subject' } })).id;
        ids.handler = (await appPrisma.user.create({ data: { email: `hand-${suffix}@example.com`, name: 'Handler' } })).id;
        await appPrisma.tenantMembership.create({ data: { tenantId: ids.tenant, userId: ids.handler, role: 'ADMIN' } });

        const dek = await getTenantDek(ids.tenant);
        const open = await appPrisma.dataSubjectRequest.create({
            data: {
                userId: ids.subject,
                handledById: ids.handler,
                type: 'EXPORT',
                status: 'REJECTED',
                rejectionReason: encryptField('IDENTITY_NOT_VERIFIED'),
                fulfilmentNotes: encryptWithKey(dek, 'Checked with the subject by phone.'),
            },
        });
        ids.dsrOpen = open.id;
        // A v2 value under a key no candidate holds: left alone, never erased.
        const stuck = await appPrisma.dataSubjectRequest.create({
            data: {
                userId: ids.subject,
                type: 'EXPORT',
                status: 'RECEIVED',
                fulfilmentNotes: encryptWithKey(randomBytes(32), 'unreachable'),
            },
        });
        ids.dsrStuck = stuck.id;
    });

    afterAll(async () => {
        await appPrisma.dataSubjectRequest.deleteMany({ where: { id: { in: [ids.dsrOpen, ids.dsrStuck] } } });
        await appPrisma.tenantMembership.deleteMany({ where: { tenantId: ids.tenant } });
        await appPrisma.user.deleteMany({ where: { id: { in: [ids.subject, ids.handler] } } });
        if (ids.tenant) await appPrisma.tenant.deleteMany({ where: { id: ids.tenant } });
    });

    it('decrypts v1 under the global key and v2 under the handler workspace key', async () => {
        const r = await decryptLegacyDsrFields(db);
        const row = await appPrisma.dataSubjectRequest.findUnique({ where: { id: ids.dsrOpen } });
        expect(r.decrypted).toBeGreaterThanOrEqual(2);
        expect(row?.rejectionReason).toBe('IDENTITY_NOT_VERIFIED');
        expect(row?.fulfilmentNotes).toBe('Checked with the subject by phone.');
        // The STORED values, not the client's view: the middleware decrypts a
        // field named like a manifest field on read, so only SQL shows whether
        // the column itself is plaintext now.
        const stored = await appPrisma.$queryRaw<{ rejectionReason: string; fulfilmentNotes: string }[]>`
            SELECT "rejectionReason", "fulfilmentNotes" FROM "DataSubjectRequest" WHERE "id" = ${ids.dsrOpen}`;
        expect(stored[0]).toEqual({
            rejectionReason: 'IDENTITY_NOT_VERIFIED',
            fulfilmentNotes: 'Checked with the subject by phone.',
        });
    });

    it('leaves a value no candidate key opens as it is, and counts it', async () => {
        const before = await appPrisma.dataSubjectRequest.findUnique({ where: { id: ids.dsrStuck } });
        const r = await decryptLegacyDsrFields(db);
        expect(r.undecryptable).toBeGreaterThanOrEqual(1);
        const after = await appPrisma.dataSubjectRequest.findUnique({ where: { id: ids.dsrStuck } });
        expect(after?.fulfilmentNotes).toBe(before?.fulfilmentNotes);
        expect(after?.fulfilmentNotes?.startsWith('v2:')).toBe(true);
    });

    it('a new write is stored as plaintext now the model is out of the manifest', async () => {
        const created = await appPrisma.dataSubjectRequest.create({
            data: { userId: ids.subject, type: 'EXPORT', status: 'RECEIVED', fulfilmentNotes: 'Plain note.' },
        });
        try {
            const stored = await appPrisma.$queryRaw<{ fulfilmentNotes: string }[]>`
                SELECT "fulfilmentNotes" FROM "DataSubjectRequest" WHERE "id" = ${created.id}`;
            expect(stored[0].fulfilmentNotes).toBe('Plain note.');
        } finally {
            await appPrisma.dataSubjectRequest.delete({ where: { id: created.id } });
        }
    });

    it('rewrites nothing that is already plaintext', async () => {
        const r = await decryptLegacyDsrFields(db);
        expect(r.decrypted).toBe(0);
    });
});
