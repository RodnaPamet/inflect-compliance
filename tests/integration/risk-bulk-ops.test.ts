/**
 * Two-tenant behavioural tests for the risk bulk-action usecases.
 *
 * WHY THIS EXISTS: `bulkDeleteRisk` is a DESTRUCTIVE multi-tenant bulk
 * operation, and until now the only thing standing behind it was a
 * structural grep asserting the source mentions a tenant filter. That
 * proves a filter is SPELLED, not that a foreign id fails to delete a
 * foreign row — which is the only question that matters for a destructive
 * cross-tenant path.
 *
 * The three usecases guard themselves differently, and the difference is
 * worth testing rather than assuming:
 *
 *   - `bulkDeleteRisk` narrows to `rows.map(r => r.id)` — ids that survived
 *     the tenant-scoped read — before deleting.
 *   - `bulkSetRiskStatus` / `bulkAssignRisk` pass the CALLER'S raw id array
 *     straight to `RiskRepository.bulkUpdate`, relying on that method's own
 *     `tenantId` predicate to drop foreign ids.
 *
 * The second shape is safe today only because `bulkUpdate` filters. These
 * tests pin the OUTCOME, so a future refactor that moves the filter (or
 * swaps in an `updateMany` without one) fails here rather than in
 * production.
 *
 * WHAT THIS ACTUALLY MEASURES — verified, not assumed. Dropping the
 * `tenantId` predicate from `bulkDeleteRisk` and re-running makes the first
 * test FAIL: the foreign risk comes back with a non-null `deletedAt`. So in
 * this harness the application-layer filter is the load-bearing guard and
 * RLS is not silently covering for it (the test connection owns the tables,
 * so the `superuser_bypass` policy applies). In production RLS is a real
 * second layer — but a test that passed only because of it would be
 * measuring the database, not this code, and would go green if the usecase
 * were rewritten wrongly.
 *
 * Every assertion checks the FOREIGN tenant's row afterwards. Asserting
 * only that the call threw, or that the count was right, would pass for an
 * implementation that deleted the foreign row and then reported honestly.
 */
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { ForbiddenError } from '@/lib/errors/types';
import {
    bulkDeleteRisk,
    bulkSetRiskStatus,
    bulkAssignRisk,
} from '@/app-layer/usecases/risk';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

jest.setTimeout(60_000);

const SUITE = `rbulk-${randomUUID().slice(0, 8)}`;
/** The tenant under test. */
const OURS = `t-ours-${SUITE}`;
/** The bystander. Nothing here may ever change. */
const THEIRS = `t-theirs-${SUITE}`;

let adminUserId = '';
let ourMemberId = '';

