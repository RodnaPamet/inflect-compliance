/**
 * Integration test for `listRisks` owner enrichment — Epic 44.4.
 *
 * Proves that the usecase's batch-fetch path attaches the owner
 * relation as `{ id, name, email }` per risk, even though the
 * Prisma `Risk` model doesn't carry a `@relation` declaration to
 * `User` today. Without this enrichment the page renders '—' in
 * every owner cell.
 */

import * as dotenv from 'dotenv';
import path from 'node:path';
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import type { PrismaClient } from '@prisma/client';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { listRisks } from '@/app-layer/usecases/risk';
import { getPermissionsForRole } from '@/lib/permissions';
import type { RequestContext } from '@/app-layer/types';

// Generous per-test timeout — listRisks routes through `cachedListRead`
// (Redis-backed) and runs an extra batch user fetch + tenant-context
// guard hops; the 5s Jest default trips on cold-cache runs.
jest.setTimeout(30_000);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

function ctxFor(tenantId: string, userId: string): RequestContext {
    const appPermissions = getPermissionsForRole('ADMIN');
    return {
        requestId: `risks-test-${Date.now()}`,
        userId,
        tenantId,
        role: 'ADMIN',
        permissions: {
            canRead: true,
            canWrite: true,
            canAdmin: true,
            canAudit: true,
            canExport: true,
        },
        appPermissions,
    };
}

describeFn('listRisks — owner enrichment (Epic 44.4)', () => {
    let testPrisma: PrismaClient;
    let tenantA: string;
    let aliceId: string;
    let bobId: string;
    const slugs: string[] = [];
    const emails: string[] = [];

    beforeAll(async () => {
        testPrisma = prismaTestClient();
        await testPrisma.$connect();

        const suffix = `risks-owner-${Date.now()}`;
        const aSlug = `${suffix}-a`;
        slugs.push(aSlug);

        const a = await createTenantWithDek({ name: 'A', slug: aSlug });
        tenantA = a.id;

        const aliceEmail = `alice-${suffix}@example.com`;
        const bobEmail = `bob-${suffix}@example.com`;
        emails.push(aliceEmail, bobEmail);

        const alice = await testPrisma.user.create({
            data: { email: aliceEmail, name: 'Alice Anderson' },
        });
        const bob = await testPrisma.user.create({
            data: { email: bobEmail, name: 'Bob Boss' },
        });
        aliceId = alice.id;
        bobId = bob.id;

        // Three risks: Alice owns one, Bob owns one, the third has no
        // owner. Owner enrichment must surface the right user per row
        // and cleanly produce `null` for the unowned row.
        await testPrisma.risk.createMany({
            data: [
                {
                    tenantId: tenantA,
                    title: 'Supply chain breach',
                    likelihood: 5,
                    impact: 5,
                    inherentScore: 25,
                    score: 25,
                    ownerUserId: aliceId,
                },
                {
                    tenantId: tenantA,
                    title: 'Insider data exfil',
                    likelihood: 4,
                    impact: 4,
                    inherentScore: 16,
                    score: 16,
                    ownerUserId: bobId,
                },
                {
                    tenantId: tenantA,
                    title: 'Office break-in',
                    likelihood: 2,
                    impact: 1,
                    inherentScore: 2,
                    score: 2,
                    ownerUserId: null,
                },
            ],
        });
    });

    afterAll(async () => {
        try {
            await testPrisma.risk.deleteMany({
                where: { tenantId: tenantA },
            });
            await testPrisma.tenant.deleteMany({
                where: { slug: { in: slugs } },
            });
            await testPrisma.user.deleteMany({
                where: { email: { in: emails } },
            });
        } catch {
            /* best effort */
        }
        await testPrisma.$disconnect();
    });

    test('attaches owner=null for risks with no ownerUserId', async () => {
        const ctx = ctxFor(tenantA, aliceId);
        // listRisks's TS return type follows the Prisma row shape;
        // the owner field is added at the usecase boundary, so the
        // test casts via `unknown` to bridge.
        const risks = (await listRisks(ctx)) as unknown as Array<{
            title: string;
            owner: unknown;
        }>;
        const breakIn = risks.find((r) => r.title === 'Office break-in')!;
        expect(breakIn.owner).toBeNull();
    });

    test('attaches owner={id,name,email} for owned risks', async () => {
        const ctx = ctxFor(tenantA, aliceId);
        const risks = (await listRisks(ctx)) as unknown as Array<{
            title: string;
            owner: { id: string; name: string | null; email: string | null } | null;
        }>;
        const supply = risks.find((r) => r.title === 'Supply chain breach')!;
        expect(supply.owner).toEqual({
            id: aliceId,
            name: 'Alice Anderson',
            email: expect.stringContaining('alice'),
        });
        const insider = risks.find((r) => r.title === 'Insider data exfil')!;
        expect(insider.owner).toEqual({
            id: bobId,
            name: 'Bob Boss',
            email: expect.stringContaining('bob'),
        });
    });

    test('does single batched user lookup regardless of risk count', async () => {
        // Sanity proxy: no error / timeout on a 3-risk page is the
        // weak signal; the structural ratchet pins the implementation
        // shape (`db.user.findMany({ where: { id: { in: ids } } })`).
        const ctx = ctxFor(tenantA, aliceId);
        const risks = await listRisks(ctx);
        expect(Array.isArray(risks)).toBe(true);
        expect((risks as unknown[]).length).toBe(3);
    });

    test('the list row carries the decomposed residual dimensions (RQ2-9)', async () => {
        // Rehomed from the deleted `tests/guards/rq2-9-matrix-movement.test.ts`,
        // which asserted `RiskRepository.ts` contains the literal strings
        // `residualLikelihood: true` / `residualImpact: true` in its select.
        //
        // The matrix movement overlay draws an arrow from a risk's inherent
        // cell to its residual cell, so it needs BOTH dimensions on the list
        // row — a rollup `residualScore` has no destination cell. Dropping
        // either field from the select silently empties the overlay rather
        // than erroring, so it is worth an assertion; but the assertion
        // belongs on the returned ROW, which survives renaming the select.
        const ctx = ctxFor(tenantA, aliceId);
        const risks = (await listRisks(ctx)) as unknown as Array<Record<string, unknown>>;
        expect(risks.length).toBeGreaterThan(0);
        for (const key of ['residualLikelihood', 'residualImpact']) {
            expect(Object.keys(risks[0])).toContain(key);
        }
    });
});
