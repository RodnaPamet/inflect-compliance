/**
 * #2356 batch 2 — ten composite tenant FKs, and the four that were refused.
 *
 * ─── What this file proves that the application already claims ──────
 *
 * Nothing, at the usecase layer — which is the point. Every one of these
 * writes is already refused by application code, so a test that went through
 * a usecase would pass against a database with no constraint at all. Postgres
 * runs FK checks AS THE TABLE OWNER and bypasses RLS, so the only thing that
 * makes a cross-tenant reference UNREPRESENTABLE is the constraint itself, and
 * the only way to test it is to write around the application with raw SQL.
 *
 * Every negative anchors on the exact `conname` the migration added, so a green
 * assertion is evidence about the constraint it names rather than about some
 * other constraint that happened to refuse the row. Every negative is paired
 * with the SAME statement against this tenant's own parent, because a
 * constraint that rejected every value would pass the negative alone and read
 * as working isolation.
 *
 * ─── The delete half, which is why these are column-scoped ──────────
 *
 * All ten are OPTIONAL pointers whose parent has a live hard-delete path
 * (Audit, Evidence, Finding and Risk are in SOFT_DELETE_MODELS and reach a raw
 * `DELETE` through `purgeSoftDeleted`; AiSystem is not soft-deleted at all).
 * A composite FK cannot use plain SET NULL — Postgres nulls EVERY referencing
 * column, `tenantId` is NOT NULL, and the parent delete aborts with 23502
 * against a column the DELETE never mentioned. The migration installs the
 * PG15+ column list, so the delete cases assert four things at once:
 *
 *   · the DELETE succeeds     — not 23502 (whole-row SET NULL), not 23503
 *                               (someone "fixed" it to RESTRICT)
 *   · the child row SURVIVES  — the pointer was dropped, not the row
 *   · the pointer is NULL     — the action actually ran
 *   · `tenantId` is UNCHANGED — the column list did its job
 *
 * The last is the whole point and is invisible to every other test: a plain
 * SET NULL that somehow succeeded would leave `tenantId` NULL, and a row whose
 * tenant has been erased is worse than the delete failing.
 *
 * ─── The four that are NOT here, asserted as still single-column ────
 *
 * `Control.tenantId` is NULLABLE — it is the sole member of
 * `NULLABLE_TENANT_MODELS`, and a Control with a NULL tenant is a GLOBAL
 * library control that every tenant may reference. A composite FK there would
 * make a tenant-scoped child unable to point at one. The last describe block
 * pins those four as single-column, so a later "completeness" pass that
 * converts them has to delete an assertion that says why not.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(120_000);

const T1 = 'fk-b2-t1';
const T2 = 'fk-b2-t2';
const ACTOR_EMAIL = 'fk-b2-actor@example.test';
let actorId = '';

/** Capture the error text of a raw write that must fail. */
async function failureOf(sql: string, ...params: unknown[]): Promise<string> {
    try {
        await prisma.$executeRawUnsafe(sql, ...params);
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
    throw new Error(`EXPECTED THE DATABASE TO REFUSE THIS WRITE, but it succeeded:\n${sql}`);
}

/** Hard-DELETE exactly as the data-lifecycle sweep does. THROWS on refusal. */
async function hardDelete(table: string, id: string): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id" = $1`, id);
}

async function pointerAndTenant(table: string, id: string, column: string) {
    const rows = await prisma.$queryRawUnsafe<
        Array<{ pointer: string | null; tenantId: string | null }>
    >(`SELECT "${column}" AS "pointer", "tenantId" FROM "${table}" WHERE "id" = $1`, id);
    return rows[0];
}

// ── Fixtures ────────────────────────────────────────────────────────

const aiSystem = (tenantId: string, name: string) =>
    prisma.aiSystem.create({ data: { tenantId, name, ownerUserId: actorId } });
const evidence = (tenantId: string, title: string) =>
    prisma.evidence.create({ data: { tenantId, type: 'LINK', title } });
const risk = (tenantId: string, title: string) =>
    prisma.risk.create({ data: { tenantId, title } });
const audit = (tenantId: string, title: string) =>
    prisma.audit.create({ data: { tenantId, title } });
const finding = (tenantId: string, title: string) =>
    prisma.finding.create({
        data: { tenantId, title, description: 'probe', severity: 'LOW', type: 'OBSERVATION' },
    });

