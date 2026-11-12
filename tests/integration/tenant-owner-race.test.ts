/**
 * #5388 — two tenant OWNERs changing each other at once never leave a tenant
 * with no ACTIVE OWNER.
 *
 *   - THE TRIGGER, raw SQL with explicit ordering: transaction 1 demotes (or
 *     deactivates) OWNER B and holds; transaction 2 demotes (or deletes) OWNER
 *     A. Without serialisation both counts see the other row still an ACTIVE
 *     OWNER and both commit — zero owners. With it, transaction 2 waits on the
 *     per-tenant lock and, once 1 commits, its count sees the change and is
 *     refused (P0001).
 *   - THE USECASES: A demotes B while B demotes A; A deactivates B while B
 *     demotes A; A removes B while B demotes A — each started behind a held
 *     lock so both have been issued before either writes. Exactly one
 *     succeeds; the other gets the usecase's own last-OWNER refusal (403), not
 *     the trigger's raw P0001; one owner remains.
 *   - THE TRANSFER still promotes before it demotes under the lock, and racing
 *     the deactivation of its incoming owner it leaves an ACTIVE OWNER with a
 *     typed refusal for whichever loses.
 *
 * Tenants are left in place: `resetDatabase` truncates between suites.
 */
import type { PrismaClient, Role } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import {
    deactivateTenantMember,
    removeTenantMember,
    updateTenantMemberRole,
} from '@/app-layer/usecases/tenant-admin';
import { createTenantWithOwner, transferTenantOwnership } from '@/app-layer/usecases/tenant-lifecycle';
import { tenantOwnerLockKey } from '@/app-layer/usecases/tenant-owner-lock';
import type { RequestContext } from '@/app-layer/types';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const SUITE = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext($1))`;
const TX = { timeout: 30_000, maxWait: 30_000 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Resolves `true` once `p` settles, or `false` after `ms`. */
const settlesWithin = (p: Promise<unknown>, ms: number) =>
    Promise.race([p.then(() => true, () => true), sleep(ms).then(() => false)]);

describeFn('the tenant last-OWNER guard serialises per tenant (#5388)', () => {
    let prisma: PrismaClient;
    let seq = 0;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    type Member = { userId: string; membershipId: string; ctx: RequestContext };

    function ctxFor(tenantId: string, slug: string, userId: string, role: Role): RequestContext {
        return makeRequestContext(role, {
            requestId: `req-${userId}`,
            userId,
            tenantId,
            tenantSlug: slug,
            appPermissions: getPermissionsForRole(role),
        });
    }

    async function addMember(tenantId: string, slug: string, label: string, role: Role): Promise<Member> {
        const email = `${label}-${seq++}-${SUITE}@example.com`;
        const user = await prisma.user.create({ data: { email, name: label }, select: { id: true } });
        const m = await prisma.tenantMembership.create({
            data: { tenantId, userId: user.id, role, status: 'ACTIVE' },
            select: { id: true },
        });
        return { userId: user.id, membershipId: m.id, ctx: ctxFor(tenantId, slug, user.id, role) };
    }

    /** A tenant with two ACTIVE OWNERs, A (the creator) and B. */
    async function twoOwners(label: string) {
        const slug = `race-${label}-${seq++}-${SUITE}`;
        const created = await createTenantWithOwner({
            name: `Race ${label}`,
            slug,
            ownerEmail: `race-${label}-a-${seq++}-${SUITE}@example.com`,
            requestId: `req-${label}`,
        });
        const tenantId = created.tenant.id;
        const aRow = await prisma.tenantMembership.findFirstOrThrow({
            where: { tenantId, userId: created.ownerUserId },
            select: { id: true },
        });
        const a: Member = {
            userId: created.ownerUserId,
            membershipId: aRow.id,
            ctx: ctxFor(tenantId, slug, created.ownerUserId, 'OWNER'),
        };
        const b = await addMember(tenantId, slug, `${label}-b`, 'OWNER');
        return { tenantId, slug, a, b };
    }

    const activeOwners = (tenantId: string) =>
        prisma.tenantMembership.count({ where: { tenantId, role: 'OWNER', status: 'ACTIVE' } });

    /**
     * Hold the tenant's owner lock in a transaction of its own until
     * `release()`, so every call issued meanwhile queues on it — when the
     * calls take it. Calls that do not take it are not held by it at all.
     */
    async function holdOwnerLock(tenantId: string) {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let locked!: () => void;
        const isLocked = new Promise<void>((r) => (locked = r));
        const done = prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(LOCK_SQL, tenantOwnerLockKey(tenantId));
            locked();
            await held;
        }, TX);
        await isLocked;
        return {
            release: async () => {
                release();
                await done;
            },
        };
    }

    async function race(tenantId: string, calls: Array<() => Promise<unknown>>) {
        const barrier = await holdOwnerLock(tenantId);
        const results = Promise.allSettled(calls.map((c) => c()));
        await sleep(150);
        await barrier.release();
        return results;
    }

    describe('the trigger', () => {
        const cases: Array<{ name: string; first: string; second: string }> = [
            {
                name: 'demote B, then demote A',
                first: `UPDATE "TenantMembership" SET "role" = 'ADMIN' WHERE "id" = $1`,
                second: `UPDATE "TenantMembership" SET "role" = 'ADMIN' WHERE "id" = $1`,
            },
            {
                name: 'deactivate B, then delete A',
                first: `UPDATE "TenantMembership" SET "status" = 'DEACTIVATED' WHERE "id" = $1`,
                second: `DELETE FROM "TenantMembership" WHERE "id" = $1`,
            },
        ];

        it.each(cases)('$name, concurrently: the second waits and is refused', async ({ first, second }) => {
            const { tenantId, a, b } = await twoOwners('trg');

            let release!: () => void;
            const held = new Promise<void>((r) => (release = r));
            let changedB!: () => void;
            const bChanged = new Promise<void>((r) => (changedB = r));

            // Transaction 1 changes B (A is still an owner, so its count
            // passes) and stays open.
            const t1 = prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(first, b.membershipId);
                changedB();
                await held;
            }, TX);
            await bChanged;

            // Transaction 2 changes A while 1 is uncommitted.
            const t2 = prisma
                .$transaction(async (tx) => {
                    await tx.$executeRawUnsafe(second, a.membershipId);
                }, TX)
                .then(
                    () => 'committed' as const,
                    (e: unknown) => e,
                );

            // It must WAIT for transaction 1 — it touches a different row, so
            // nothing but the per-tenant lock can hold it.
            expect(await settlesWithin(t2, 500)).toBe(false);

            release();
            await t1;
            const outcome = await t2;
            expect(outcome).not.toBe('committed');
            expect(String((outcome as Error).message)).toMatch(/LAST_OWNER_GUARD/);

            expect(await activeOwners(tenantId)).toBe(1);
            const aNow = await prisma.tenantMembership.findUnique({ where: { id: a.membershipId } });
            expect(aNow).toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
        });
    });

    describe('the member usecases', () => {
        const variants: Array<{ name: string; aOnB: (a: Member, b: Member) => Promise<unknown> }> = [
            {
                name: 'A demotes B while B demotes A',
                aOnB: (a, b) => updateTenantMemberRole(a.ctx, { membershipId: b.membershipId, role: 'ADMIN' }),
            },
            {
                name: 'A deactivates B while B demotes A',
                aOnB: (a, b) => deactivateTenantMember(a.ctx, { membershipId: b.membershipId }),
            },
            {
                name: 'A removes B while B demotes A',
                aOnB: (a, b) => removeTenantMember(a.ctx, { membershipId: b.membershipId }),
            },
        ];

        it.each(variants)('$name: exactly one wins, with a typed refusal, and one OWNER remains', async ({ aOnB }) => {
            for (let i = 0; i < 5; i++) {
                const { tenantId, a, b } = await twoOwners(`uc${i}`);

                const [ra, rb] = await race(tenantId, [
                    () => aOnB(a, b),
                    () => updateTenantMemberRole(b.ctx, { membershipId: a.membershipId, role: 'ADMIN' }),
                ]);

                const won = [ra, rb].filter((r) => r.status === 'fulfilled');
                const lost = [ra, rb].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
                expect(won).toHaveLength(1);
                expect(lost).toHaveLength(1);
                expect(lost[0].reason).toMatchObject({ status: 403 });
                // The usecase's own refusal: whichever verb lost the race.
                expect(String(lost[0].reason?.message)).toMatch(/^Cannot (demote|deactivate|remove) the last OWNER/);
                expect(String(lost[0].reason?.message)).not.toMatch(/LAST_OWNER_GUARD|P0001/);
                expect(await activeOwners(tenantId)).toBe(1);
            }
        });
    });

    describe('the ownership transfer', () => {
        async function ownerAndAdmin(label: string) {
            const slug = `xfer-${label}-${seq++}-${SUITE}`;
            const newOwnerEmail = `xfer-${label}-y-${seq++}-${SUITE}@example.com`;
            const created = await createTenantWithOwner({
                name: `Xfer ${label}`,
                slug,
                ownerEmail: `xfer-${label}-x-${seq++}-${SUITE}@example.com`,
                requestId: `req-${label}`,
            });
            const tenantId = created.tenant.id;
            const y = await prisma.user.create({ data: { email: newOwnerEmail, name: 'y' }, select: { id: true } });
            const yRow = await prisma.tenantMembership.create({
                data: { tenantId, userId: y.id, role: 'ADMIN', status: 'ACTIVE' },
                select: { id: true },
            });
            return {
                tenantId,
                xUserId: created.ownerUserId,
                xCtx: ctxFor(tenantId, slug, created.ownerUserId, 'OWNER'),
                yUserId: y.id,
                yMembershipId: yRow.id,
                newOwnerEmail,
            };
        }

        it('promotes the new OWNER and demotes the old one, waiting for the tenant lock', async () => {
            const t = await ownerAndAdmin('ok');
            const barrier = await holdOwnerLock(t.tenantId);
            const transfer = transferTenantOwnership({
                tenantId: t.tenantId,
                currentOwnerUserId: t.xUserId,
                newOwnerEmail: t.newOwnerEmail,
            });
            expect(await settlesWithin(transfer, 400)).toBe(false);
            await barrier.release();
            await expect(transfer).resolves.toEqual({ fromOwnerId: t.xUserId, toOwnerId: t.yUserId });

            const rows = await prisma.tenantMembership.findMany({
                where: { tenantId: t.tenantId },
                select: { userId: true, role: true, status: true },
            });
            expect(rows).toEqual(
                expect.arrayContaining([
                    { userId: t.yUserId, role: 'OWNER', status: 'ACTIVE' },
                    { userId: t.xUserId, role: 'ADMIN', status: 'ACTIVE' },
                ]),
            );
            expect(await activeOwners(t.tenantId)).toBe(1);
        });

        it('racing the deactivation of its incoming owner: an ACTIVE OWNER remains and the loser is refused by name', async () => {
            for (let i = 0; i < 4; i++) {
                const t = await ownerAndAdmin(`rd${i}`);
                const [transfer, deactivate] = await race(t.tenantId, [
                    () =>
                        transferTenantOwnership({
                            tenantId: t.tenantId,
                            currentOwnerUserId: t.xUserId,
                            newOwnerEmail: t.newOwnerEmail,
                        }),
                    () => deactivateTenantMember(t.xCtx, { membershipId: t.yMembershipId }),
                ]);

                expect(await activeOwners(t.tenantId)).toBe(1);
                const settled = [transfer, deactivate];
                expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
                for (const r of settled) {
                    if (r.status === 'rejected') {
                        expect(String(r.reason?.message)).not.toMatch(/LAST_OWNER_GUARD|P0001/);
                        expect(r.reason).toHaveProperty('status');
                    }
                }
            }
        });
    });
});
