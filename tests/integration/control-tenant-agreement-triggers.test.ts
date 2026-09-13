/**
 * #2532 — the four `Control` references #2356 could not convert.
 *
 * ─── Why these four are triggers and not composite FKs ─────────────
 *
 * `Control.tenantId` is NULLABLE BY DESIGN. A NULL tenant is a GLOBAL LIBRARY
 * control, shared by every tenant: `Control_annexId_global_key` is a partial
 * unique index `WHERE "tenantId" IS NULL`, six read sites scope with
 * `OR: [{tenantId}, {tenantId: null}]`, and `usecases/control/mutations.ts`
 * refuses to update, re-status or delete a row whose tenant is NULL.
 *
 * A composite FK carrying `tenantId` cannot reference such a row — the child's
 * tenant is NOT NULL and the parent's is NULL — so converting these four would
 * have DELETED the shared catalogue rather than tightened anything. The trigger
 * enforces the same tenant agreement with the one exemption the FK cannot
 * express.
 *
 * ─── Why raw SQL ───────────────────────────────────────────────────
 *
 * The usecase layer already refuses cross-tenant writes, so a test going
 * through it would pass against a database with NO trigger at all. Postgres
 * runs these as the table owner and bypasses RLS, exactly as an FK check does.
 *
 * ─── Why every case builds its own control ─────────────────────────
 *
 * A shared parent silently transfers ownership of an error between cases: the
 * previous case's leftover state trips, and its message prints under this
 * case's label. Each case below therefore carries a control of its own AND
 * asserts a positive witness of its own effect — the surviving row's column
 * values — rather than only the absence of an error.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'ctl-tenant-t1';
const T2 = 'ctl-tenant-t2';
const ACTOR_EMAIL = 'ctl-tenant-actor@example.test';
let actorId = '';

/** The four guarded columns, and the trigger that guards each. */
const GUARDED: ReadonlyArray<{ trigger: string; table: string; col: string }> = [
    { trigger: 'finding_control_tenant_trg', table: 'Finding', col: 'controlId' },
    { trigger: 'finding_compensating_control_tenant_trg', table: 'Finding', col: 'compensatingControlId' },
    { trigger: 'task_control_tenant_trg', table: 'Task', col: 'controlId' },
    { trigger: 'integration_execution_control_tenant_trg', table: 'IntegrationExecution', col: 'controlId' },
];

async function failureOf(sql: string, ...params: unknown[]): Promise<string> {
    try { await prisma.$executeRawUnsafe(sql, ...params); }
    catch (err) { return err instanceof Error ? err.message : String(err); }
    throw new Error(`EXPECTED THE DATABASE TO REFUSE THIS WRITE, but it succeeded:\n${sql}`);
}

/** A control owned by `tenantId`, or the shared catalogue when null. */
const control = (id: string, tenantId: string | null) =>
    prisma.control.create({ data: { id, tenantId, name: `probe ${id}` } });

const insertFinding = (id: string, tenantId: string, col: string, controlId: string) =>
    prisma.$executeRawUnsafe(
        `INSERT INTO "Finding" ("id","tenantId","${col}","severity","type","title","description","updatedAt")
         VALUES ($1,$2,$3,'LOW','OBSERVATION','probe','probe',NOW())`,
        id, tenantId, controlId,
    );

async function clearProbeRows() {
    await resetDatabase(prisma);
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.task.deleteMany({ where: t });
    await prisma.integrationExecution.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    // Global library rows carry no tenant, so the tenant-scoped delete above
    // cannot reach them — they are named explicitly or they survive the run
    // and collide with the next one on `Control_annexId_global_key`.
    await prisma.control.deleteMany({ where: { OR: [t, { name: { startsWith: 'probe ctl-' } }] } });
    await deleteAuditRowsForTenants(prisma, [T1, T2]);
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
    await prisma.user.deleteMany({ where: { email: ACTOR_EMAIL } });
}

beforeAll(async () => {
    await clearProbeRows();
    for (const id of [T1, T2]) await prisma.tenant.create({ data: { id, name: id, slug: id } });
    const actor = await prisma.user.create({ data: { email: ACTOR_EMAIL, name: 'ctl tenant actor' } });
    actorId = actor.id;
    for (const id of [T1, T2]) {
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId: actorId, role: 'OWNER', status: 'ACTIVE' },
        });
    }
});

afterAll(async () => { await clearProbeRows(); await prisma.$disconnect(); });