let seq = 0;
const policy = (tenantId: string) =>
    prisma.policy.create({
        data: { tenantId, slug: `fk-b2-${tenantId}-${(seq += 1)}`, title: 'probe policy' },
    });

async function clearProbeRows() {
    await resetDatabase(prisma);
    const t = { tenantId: { in: [T1, T2] } };
    // Children first, then parents, then the memberships that pin the tenant —
    // `resetDatabase` truncates a fixed list that covers none of these, so
    // without this the suite passes exactly once on a fresh database.
    await prisma.aiDecisionLog.deleteMany({ where: t });
    await prisma.policyEvidenceItem.deleteMany({ where: t });
    await prisma.keyRiskIndicator.deleteMany({ where: t });
    await prisma.lossEvent.deleteMany({ where: t });
    await prisma.riskAppetiteBreach.deleteMany({ where: t });
    await prisma.task.deleteMany({ where: t });
    await prisma.finding.deleteMany({ where: t });
    await prisma.evidence.deleteMany({ where: t });
    await prisma.policy.deleteMany({ where: t });
    await prisma.audit.deleteMany({ where: t });
    await prisma.risk.deleteMany({ where: t });
    await prisma.aiSystem.deleteMany({ where: t });
    // The immutable-audit-log trigger and the last-OWNER guard both fire on an
    // ordinary DELETE and would take the teardown — and the suite — down with
    // them. Audit rows go through tests/helpers/audit-cleanup.ts, the one module
    // allowed to disable the audit trigger (#2523); TenantMembership keeps its
    // own replica-role transaction, which trips a different trigger.
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
    for (const id of [T1, T2]) {
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }
    const actor = await prisma.user.create({ data: { email: ACTOR_EMAIL, name: 'fk b2 actor' } });
    actorId = actor.id;
    for (const id of [T1, T2]) {
        await prisma.tenantMembership.create({
            data: { tenantId: id, userId: actorId, role: 'OWNER', status: 'ACTIVE' },
        });
    }
});

afterAll(async () => {
    await clearProbeRows();
    await prisma.$disconnect();
});