async function makeUser(label: string): Promise<string> {
    const email = `${SUITE}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return u.id;
}

async function seedRisk(tenantId: string, title: string, status = 'OPEN') {
    const r = await globalPrisma.risk.create({
        data: {
            tenantId,
            title,
            status: status as 'OPEN',
            likelihood: 3,
            impact: 3,
            score: 9,
        },
    });
    return r.id;
}

/** Read a row straight from the DB, bypassing the soft-delete filter. */
async function raw(id: string) {
    const rows = await globalPrisma.$queryRawUnsafe<
        Array<{ id: string; status: string; deletedAt: Date | null; ownerUserId: string | null }>
    >(
        'SELECT id, status::text as status, "deletedAt", "ownerUserId" FROM "Risk" WHERE id = $1',
        id,
    );
    return rows[0];
}

const ctxAs = (role: Role, tenantId = OURS) =>
    makeRequestContext(role, { userId: adminUserId, tenantId });

describeFn('risk bulk actions — two-tenant behaviour', () => {
    beforeAll(async () => {
        for (const [id, slug] of [[OURS, `ours-${SUITE}`], [THEIRS, `theirs-${SUITE}`]]) {
            await globalPrisma.tenant.upsert({
                where: { id },
                update: {},
                create: { id, name: `t ${slug}`, slug },
            });
        }
        adminUserId = await makeUser('admin');
        ourMemberId = await makeUser('member');
        await globalPrisma.tenantMembership.create({
            data: { tenantId: OURS, userId: ourMemberId, role: 'EDITOR', status: 'ACTIVE' },
        });
    });

    afterAll(async () => {
        for (const tenantId of [OURS, THEIRS]) {
            await globalPrisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => {});
            await globalPrisma.riskScoreEvent.deleteMany({ where: { tenantId } }).catch(() => {});
            await globalPrisma.risk.deleteMany({ where: { tenantId } }).catch(() => {});
            await globalPrisma.tenantMembership.deleteMany({ where: { tenantId } }).catch(() => {});
            await globalPrisma.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
        }
        await globalPrisma.user
            .deleteMany({ where: { id: { in: [adminUserId, ourMemberId] } } })
            .catch(() => {});
        await globalPrisma.$disconnect().catch(() => {});
    });

    // ─── bulkDeleteRisk — the destructive path ───

    describe('bulkDeleteRisk', () => {
        it('does not delete another tenant’s risk named in the id array', async () => {
            const mine = await seedRisk(OURS, 'mine to delete');
            const theirs = await seedRisk(THEIRS, 'must survive');

            const res = await bulkDeleteRisk(ctxAs('ADMIN'), [mine, theirs]);

            // The count reflects only rows we were allowed to touch…
            expect(res).toEqual({ deleted: 1 });
            // …ours is soft-deleted…
            expect((await raw(mine))!.deletedAt).not.toBeNull();
            // …and THEIRS IS UNTOUCHED. This is the assertion the structural
            // grep could never make.
            expect((await raw(theirs))!.deletedAt).toBeNull();
        });

        it('deletes nothing at all when every id is foreign', async () => {
            const theirsA = await seedRisk(THEIRS, 'foreign A');
            const theirsB = await seedRisk(THEIRS, 'foreign B');

            const res = await bulkDeleteRisk(ctxAs('ADMIN'), [theirsA, theirsB]);

            expect(res).toEqual({ deleted: 0 });
            expect((await raw(theirsA))!.deletedAt).toBeNull();
            expect((await raw(theirsB))!.deletedAt).toBeNull();
        });

        it('writes one SOFT_DELETE audit row per deleted risk, and none for foreign ids', async () => {
            const a = await seedRisk(OURS, 'audited a');
            const b = await seedRisk(OURS, 'audited b');
            const theirs = await seedRisk(THEIRS, 'not audited');

            await bulkDeleteRisk(ctxAs('ADMIN'), [a, b, theirs]);

            const rows = await globalPrisma.auditLog.findMany({
                // Scoped to this test's ids — earlier tests in this file also
                // soft-delete, so an unscoped query would pick up their rows.
                where: {
                    tenantId: OURS,
                    action: 'SOFT_DELETE',
                    entity: 'Risk',
                    entityId: { in: [a, b, theirs] },
                },
                select: { entityId: true },
            });
            expect(new Set(rows.map((r) => r.entityId))).toEqual(new Set([a, b]));
            // No audit row anywhere claims the foreign risk was deleted.
            expect(
                await globalPrisma.auditLog.count({ where: { entityId: theirs } }),
            ).toBe(0);
        });

        it('requires admin — an EDITOR cannot bulk-delete', async () => {
            const mine = await seedRisk(OURS, 'editor may not delete');

            await expect(bulkDeleteRisk(ctxAs('EDITOR'), [mine])).rejects.toThrow(ForbiddenError);

            expect((await raw(mine))!.deletedAt).toBeNull();
        });

        it('is a no-op on an empty id array', async () => {
            await expect(bulkDeleteRisk(ctxAs('ADMIN'), [])).resolves.toEqual({ deleted: 0 });
        });
    });

    // ─── bulkSetRiskStatus / bulkAssignRisk — raw ids reach bulkUpdate ───

    describe('bulkSetRiskStatus', () => {
        it('leaves another tenant’s status untouched', async () => {
            const mine = await seedRisk(OURS, 'mine status', 'OPEN');
            const theirs = await seedRisk(THEIRS, 'theirs status', 'OPEN');

            const res = await bulkSetRiskStatus(ctxAs('ADMIN'), [mine, theirs], 'MITIGATED');

            expect(res).toEqual({ updated: 1 });
            expect((await raw(mine))!.status).toBe('MITIGATED');
            expect((await raw(theirs))!.status).toBe('OPEN');
        });

        it('accepts MITIGATED — the state the single-risk route used to reject', async () => {
            // Companion to tests/unit/risk-status-enum-parity.test.ts: the bulk
            // path always accepted MITIGATED while PATCH /status 400'd on it,
            // which is how the divergence stayed invisible.
            const mine = await seedRisk(OURS, 'bulk mitigated', 'OPEN');
            await bulkSetRiskStatus(ctxAs('ADMIN'), [mine], 'MITIGATED');
            expect((await raw(mine))!.status).toBe('MITIGATED');
        });

        it('requires write access', async () => {
            const mine = await seedRisk(OURS, 'reader may not', 'OPEN');
            await expect(
                bulkSetRiskStatus(ctxAs('READER'), [mine], 'CLOSED'),
            ).rejects.toThrow(ForbiddenError);
            expect((await raw(mine))!.status).toBe('OPEN');
        });

        it('is a no-op on an empty id array', async () => {
            await expect(
                bulkSetRiskStatus(ctxAs('ADMIN'), [], 'CLOSED'),
            ).resolves.toEqual({ updated: 0 });
        });
    });

    describe('bulkAssignRisk', () => {
        it('leaves another tenant’s owner untouched', async () => {
            const mine = await seedRisk(OURS, 'mine assign');
            const theirs = await seedRisk(THEIRS, 'theirs assign');

            const res = await bulkAssignRisk(ctxAs('ADMIN'), [mine, theirs], ourMemberId);

            expect(res).toEqual({ updated: 1 });
            expect((await raw(mine))!.ownerUserId).toBe(ourMemberId);
            expect((await raw(theirs))!.ownerUserId).toBeNull();
        });

        it('clears the owner when passed null', async () => {
            const mine = await seedRisk(OURS, 'mine unassign');
            await bulkAssignRisk(ctxAs('ADMIN'), [mine], ourMemberId);
            expect((await raw(mine))!.ownerUserId).toBe(ourMemberId);

            await bulkAssignRisk(ctxAs('ADMIN'), [mine], null);
            expect((await raw(mine))!.ownerUserId).toBeNull();
        });

        it('rejects an owner who is not an active member of this tenant', async () => {
            // `Risk.ownerUserId` is an FK to the GLOBAL User table, so the
            // database would happily accept a stranger; only the usecase's
            // membership check stands between a bulk-assign and handing rows
            // to someone outside the tenant.
            const mine = await seedRisk(OURS, 'stranger assign');
            const stranger = await makeUser('stranger');

            await expect(
                bulkAssignRisk(ctxAs('ADMIN'), [mine], stranger),
            ).rejects.toThrow();

            expect((await raw(mine))!.ownerUserId).toBeNull();
            await globalPrisma.user.deleteMany({ where: { id: stranger } }).catch(() => {});
        });

        it('requires write access', async () => {
            const mine = await seedRisk(OURS, 'reader may not assign');
            await expect(
                bulkAssignRisk(ctxAs('READER'), [mine], ourMemberId),
            ).rejects.toThrow(ForbiddenError);
            expect((await raw(mine))!.ownerUserId).toBeNull();
        });

        it('is a no-op on an empty id array', async () => {
            await expect(
                bulkAssignRisk(ctxAs('ADMIN'), [], null),
            ).resolves.toEqual({ updated: 0 });
        });
    });
});