describe('the five triggers exist, and the capability they protect still does', () => {
    it('all five are installed, BEFORE INSERT OR UPDATE, on the right tables', async () => {
        const rows = await prisma.$queryRawUnsafe<
            Array<{ tgname: string; tbl: string; args: string; enabled: string }>
        >(
            `SELECT t.tgname, c.relname AS tbl,
                    encode(t.tgargs, 'escape') AS args,
                    t.tgenabled::text AS enabled
               FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              WHERE NOT t.tgisinternal`,
        );
        const byName = new Map(rows.map((r) => [r.tgname, r]));

        expect(GUARDED.filter((g) => !byName.has(g.trigger)).map((g) => g.trigger)).toEqual([]);
        expect(GUARDED.filter((g) => byName.get(g.trigger)!.tbl !== g.table).map((g) => g.trigger))
            .toEqual([]);
        // The guarded COLUMN is passed as a trigger argument, and `Finding`
        // carries two triggers that differ ONLY in that argument. A copy-paste
        // that left both pointing at `controlId` would install five triggers,
        // pass every count, and leave `compensatingControlId` unguarded.
        expect(GUARDED.filter((g) => !byName.get(g.trigger)!.args.startsWith(g.col))
            .map((g) => `${g.trigger} -> ${byName.get(g.trigger)!.args}`)).toEqual([]);

        expect(byName.has('control_retenant_trg')).toBe(true);

        // `ALTER TABLE ... DISABLE TRIGGER` leaves the row in `pg_trigger`
        // untouched — same name, same table, same arguments — so every
        // assertion above passes against a database where all five are inert.
        // Measured: disabling the four child triggers reddened the behavioural
        // tests and left this one green. `tgenabled` is the only column that
        // separates installed from enforcing ('O' = enabled, 'D' = disabled).
        const inert = [...GUARDED.map((g) => g.trigger), 'control_retenant_trg']
            .filter((t) => byName.get(t)!.enabled === 'D');
        expect(inert).toEqual([]);
    });

    it('Control.tenantId is still NULLABLE — the exemption must remain reachable', async () => {
        const rows = await prisma.$queryRawUnsafe<Array<{ notnull: boolean }>>(
            `SELECT attnotnull AS notnull FROM pg_attribute
              WHERE attrelid = '"Control"'::regclass AND attname = 'tenantId'`,
        );
        // If this ever goes NOT NULL the triggers above still pass their own
        // assertions while guarding an exemption that can no longer occur.
        expect(rows[0].notnull).toBe(false);
    });
});

describe('a control can be referenced from its own tenant, or from anywhere if it is global', () => {
    it('ALLOWS a reference within the owning tenant', async () => {
        await control('ctl-c1', T1);
        await insertFinding('ctl-f1', T1, 'controlId', 'ctl-c1');

        const row = await prisma.finding.findUnique({ where: { id: 'ctl-f1' } });
        expect(row?.controlId).toBe('ctl-c1');
    });

    it('ALLOWS any tenant to reference a GLOBAL library control', async () => {
        const global = await control('ctl-c2', null);
        // The premise, asserted rather than assumed: this row really has no
        // tenant. Against a NOT NULL column the create would have thrown and
        // the test below would be exercising an ordinary same-tenant write.
        expect(global.tenantId).toBeNull();

        await insertFinding('ctl-f2', T2, 'controlId', 'ctl-c2');

        const row = await prisma.finding.findUnique({ where: { id: 'ctl-f2' } });
        expect(row?.controlId).toBe('ctl-c2');
        expect(row?.tenantId).toBe(T2);
    });

    it('REFUSES a reference to another tenant\'s control, from all four columns', async () => {
        await control('ctl-c3', T1);

        const messages = [
            await failureOf(
                `INSERT INTO "Finding" ("id","tenantId","controlId","severity","type","title","description","updatedAt")
                 VALUES ('ctl-f3',$1,'ctl-c3','LOW','OBSERVATION','p','p',NOW())`, T2),
            await failureOf(
                `INSERT INTO "Finding" ("id","tenantId","compensatingControlId","severity","type","title","description","updatedAt")
                 VALUES ('ctl-f4',$1,'ctl-c3','LOW','OBSERVATION','p','p',NOW())`, T2),
            await failureOf(
                `INSERT INTO "Task" ("id","tenantId","controlId","title","createdByUserId","updatedAt")
                 VALUES ('ctl-t1',$1,'ctl-c3','p',$2,NOW())`, T2, actorId),
            await failureOf(
                `INSERT INTO "IntegrationExecution" ("id","tenantId","controlId","provider","automationKey")
                 VALUES ('ctl-e1',$1,'ctl-c3','p','k')`, T2),
        ];

        // The NAMED error, not merely "it threw". A refusal arriving from some
        // other constraint would be a false red for this claim.
        for (const m of messages) expect(m).toContain('CONTROL_TENANT_MISMATCH');
        // And it names the offending control, so the four are distinguishable
        // in a log rather than reading as one generic failure.
        for (const m of messages) expect(m).toContain('ctl-c3');

        expect(await prisma.finding.count({ where: { id: { in: ['ctl-f3', 'ctl-f4'] } } })).toBe(0);
        expect(await prisma.task.count({ where: { id: 'ctl-t1' } })).toBe(0);
        expect(await prisma.integrationExecution.count({ where: { id: 'ctl-e1' } })).toBe(0);
    });

    it('REFUSES re-tenanting the CHILD into a mismatch', async () => {
        await control('ctl-c5', T1);
        await insertFinding('ctl-f5', T1, 'controlId', 'ctl-c5');

        const msg = await failureOf(`UPDATE "Finding" SET "tenantId" = $1 WHERE "id" = 'ctl-f5'`, T2);
        expect(msg).toContain('CONTROL_TENANT_MISMATCH');

        // The write was refused, not partially applied.
        const row = await prisma.finding.findUnique({ where: { id: 'ctl-f5' } });
        expect(row?.tenantId).toBe(T1);
    });
});

