/**
 * ControlException purge contract — the SQLSTATE 23502 regression.
 *
 * Before 20260911120000_controlexception_setnull_column_scoped, two
 * composite FKs on `ControlException` were declared plain
 * `ON DELETE SET NULL`:
 *
 *   ControlException_compensatingControlId_tenantId_fkey
 *       ("compensatingControlId", "tenantId") -> Control(id, tenantId)
 *   ControlException_renewedFromId_tenantId_fkey
 *       ("renewedFromId", "tenantId") -> ControlException(id, tenantId)
 *
 * Postgres SET NULL over a multi-column FK nulls EVERY referencing
 * column. Both carry NOT NULL `tenantId`, so the referential action
 * wrote an illegal row and the PARENT DELETE ABORTED:
 *
 *   null value in column "tenantId" of relation "ControlException"
 *   violates not-null constraint
 *
 * The migration re-declares both as column-scoped
 * `ON DELETE SET NULL ("<theFkColumn>")`, which nulls only the pointer.
 *
 * ─── Why these tests exercise DELETEs ──────────────────────────────
 *
 * A test that reads `pg_constraint` and asserts the constraint's shape
 * would have passed against the BUG: plain SET NULL and column-scoped
 * SET NULL both store `confdeltype = 'n'`, and the whole defect lives
 * in `confdelsetcols`. Worse, a definition test cannot show that the
 * delete now SUCCEEDS — which is the entire point of choosing a scoped
 * SET NULL over RESTRICT. So every case below drives a real delete
 * through the real application path:
 *
 *   • `purgeControl` -> `purgeEntity`, the usecase behind
 *     POST /api/t/[tenantSlug]/controls/[controlId]/purge
 *   • `purgeSoftDeletedOlderThan`, the unattended data-lifecycle sweep
 *
 * ─── Negative halves ───────────────────────────────────────────────
 *
 * Each fix case is paired with a refusal case, because a constraint
 * that accepted everything would pass the positives alone and read as
 * working. The pairs prove the two properties the fix must NOT have
 * relaxed: `controlId` still RESTRICTs (you may not purge the control
 * an exception is ABOUT), and the FK is still tenant-carrying (a
 * cross-tenant compensating reference is still unrepresentable).
 */

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { withSoftDeleteExtension } from '@/lib/soft-delete';
import { withPiiEncryptionExtension } from '@/lib/security/pii-middleware';
import { purgeSoftDeletedOlderThan } from '@/app-layer/jobs/data-lifecycle';
import {
    requestException,
    renewException,
    deleteControl,
    purgeControl,
} from '@/app-layer/usecases/control';

/** Raw client — no soft-delete extension, so `.delete()` really deletes. */
const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});

/**
 * Production client composition, mirroring `src/lib/prisma.ts`. The
 * data-lifecycle sweep needs it: `purgeSoftDeletedOlderThan` calls
 * `withDeleted(...)`, whose flag only the soft-delete extension reads.
 */
const appPrisma = withPiiEncryptionExtension(
    withSoftDeleteExtension(
        new PrismaClient({
            adapter: new PrismaPg({ connectionString: DB_URL }),
        }),
    ),
);

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `cepc-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;
const FOREIGN_TENANT_ID = `t-${SUITE_TAG}-other`;

let admin: { userId: string };
let foreignAdmin: { userId: string };
let AFFECTED_CONTROL_ID = '';
let FOREIGN_CONTROL_ID = '';

jest.setTimeout(120_000);

async function makeUser(label: string): Promise<{ userId: string }> {
    const email = `${SUITE_TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return { userId: u.id };
}

/** A fresh tenant-owned control, so each case purges its own row. */
async function makeControl(name: string, tenantId = TENANT_ID): Promise<string> {
    const c = await globalPrisma.control.create({
        data: { tenantId, name: `${SUITE_TAG} ${name}` },
    });
    return c.id;
}

function ctxAsAdmin(tenantId = TENANT_ID) {
    return makeRequestContext(Role.ADMIN, {
        userId: admin.userId,
        tenantId,
        tenantSlug: tenantId,
    });
}

/** Read a ControlException with the raw client (no soft-delete filter). */
async function readException(id: string) {
    const rows = await globalPrisma.$queryRawUnsafe<
        Array<{
            id: string;
            tenantId: string | null;
            controlId: string;
            compensatingControlId: string | null;
            renewedFromId: string | null;
        }>
    >(
        `SELECT "id", "tenantId", "controlId", "compensatingControlId", "renewedFromId"
           FROM "ControlException" WHERE "id" = $1`,
        id,
    );
    return rows[0] ?? null;
}