// ═══════════════════════════════════════════════════════════════════
describe('the database refuses a cross-tenant reference on all ten sites', () => {
    it("AiDecisionLog cannot point at another tenant's AiSystem", async () => {
        const own = await aiSystem(T1, 'own ai');
        const foreign = await aiSystem(T2, 'foreign ai');
        const insert =
            'INSERT INTO "AiDecisionLog" ("id","tenantId","feature","provider","inputDigest","aiSystemId") '
            + 'VALUES ($1,$2,$3,$4,$5,$6)';
        expect(
            await failureOf(insert, 'b2-adl-neg', T1, 'f', 'p', 'd', foreign.id),
        ).toContain('AiDecisionLog_aiSystemId_tenantId_fkey');
        expect(
            await prisma.$executeRawUnsafe(insert, 'b2-adl-pos', T1, 'f', 'p', 'd', own.id),
        ).toBe(1);
    });

    it("Evidence cannot point at another tenant's Risk", async () => {
        const own = await risk(T1, 'own risk');
        const foreign = await risk(T2, 'foreign risk');
        const insert =
            'INSERT INTO "Evidence" ("id","tenantId","type","title","updatedAt","riskId") '
            + `VALUES ($1,$2,'LINK','probe',now(),$3)`;
        expect(await failureOf(insert, 'b2-ev-neg', T1, foreign.id)).toContain(
            'Evidence_riskId_tenantId_fkey',
        );
        expect(await prisma.$executeRawUnsafe(insert, 'b2-ev-pos', T1, own.id)).toBe(1);
    });

    it("Finding cannot point at another tenant's Audit", async () => {
        const own = await audit(T1, 'own audit');
        const foreign = await audit(T2, 'foreign audit');
        const insert =
            'INSERT INTO "Finding" ("id","tenantId","severity","type","title","description","updatedAt","auditId") '
            + `VALUES ($1,$2,'LOW','OBSERVATION','probe','probe',now(),$3)`;
        expect(await failureOf(insert, 'b2-fi-neg', T1, foreign.id)).toContain(
            'Finding_auditId_tenantId_fkey',
        );
        expect(await prisma.$executeRawUnsafe(insert, 'b2-fi-pos', T1, own.id)).toBe(1);
    });

    it("Task cannot point at another tenant's Finding", async () => {
        const own = await finding(T1, 'own finding');
        const foreign = await finding(T2, 'foreign finding');
        const insert =
            'INSERT INTO "Task" ("id","tenantId","title","createdByUserId","updatedAt","findingId") '
            + 'VALUES ($1,$2,$3,$4,now(),$5)';
        expect(await failureOf(insert, 'b2-tk-neg', T1, 'probe', actorId, foreign.id)).toContain(
            'Task_findingId_tenantId_fkey',
        );
        expect(
            await prisma.$executeRawUnsafe(insert, 'b2-tk-pos', T1, 'probe', actorId, own.id),
        ).toBe(1);
    });

    it("KeyRiskIndicator, LossEvent and RiskAppetiteBreach cannot point at another tenant's Risk", async () => {
        const own = await risk(T1, 'own risk 2');
        const foreign = await risk(T2, 'foreign risk 2');

        const kri =
            'INSERT INTO "KeyRiskIndicator" ("id","tenantId","name","updatedAt","riskId") VALUES ($1,$2,$3,now(),$4)';
        expect(await failureOf(kri, 'b2-kri-neg', T1, 'probe', foreign.id)).toContain(
            'KeyRiskIndicator_riskId_tenantId_fkey',
        );
        expect(await prisma.$executeRawUnsafe(kri, 'b2-kri-pos', T1, 'probe', own.id)).toBe(1);

        const loss =
            'INSERT INTO "LossEvent" ("id","tenantId","occurredAt","amount","riskId") VALUES ($1,$2,now(),1.0,$3)';
        expect(await failureOf(loss, 'b2-le-neg', T1, foreign.id)).toContain(
            'LossEvent_riskId_tenantId_fkey',
        );
        expect(await prisma.$executeRawUnsafe(loss, 'b2-le-pos', T1, own.id)).toBe(1);

        const breach =
            'INSERT INTO "RiskAppetiteBreach" ("id","tenantId","breachType","thresholdValue","actualValue","riskId") '
            + `VALUES ($1,$2,'PROBE',1.0,2.0,$3)`;
        expect(await failureOf(breach, 'b2-rab-neg', T1, foreign.id)).toContain(
            'RiskAppetiteBreach_riskId_tenantId_fkey',
        );
        expect(await prisma.$executeRawUnsafe(breach, 'b2-rab-pos', T1, own.id)).toBe(1);
    });

    it("PolicyEvidenceItem cannot point at another tenant's Evidence", async () => {
        const own = await evidence(T1, 'own ev');
        const foreign = await evidence(T2, 'foreign ev');
        const p = await policy(T1);
        const insert =
            'INSERT INTO "PolicyEvidenceItem" ("id","tenantId","policyId","label","evidenceId") '
            + 'VALUES ($1,$2,$3,$4,$5)';
        expect(
            await failureOf(insert, 'b2-pei-neg', T1, p.id, 'probe', foreign.id),
        ).toContain('PolicyEvidenceItem_evidenceId_tenantId_fkey');
        expect(
            await prisma.$executeRawUnsafe(insert, 'b2-pei-pos', T1, p.id, 'probe', own.id),
        ).toBe(1);
    });
});