describe('the same rule from the parent side', () => {
    it('REFUSES moving a control to another tenant while references remain', async () => {
        await control('ctl-c6', T1);
        await insertFinding('ctl-f6', T1, 'controlId', 'ctl-c6');

        const msg = await failureOf(`UPDATE "Control" SET "tenantId" = $1 WHERE "id" = 'ctl-c6'`, T2);
        expect(msg).toContain('CONTROL_RETENANT_ORPHANS');
        // It reports WHICH references would be stranded, not just that some are.
        expect(msg).toContain('Finding.controlId');

        const row = await prisma.control.findUnique({ where: { id: 'ctl-c6' } });
        expect(row?.tenantId).toBe(T1);
    });

    it('ALLOWS promoting a control INTO the global library', async () => {
        await control('ctl-c7', T1);
        await insertFinding('ctl-f7', T1, 'controlId', 'ctl-c7');

        await prisma.$executeRawUnsafe(`UPDATE "Control" SET "tenantId" = NULL WHERE "id" = 'ctl-c7'`);

        // Nobody is stranded: a library control belongs to every tenant. The
        // guard has to let this through or the catalogue becomes unreachable
        // from the only direction that can populate it.
        const row = await prisma.control.findUnique({ where: { id: 'ctl-c7' } });
        expect(row?.tenantId).toBeNull();
        const child = await prisma.finding.findUnique({ where: { id: 'ctl-f7' } });
        expect(child?.controlId).toBe('ctl-c7');
    });
});

describe('the FK these triggers sit beside is untouched', () => {
    it('deleting a control still NULLS the pointer and leaves the row', async () => {
        await control('ctl-c8', T1);
        await insertFinding('ctl-f8', T1, 'controlId', 'ctl-c8');

        await prisma.$executeRawUnsafe(`DELETE FROM "Control" WHERE "id" = 'ctl-c8'`);

        // The reason the single-column FK was KEPT rather than replaced: a
        // trigger cannot provide ON DELETE SET NULL, and these four rely on it.
        const row = await prisma.finding.findUnique({ where: { id: 'ctl-f8' } });
        expect(row).not.toBeNull();
        expect(row?.controlId).toBeNull();
        expect(row?.tenantId).toBe(T1);
    });

    it('all four keep a single-column FK to Control, not a composite one', async () => {
        const rows = await prisma.$queryRawUnsafe<Array<{ conname: string; cols: number }>>(
            `SELECT conname, cardinality(conkey)::int AS cols
               FROM pg_constraint
              WHERE contype = 'f' AND confrelid = '"Control"'::regclass
                AND conname = ANY($1::text[])`,
            GUARDED.map((g) => `${g.table}_${g.col}_fkey`),
        );
        expect(rows.length).toBe(4);
        expect(rows.filter((r) => Number(r.cols) !== 1).map((r) => r.conname)).toEqual([]);
    });
});