async function controlExists(id: string): Promise<boolean> {
    const rows = await globalPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*) AS n FROM "Control" WHERE "id" = $1`,
        id,
    );
    return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Create the row shape the API actually produces: an exception on
 * `AFFECTED_CONTROL_ID`, compensated by a DIFFERENT control.
 * `RequestExceptionSchema`'s superRefine requires the two to differ, so
 * this is the only shape reachable with a compensating control at all.
 */
async function makeExceptionCompensatedBy(
    compensatingControlId: string,
): Promise<string> {
    const { exceptionId } = await requestException(ctxAsAdmin(), {
        controlId: AFFECTED_CONTROL_ID,
        justification: 'compensated elsewhere',
        compensatingControlId,
        riskAcceptedByUserId: admin.userId,
    });
    return exceptionId;
}

async function seed() {
    for (const [id, slug] of [
        [TENANT_ID, SUITE_TAG],
        [FOREIGN_TENANT_ID, `${SUITE_TAG}-other`],
    ] as const) {
        await globalPrisma.tenant.upsert({
            where: { id },
            update: {},
            create: { id, name: `t ${slug}`, slug },
        });
    }
    admin = await makeUser('admin');
    foreignAdmin = await makeUser('foreign');
    await globalPrisma.tenantMembership.createMany({
        data: [
            {
                tenantId: TENANT_ID,
                userId: admin.userId,
                role: Role.ADMIN,
                status: MembershipStatus.ACTIVE,
            },
            {
                tenantId: FOREIGN_TENANT_ID,
                userId: foreignAdmin.userId,
                role: Role.ADMIN,
                status: MembershipStatus.ACTIVE,
            },
        ],
    });
    AFFECTED_CONTROL_ID = await makeControl('affected control');
    FOREIGN_CONTROL_ID = await makeControl('foreign control', FOREIGN_TENANT_ID);
}

async function teardown() {
    const tenantIds = [TENANT_ID, FOREIGN_TENANT_ID];
    // Raw, and exceptions before controls: `controlId` is RESTRICT, so
    // deleting the controls first is refused — the DB behaving correctly.
    await globalPrisma.$executeRawUnsafe(
        `DELETE FROM "ControlException" WHERE "tenantId" = ANY($1::text[])`,
        tenantIds,
    );
    await globalPrisma.$executeRawUnsafe(
        `DELETE FROM "Control" WHERE "tenantId" = ANY($1::text[])`,
        tenantIds,
    );
    await globalPrisma.tenantMembership.deleteMany({
        where: { tenantId: { in: tenantIds } },
    });
    await globalPrisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
            `SET LOCAL session_replication_role = 'replica'`,
        );
        await tx.$executeRawUnsafe(
            `DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`,
            tenantIds,
        );
    });
    const userIds = [admin, foreignAdmin].filter(Boolean).map((u) => u.userId);
    if (userIds.length > 0) {
        await globalPrisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await globalPrisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await globalPrisma.$disconnect();
    await appPrisma.$disconnect();
}

describeFn('ControlException purge contract — SQLSTATE 23502 regression', () => {
    beforeAll(async () => {
        await seed();
    });

    afterAll(async () => {
        await teardown();
    });

    // ─── compensatingControlId, via the purge ROUTE's usecase ───────

    it('purging a COMPENSATING control succeeds and nulls only the pointer', async () => {
        const compensating = await makeControl('compensating (route)');
        const exceptionId = await makeExceptionCompensatedBy(compensating);

        // `purgeEntity` refuses a row that is not already soft-deleted,
        // so drive the real two-step the route requires.
        await deleteControl(ctxAsAdmin(), compensating);

        // THE REGRESSION. Before the migration this threw
        //   null value in column "tenantId" of relation
        //   "ControlException" violates not-null constraint
        await expect(purgeControl(ctxAsAdmin(), compensating)).resolves.toEqual(
            expect.objectContaining({ purged: true }),
        );

        expect(await controlExists(compensating)).toBe(false);

        // The exception row SURVIVES, still tenant-owned, with only the
        // compensating pointer cleared. `tenantId` surviving is the
        // whole fix: plain SET NULL would have nulled it too.
        const row = await readException(exceptionId);
        expect(row).not.toBeNull();
        expect(row!.tenantId).toBe(TENANT_ID);
        expect(row!.compensatingControlId).toBeNull();
        expect(row!.controlId).toBe(AFFECTED_CONTROL_ID);
    });

    // ─── compensatingControlId, via the data-lifecycle SWEEP ────────

    it('the data-lifecycle sweep purges a COMPENSATING control and the exception survives', async () => {
        const compensating = await makeControl('compensating (sweep)');
        const exceptionId = await makeExceptionCompensatedBy(compensating);

        // Age the soft-delete past the grace window, raw so the
        // extension cannot rewrite it.
        await globalPrisma.$executeRawUnsafe(
            `UPDATE "Control" SET "deletedAt" = now() - interval '365 days' WHERE "id" = $1`,
            compensating,
        );

        // THE REGRESSION, on the unattended path. This is the real job.
        const results = await purgeSoftDeletedOlderThan({
            db: appPrisma,
            tenantId: TENANT_ID,
            graceDays: 90,
        });

        const control = results.find((r) => r.model === 'Control');
        expect(control).toBeDefined();
        expect(control!.purged).toBeGreaterThanOrEqual(1);
        expect(await controlExists(compensating)).toBe(false);

        const row = await readException(exceptionId);
        expect(row).not.toBeNull();
        expect(row!.tenantId).toBe(TENANT_ID);
        expect(row!.compensatingControlId).toBeNull();
    });

    // ─── renewedFromId (self-referential) ───────────────────────────

    it('deleting the PRIOR exception keeps the renewal row and nulls only the lineage pointer', async () => {
        const prior = await makeExceptionCompensatedBy(
            await makeControl('compensating (renewal)'),
        );
        const { exceptionId: renewal, renewedFromId } = await renewException(
            ctxAsAdmin(),
            prior,
            {},
        );
        expect(renewedFromId).toBe(prior);
        expect((await readException(renewal))!.renewedFromId).toBe(prior);

        // No application path hard-deletes a ControlException row today:
        // the model is absent from SOFT_DELETE_MODELS, there is no
        // exception purge route, and ControlExceptionRepository exposes
        // no delete. So this constraint is latent rather than reachable
        // — but it is the SAME defect in the SAME table, it fires on the
        // statement below, and a future exception-purge or retention
        // sweep would land straight on it. Hence the raw DELETE: it is
        // the statement the repo's every other purge path issues.
        await expect(
            globalPrisma.$executeRawUnsafe(
                `DELETE FROM "ControlException" WHERE "id" = $1 AND "tenantId" = $2`,
                prior,
                TENANT_ID,
            ),
        ).resolves.toBe(1);

        expect(await readException(prior)).toBeNull();

        const row = await readException(renewal);
        expect(row).not.toBeNull();
        expect(row!.tenantId).toBe(TENANT_ID);
        expect(row!.renewedFromId).toBeNull();
    });

    // ─── Negative halves ───────────────────────────────────────────

    it('purging the AFFECTED control is still REFUSED (controlId stays RESTRICT)', async () => {
        const affected = await makeControl('affected (restrict)');
        await requestException(ctxAsAdmin(), {
            controlId: affected,
            justification: 'cannot implement as designed',
            riskAcceptedByUserId: admin.userId,
        });

        await deleteControl(ctxAsAdmin(), affected);
        await expect(purgeControl(ctxAsAdmin(), affected)).rejects.toThrow();

        // Refused, not silently swallowed — the control is still there.
        expect(await controlExists(affected)).toBe(true);
    });

    it('a cross-tenant compensating reference is still UNREPRESENTABLE', async () => {
        const exceptionId = await makeExceptionCompensatedBy(
            await makeControl('compensating (cross-tenant)'),
        );

        // Raw and owner-privileged, so RLS is not what refuses this —
        // the composite FK is. Scoping SET NULL to one column must not
        // have cost the tenant-carrying property.
        await expect(
            globalPrisma.$executeRawUnsafe(
                `UPDATE "ControlException" SET "compensatingControlId" = $1 WHERE "id" = $2`,
                FOREIGN_CONTROL_ID,
                exceptionId,
            ),
        ).rejects.toThrow(
            /ControlException_compensatingControlId_tenantId_fkey/,
        );

        expect((await readException(exceptionId))!.tenantId).toBe(TENANT_ID);
    });

    // ─── Definition check, as a diagnostic only ────────────────────

    it('both constraints are column-scoped in the live database', async () => {
        // Secondary to the delete-exercising cases above: this exists to
        // name the mechanism when one of them fails, not to stand in for
        // them. `confdeltype` alone cannot tell the fix from the bug —
        // both are 'n' — so assert the scoped column BY NAME.
        const rows = await globalPrisma.$queryRawUnsafe<
            Array<{ conname: string; scoped: string | null; deltype: string }>
        >(
            `SELECT c.conname,
                    c.confdeltype::text AS deltype,
                    (SELECT a.attname FROM pg_attribute a
                      WHERE a.attrelid = c.conrelid
                        AND a.attnum = c.confdelsetcols[1]) AS scoped
               FROM pg_constraint c
              WHERE c.conrelid = '"ControlException"'::regclass
                AND c.contype = 'f'
                AND c.conname = ANY($1::text[])
              ORDER BY c.conname`,
            [
                'ControlException_compensatingControlId_tenantId_fkey',
                'ControlException_renewedFromId_tenantId_fkey',
            ],
        );

        expect(rows).toEqual([
            {
                conname:
                    'ControlException_compensatingControlId_tenantId_fkey',
                deltype: 'n',
                scoped: 'compensatingControlId',
            },
            {
                conname: 'ControlException_renewedFromId_tenantId_fkey',
                deltype: 'n',
                scoped: 'renewedFromId',
            },
        ]);
    });
});
