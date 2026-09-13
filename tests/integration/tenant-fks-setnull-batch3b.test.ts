/**
 * #2356 batch 3b — the last nineteen, all column-scoped SET NULL.
 *
 * With this file #2356's measured population is exhausted apart from the four
 * `Control` sites split to #2532.
 *
 * ─── What the structural half is for ───────────────────────────────
 *
 * `confdelsetcols` is the ONLY thing separating a column-scoped SET NULL from
 * a plain one — both are `confdeltype = 'n'`. So a migration that silently
 * degraded to the whole-row form would look identical to `confdeltype`, pass
 * any shape check, and only surface later as SQLSTATE 23502 on a parent delete,
 * reported against a column the DELETE never mentioned. Every one of the
 * nineteen is asserted BY NAME with its column list length.
 *
 * ─── What the behavioural half adds ────────────────────────────────
 *
 * That the database actually refuses a cross-tenant write, and that a parent
 * delete still nulls the pointer and LEAVES `tenantId` intact. The second is
 * the whole reason for the column list and is invisible to every other test:
 * a plain SET NULL that somehow succeeded would null `tenantId` too, and a row
 * whose tenant has been erased is worse than the delete failing.
 *
 * Raw SQL throughout, because the usecase layer already refuses these writes —
 * a test going through it would pass against a database with no constraint at
 * all. Postgres runs FK checks as the table owner and bypasses RLS.
 *
 * Representatives are chosen by SHAPE: one ordinary parent/child, and one
 * SELF-REFERENTIAL, where a careless reading would have parent and child be
 * the same row and where RESTRICT (the action Prisma's generated SQL proposed)
 * would make a chain undeletable from the middle.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'fk-b3b-t1';
const T2 = 'fk-b3b-t2';
const ACTOR_EMAIL = 'fk-b3b-actor@example.test';
let actorId = '';

/** Every site batch 3b converted. */
const SITES: ReadonlyArray<{ conname: string; child: string; col: string; parent: string }> = [
    { conname: 'AccessReviewConnectedDecision_connectedAccountId_tenantId_fkey', child: 'AccessReviewConnectedDecision', col: 'connectedAccountId', parent: 'ConnectedIdentityAccount' },
    { conname: 'AccessReviewDecision_membershipId_tenantId_fkey', child: 'AccessReviewDecision', col: 'membershipId', parent: 'TenantMembership' },
    { conname: 'AgentActionReceipt_auditLogId_tenantId_fkey', child: 'AgentActionReceipt', col: 'auditLogId', parent: 'AuditLog' },
    { conname: 'Audit_auditCycleId_tenantId_fkey', child: 'Audit', col: 'auditCycleId', parent: 'AuditCycle' },
    { conname: 'AuditPackShareComment_auditPackItemId_tenantId_fkey', child: 'AuditPackShareComment', col: 'auditPackItemId', parent: 'AuditPackItem' },
    { conname: 'AutomationRule_nextRuleId_tenantId_fkey', child: 'AutomationRule', col: 'nextRuleId', parent: 'AutomationRule' },
    { conname: 'AutomationRule_elseRuleId_tenantId_fkey', child: 'AutomationRule', col: 'elseRuleId', parent: 'AutomationRule' },
    { conname: 'BusinessImpactAnalysis_processNodeId_tenantId_fkey', child: 'BusinessImpactAnalysis', col: 'processNodeId', parent: 'ProcessNode' },
    { conname: 'Device_employeeId_tenantId_fkey', child: 'Device', col: 'employeeId', parent: 'Employee' },
    { conname: 'Employee_managerEmployeeId_tenantId_fkey', child: 'Employee', col: 'managerEmployeeId', parent: 'Employee' },
    { conname: 'IdentityWriteJournal_linkId_tenantId_fkey', child: 'IdentityWriteJournal', col: 'linkId', parent: 'IdentityAccountLink' },
    { conname: 'IntegrationExecution_connectionId_tenantId_fkey', child: 'IntegrationExecution', col: 'connectionId', parent: 'IntegrationConnection' },
    { conname: 'IntegrationSyncMapping_connectionId_tenantId_fkey', child: 'IntegrationSyncMapping', col: 'connectionId', parent: 'IntegrationConnection' },
    { conname: 'Policy_currentVersionId_tenantId_fkey', child: 'Policy', col: 'currentVersionId', parent: 'PolicyVersion' },
    { conname: 'ReadinessSnapshot_auditCycleId_tenantId_fkey', child: 'ReadinessSnapshot', col: 'auditCycleId', parent: 'AuditCycle' },
    { conname: 'RiskHierarchyNode_parentId_tenantId_fkey', child: 'RiskHierarchyNode', col: 'parentId', parent: 'RiskHierarchyNode' },
    { conname: 'TenantMembership_customRoleId_tenantId_fkey', child: 'TenantMembership', col: 'customRoleId', parent: 'TenantCustomRole' },
    { conname: 'VendorAssessment_templateVersionId_tenantId_fkey', child: 'VendorAssessment', col: 'templateVersionId', parent: 'VendorAssessmentTemplate' },
    { conname: 'VendorAssessmentAnswer_templateQuestionId_tenantId_fkey', child: 'VendorAssessmentAnswer', col: 'templateQuestionId', parent: 'VendorAssessmentTemplateQuestion' },
];

