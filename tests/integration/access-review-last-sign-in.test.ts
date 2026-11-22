/**
 * An access review's "Last sign-in" is the member's latest sign-in across
 * every session they have had (#5106).
 *
 * It used to read this tenant's live sessions only. A session is stamped with
 * the person's PRIMARY workspace, so a member whose oldest membership is
 * another workspace read "Never" here, and so did everybody after a Revoke
 * All. Both cases are set up below: the only session is stamped with the other
 * tenant, and it is revoked.
 */
import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { randomUUID } from 'node:crypto';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { latestSignInByUser } from '@/lib/security/session-tracker';

jest.setTimeout(30_000);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

describeFn('latestSignInByUser (#5106)', () => {
    let db: PrismaClient;
    const suffix = `last-sign-in-${Date.now()}`;
    const slugs = [`${suffix}-primary`, `${suffix}-reviewed`];
    const emails = [`${suffix}-a@example.com`, `${suffix}-b@example.com`];
    let userA: string;
    let userB: string;
    const earlier = new Date('2026-10-01T09:00:00Z');
    const later = new Date('2026-11-02T09:00:00Z');

    beforeAll(async () => {
        db = prismaTestClient();
        await db.$connect();
        const primary = await createTenantWithDek({ name: 'Primary', slug: slugs[0] });
        await createTenantWithDek({ name: 'Reviewed', slug: slugs[1] });
        userA = (await db.user.create({ data: { email: emails[0], name: 'A' } })).id;
        userB = (await db.user.create({ data: { email: emails[1], name: 'B' } })).id;

        // A's sessions are stamped with ANOTHER tenant, and both are revoked.
        for (const createdAt of [earlier, later]) {
            await db.userSession.create({
                data: {
                    sessionId: `sid-${randomUUID()}`,
                    userId: userA,
                    tenantId: primary.id,
                    createdAt,
                    expiresAt: new Date(createdAt.getTime() + 60 * 60 * 1000),
                    revokedAt: new Date(createdAt.getTime() + 60 * 1000),
                },
            });
        }
    });

    afterAll(async () => {
        await db.userSession.deleteMany({ where: { userId: { in: [userA, userB] } } });
        await db.tenant.deleteMany({ where: { slug: { in: slugs } } });
        await db.user.deleteMany({ where: { email: { in: emails } } });
        await db.$disconnect();
    });

    it('returns the latest sign-in from a revoked session stamped with another workspace', async () => {
        await expect(latestSignInByUser([userA])).resolves.toEqual({ [userA]: later });
    });

    it('omits a user who has never signed in, so the page reads "Never" only then', async () => {
        await expect(latestSignInByUser([userA, userB])).resolves.toEqual({ [userA]: later });
    });

    it('reads nothing for no users', async () => {
        await expect(latestSignInByUser([])).resolves.toEqual({});
    });
});
