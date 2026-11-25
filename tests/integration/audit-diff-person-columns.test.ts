/**
 * The audit extension names a person column and never records its value
 * (#5950 part 2, owner decision 2026-11-25), through the real extended client
 * and a real tenant transaction.
 *
 * `buildDiffJson` (src/lib/prisma.ts) writes, for every update / upsert in a
 * tenant context, the changed columns' values into `diffJson.after` /
 * `diffJson.before` and `detailsJson.after`. An HRIS sync upsert is exactly
 * that, and it used to put the before and after of an employee's name and work
 * address into an immutable, SIEM-streamed row. Now a `PERSON_COLUMNS` column
 * is listed in `changedFields` and `withheldFields`, and its value is nowhere.
 */
import { randomBytes } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { __resetAuditStreamForTests } from '@/app-layer/events/audit-stream';
import { runInTenantContext } from '@/lib/db-context';
import { hashForLookup } from '@/lib/security/encryption';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(60_000);

const stamp = randomBytes(4).toString('hex');
const OLD_NAME = `Old Person ${stamp}`;
const NEW_NAME = `New Person ${stamp}`;
const OLD_EMAIL = `old-${stamp}@example.test`;
const NEW_EMAIL = `new-${stamp}@example.test`;

describeFn('the audit diff names a person column without its value (#5950)', () => {
    let prisma: PrismaClient;
    let tenantId: string;
    let employeeId: string;
    let actorId: string;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        const tenant = await prisma.tenant.create({
            data: { name: `Person columns ${stamp}`, slug: `person-cols-${stamp}` },
        });
        tenantId = tenant.id;
        // The row's actor is a real user: `AuditLog.userId` is a foreign key,
        // and a write the audit writer cannot insert is swallowed, not thrown.
        const actorEmail = `actor-${stamp}@example.test`;
        const actor = await prisma.user.create({
            data: { email: actorEmail, emailHash: hashForLookup(actorEmail) },
        });
        actorId = actor.id;
        const employee = await prisma.employee.create({
            data: {
                tenantId,
                fullName: OLD_NAME,
                givenName: 'Old',
                workEmail: OLD_EMAIL,
                jobTitle: 'Analyst',
            },
        });
        employeeId = employee.id;
    });

    afterAll(async () => {
        if (tenantId) {
            await deleteAuditRowsForTenants(prisma, tenantId);
            await prisma.employee.deleteMany({ where: { tenantId } });
            await prisma.tenant.deleteMany({ where: { id: tenantId } });
        }
        if (actorId) {
            await prisma.user.deleteMany({ where: { id: actorId } });
        }
        await prisma.$disconnect();
        __resetAuditStreamForTests();
    });

    it('an Employee update names fullName and workEmail, records neither value, and keeps jobTitle', async () => {
        const ctx = makeRequestContext('ADMIN', { tenantId, userId: actorId, requestId: `req-${stamp}` });
        await runInTenantContext(ctx, (db) =>
            db.employee.update({
                where: { id: employeeId },
                // `givenName` is named with its stored value: compared, not changed.
                data: { fullName: NEW_NAME, givenName: 'Old', workEmail: NEW_EMAIL, jobTitle: 'Lead' },
            }),
        );

        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId, entity: 'Employee', action: 'UPDATE', entityId: employeeId },
            orderBy: { createdAt: 'desc' },
        });
        const diff = row.diffJson as Record<string, unknown>;
        const details = row.detailsJson as Record<string, unknown>;

        // Diffed against the prior row, so the comparison is evidence.
        expect(diff.changedFieldsAreDiffed).toBe(true);
        // Named: the trail still says the name and the address changed…
        expect(diff.changedFields).toEqual(expect.arrayContaining(['fullName', 'workEmail', 'jobTitle']));
        expect(diff.changedFields).not.toContain('givenName');
        expect(diff.withheldFields).toEqual(['fullName', 'workEmail']);
        expect(details.withheldFields).toEqual(['fullName', 'workEmail']);
        // …and the record it is about, by id.
        expect(row.entityId).toBe(employeeId);

        // Never recorded, in either column, old or new.
        const stored = JSON.stringify({ diff, details, metadata: row.metadataJson, text: row.details });
        for (const value of [OLD_NAME, NEW_NAME, OLD_EMAIL, NEW_EMAIL]) {
            expect(stored).not.toContain(value);
        }
        expect(diff.after).not.toHaveProperty('fullName');
        expect(diff.before).not.toHaveProperty('workEmail');

        // A column that names no person keeps its before and after.
        expect(diff.after).toEqual({ jobTitle: 'Lead' });
        expect(diff.before).toEqual({ jobTitle: 'Analyst' });
        expect(details.after).toEqual({ jobTitle: 'Lead' });
    });
});