async function failureOf(sql: string, ...params: unknown[]): Promise<string> {
    try { await prisma.$executeRawUnsafe(sql, ...params); }
    catch (err) { return err instanceof Error ? err.message : String(err); }
    throw new Error(`EXPECTED THE DATABASE TO REFUSE THIS WRITE, but it succeeded:\n${sql}`);
}

async function pointerAndTenant(table: string, id: string, column: string) {
    const rows = await prisma.$queryRawUnsafe<
        Array<{ pointer: string | null; tenantId: string | null }>
    >(`SELECT "${column}" AS "pointer", "tenantId" FROM "${table}" WHERE "id" = $1`, id);
    return rows[0];
}

const employee = (tenantId: string, email: string) =>
    prisma.employee.create({ data: { tenantId, fullName: 'probe', workEmail: email } });

async function clearProbeRows() {
    await resetDatabase(prisma);
    const t = { tenantId: { in: [T1, T2] } };
    await prisma.device.deleteMany({ where: t });
    // Managers are employees too: null the self-reference before deleting, or
    // the RESTRICT-free SET NULL still leaves ordering to chance.
    await prisma.employee.updateMany({ where: t, data: { managerEmployeeId: null } });
    await prisma.employee.deleteMany({ where: t });
    await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
        await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
        await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, [T1, T2]);
    });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
    await prisma.user.deleteMany({ where: { email: ACTOR_EMAIL } });
}

beforeAll(async () => {
    await clearProbeRows();
    for (const id of [T1, T2]) await prisma.tenant.create({ data: { id, name: id, slug: id } });
    const actor = await prisma.user.create({ data: { email: ACTOR_EMAIL, name: 'fk b3b actor' } });
    actorId = actor.id;
    for (const id of [T1, T2]) {
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId: actorId, role: 'OWNER', status: 'ACTIVE' },
        });
    }
});

afterAll(async () => { await clearProbeRows(); await prisma.$disconnect(); });

describe('all 19 are composite AND column-scoped SET NULL', () => {
    it('every one is present, two-column, and nulls exactly ONE column', async () => {
        const rows = await prisma.$queryRawUnsafe<
            Array<{ conname: string; cols: number; del: string; setnull: number }>
        >(`SELECT conname, cardinality(conkey)::int AS cols, confdeltype::text AS del,
                  COALESCE(cardinality(confdelsetcols), 0)::int AS setnull
             FROM pg_constraint WHERE contype = 'f'`);
        const byName = new Map(rows.map((r) => [r.conname, r]));

        expect(SITES.filter((s) => !byName.has(s.conname)).map((s) => s.conname)).toEqual([]);
        expect(SITES.filter((s) => Number(byName.get(s.conname)!.cols) !== 2).map((s) => s.conname))
            .toEqual([]);
        expect(SITES.filter((s) => byName.get(s.conname)!.del !== 'n').map((s) => s.conname))
            .toEqual([]);
        // THE ONE THAT MATTERS: plain SET NULL would be `setnull = 0` here and
        // identical on every other column.
        expect(SITES.filter((s) => Number(byName.get(s.conname)!.setnull) !== 1)
            .map((s) => s.conname)).toEqual([]);
    });

    it('the single-column originals are gone, and the table is non-empty', async () => {
        expect(SITES.length).toBe(19);
        const rows = await prisma.$queryRawUnsafe<Array<{ conname: string }>>(
            `SELECT conname FROM pg_constraint WHERE contype = 'f' AND cardinality(conkey) = 1
              AND conname = ANY($1::text[])`,
            SITES.map((s) => `${s.child}_${s.col}_fkey`),
        );
        expect(rows.map((r) => r.conname)).toEqual([]);
    });
});