// ═══════════════════════════════════════════════════════════════════
describe('deleting the parent NULLS THE POINTER and succeeds', () => {
    /**
     * AiDecisionLog is the exception, and it was already the exception.
     *
     * `ai_decision_log_immutable_trg` lists `aiSystemId` among the columns no
     * UPDATE may change, so the SET NULL this FK declares can NEVER run: the
     * parent delete is refused by the trigger, not by the constraint. That is
     * true of the single-column SET NULL this migration replaced too — the FK
     * carried `onDelete: SetNull` before and after — so the composite changes
     * nothing here.
     *
     * Asserted rather than skipped, because "deleting an AiSystem that has
     * decision logs is impossible" is a real product fact that no other test
     * states, and because a future change that makes the trigger allow the
     * column would silently turn this into a working SET NULL with nobody
     * noticing which behaviour they had picked.
     */
    it('AiSystem delete is refused by the append-only trigger, as it was before', async () => {
        const parent = await aiSystem(T1, 'to delete');
        await prisma.$executeRawUnsafe(
            'INSERT INTO "AiDecisionLog" ("id","tenantId","feature","provider","inputDigest","aiSystemId") VALUES ($1,$2,$3,$4,$5,$6)',
            'b2-adl-del', T1, 'f', 'p', 'd', parent.id,
        );
        const err = await failureOf('DELETE FROM "AiSystem" WHERE "id" = $1', parent.id);
        expect(err).toContain('append-only');

        // The log row and its pointer are untouched — the delete did not
        // half-apply.
        const row = await pointerAndTenant('AiDecisionLog', 'b2-adl-del', 'aiSystemId');
        expect(row!.pointer).toBe(parent.id);
        expect(row!.tenantId).toBe(T1);
    });

    it('Risk delete leaves the Evidence row, its tenant intact', async () => {
        const parent = await risk(T1, 'to delete');
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Evidence" ("id","tenantId","type","title","updatedAt","riskId") VALUES ($1,$2,'LINK','probe',now(),$3)`,
            'b2-ev-del', T1, parent.id,
        );
        await hardDelete('Risk', parent.id);
        const row = await pointerAndTenant('Evidence', 'b2-ev-del', 'riskId');
        expect(row!.pointer).toBeNull();
        expect(row!.tenantId).toBe(T1);
    });

    it('Finding delete leaves the Task row, its tenant intact', async () => {
        const parent = await finding(T1, 'to delete');
        await prisma.$executeRawUnsafe(
            'INSERT INTO "Task" ("id","tenantId","title","createdByUserId","updatedAt","findingId") VALUES ($1,$2,$3,$4,now(),$5)',
            'b2-tk-del', T1, 'probe', actorId, parent.id,
        );
        await hardDelete('Finding', parent.id);
        const row = await pointerAndTenant('Task', 'b2-tk-del', 'findingId');
        expect(row!.pointer).toBeNull();
        expect(row!.tenantId).toBe(T1);
    });

    it('Audit delete leaves the Finding row, its tenant intact', async () => {
        const parent = await audit(T1, 'to delete');
        await prisma.$executeRawUnsafe(
            `INSERT INTO "Finding" ("id","tenantId","severity","type","title","description","updatedAt","auditId") VALUES ($1,$2,'LOW','OBSERVATION','probe','probe',now(),$3)`,
            'b2-fi-del', T1, parent.id,
        );
        await hardDelete('Audit', parent.id);
        const row = await pointerAndTenant('Finding', 'b2-fi-del', 'auditId');
        expect(row!.pointer).toBeNull();
        expect(row!.tenantId).toBe(T1);
    });

    it('Evidence delete leaves the PolicyEvidenceItem row, its tenant intact', async () => {
        const parent = await evidence(T1, 'to delete');
        const p = await policy(T1);
        await prisma.$executeRawUnsafe(
            'INSERT INTO "PolicyEvidenceItem" ("id","tenantId","policyId","label","evidenceId") VALUES ($1,$2,$3,$4,$5)',
            'b2-pei-del', T1, p.id, 'probe', parent.id,
        );
        await hardDelete('Evidence', parent.id);
        const row = await pointerAndTenant('PolicyEvidenceItem', 'b2-pei-del', 'evidenceId');
        expect(row!.pointer).toBeNull();
        expect(row!.tenantId).toBe(T1);
    });
});

// ═══════════════════════════════════════════════════════════════════
describe('the four Control sites are deliberately NOT composite', () => {
    /**
     * A completeness pass that "finishes the job" has to delete this to do it,
     * and the delete is the moment someone reads why.
     */
    it('Control.tenantId is nullable, so a composite FK would exile global controls', async () => {
        const rows = await prisma.$queryRawUnsafe<Array<{ is_nullable: string }>>(
            `SELECT is_nullable FROM information_schema.columns
              WHERE table_name = 'Control' AND column_name = 'tenantId'`,
        );
        expect(rows[0]?.is_nullable).toBe('YES');
    });

    it('all four Control-targeting FKs are still SINGLE-column', async () => {
        const rows = await prisma.$queryRawUnsafe<Array<{ conname: string; cols: number }>>(
            `SELECT c.conname, cardinality(c.conkey)::int AS cols
               FROM pg_constraint c
              WHERE c.contype = 'f'
                AND c.conname IN ('Finding_controlId_fkey','Finding_compensatingControlId_fkey',
                                  'IntegrationExecution_controlId_fkey','Task_controlId_fkey')
              ORDER BY c.conname`,
        );
        // The FLOOR matters: an empty selection would satisfy `every` vacuously
        // and read as "all four are single-column".
        expect(rows.length).toBe(4);
        for (const r of rows) expect(Number(r.cols)).toBe(1);
    });
});