describe('the database refuses a cross-tenant reference', () => {
    it("Device cannot point at another tenant's Employee", async () => {
        const own = await employee(T1, 'b3b-dev-own@x.test');
        const foreign = await employee(T2, 'b3b-dev-foreign@x.test');
        const insert =
            `INSERT INTO "Device" ("id","tenantId","platform","updatedAt","employeeId") VALUES ($1,$2,'MACOS',now(),$3)`;
        expect(await failureOf(insert, 'b3b-dev-neg', T1, foreign.id)).toContain(
            'Device_employeeId_tenantId_fkey',
        );
        expect(await prisma.$executeRawUnsafe(insert, 'b3b-dev-pos', T1, own.id)).toBe(1);
    });

    it("an Employee cannot have a manager in another tenant (SELF-REFERENTIAL)", async () => {
        const ownMgr = await employee(T1, 'b3b-mgr-own@x.test');
        const foreignMgr = await employee(T2, 'b3b-mgr-foreign@x.test');
        const insert =
            'INSERT INTO "Employee" ("id","tenantId","fullName","workEmail","updatedAt","managerEmployeeId") '
            + `VALUES ($1,$2,'probe',$3,now(),$4)`;
        expect(
            await failureOf(insert, 'b3b-emp-neg', T1, 'b3b-neg@x.test', foreignMgr.id),
        ).toContain('Employee_managerEmployeeId_tenantId_fkey');
        expect(
            await prisma.$executeRawUnsafe(insert, 'b3b-emp-pos', T1, 'b3b-pos@x.test', ownMgr.id),
        ).toBe(1);
    });
});

describe('deleting the parent NULLS THE POINTER and leaves tenantId intact', () => {
    it('Employee delete leaves the Device row, its tenant unchanged', async () => {
        const emp = await employee(T1, 'b3b-del@x.test');
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Device" ("id","tenantId","platform","updatedAt","employeeId") VALUES ($1,$2,'MACOS',now(),$3)`,
            'b3b-dev-del', T1, emp.id,
        );
        await prisma.$executeRawUnsafe('DELETE FROM "Employee" WHERE "id" = $1', emp.id);
        const row = await pointerAndTenant('Device', 'b3b-dev-del', 'employeeId');
        expect(row).toBeDefined();
        expect(row!.pointer).toBeNull();
        // The column list did its job. A whole-row SET NULL would have nulled
        // this too — or aborted with 23502 because it is NOT NULL.
        expect(row!.tenantId).toBe(T1);
    });

    it('deleting a manager leaves their reports, tenant unchanged (SELF-REFERENTIAL)', async () => {
        const mgr = await employee(T1, 'b3b-mgr-del@x.test');
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Employee" ("id","tenantId","fullName","workEmail","updatedAt","managerEmployeeId") VALUES ($1,$2,'probe',$3,now(),$4)`,
            'b3b-report', T1, 'b3b-report@x.test', mgr.id,
        );
        await prisma.$executeRawUnsafe('DELETE FROM "Employee" WHERE "id" = $1', mgr.id);
        const row = await pointerAndTenant('Employee', 'b3b-report', 'managerEmployeeId');
        expect(row).toBeDefined();
        expect(row!.pointer).toBeNull();
        expect(row!.tenantId).toBe(T1);
    });
});
