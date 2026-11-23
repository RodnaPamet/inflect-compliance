/**
 * A tenant purge completes for a tenant whose AI decision log names an AI
 * system, and keeps every decision row with only its link dropped (#5848).
 *
 * THE BUG
 * ───────
 * The purge deletes `AiSystem` and retains `AiDecisionLog`, the EU AI Act
 * Art 12 record. The FK between them is the shape the retained-model rule asks
 * for — `ON DELETE SET NULL ("aiSystemId")`, column-scoped — but the append-only
 * trigger `ai_decision_log_immutable()` listed `aiSystemId` among the columns no
 * UPDATE may change, so the FK's own SET NULL was refused with "AiDecisionLog is
 * append-only; only humanOutcome may transition" and the purge's per-tenant
 * transaction rolled back. Every registered agent's decision rows name an AI
 * system, so any tenant that ever ran an agent could not be purged.
 *
 * THE FIX, AND WHAT MUST STAY REFUSED
 * ───────────────────────────────────
 * Migration 20261123120000 lets the trigger admit exactly that write — the
 * link going from a value to NULL, issued by the FK action (a nested trigger),
 * with every other column, `humanOutcome` included, unchanged. Everything else
 * stays refused word for word, which the second half of this suite holds
 * against the real trigger: a re-point, a NULL plus any other change, a
 * person's direct UPDATE that only nulls the link, a NULL-to-value, and the
 * one-way `humanOutcome` stamp.
 */
import { PrismaClient, type AiHumanOutcome } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { createTenantWithDek } from '@/lib/security/tenant-key-manager';
import { purgeSoftDeletedTenants, TENANT_PURGE_RETAINED } from '@/app-layer/usecases/tenant-purge';
import { __resetAuditStreamForTests } from '@/app-layer/events/audit-stream';
import { prisma as appPrisma } from '@/lib/prisma';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const SUITE = `adlpurge-${randomUUID().slice(0, 8)}`;
const PURGED = `tp-${SUITE}`;
const KEPT = `tk-${SUITE}`;
const PROBE = `tx-${SUITE}`;
const TENANTS = [PURGED, KEPT, PROBE];

/** Every column of a decision row, as stored. */
type DecisionRow = Record<string, unknown>;

async function decisionRows(tenantId: string): Promise<DecisionRow[]> {
    return (await prisma.$queryRawUnsafe(
        'SELECT * FROM "AiDecisionLog" WHERE "tenantId" = $1 ORDER BY "id"',
        tenantId,
    )) as DecisionRow[];
}

/** One decision row with EVERY nullable column set, so "unchanged" is checked over real values. */
async function decision(
    tenantId: string,
    id: string,
    aiSystemId: string | null,
    humanOutcome: AiHumanOutcome,
): Promise<void> {
    await prisma.aiDecisionLog.create({
        data: {
            id,
            tenantId,
            feature: 'agentic-run',
            aiSystemId,
            provider: 'anthropic',
            model: 'model-x',
            inputDigest: `digest-${id}`,
            outputSummary: `summary ${id}`,
            latencyMs: 42,
            tokensIn: 100,
            tokensOut: 200,
            guardVerdict: 'clean',
            humanOutcome,
            sessionRef: `session-${id}`,
            userId: `user-${id}`,
            agentId: `agent-${id}`,
            agentProposalId: `proposal-${id}`,
            createdAt: new Date('2026-06-01T00:00:00Z'),
        },
    });
}

/** A tenant with an AI system, two decision rows naming it (one stamped) and one naming none. */
async function seedTenant(tenantId: string): Promise<string> {
    await createTenantWithDek({ id: tenantId, name: tenantId, slug: tenantId });
    const sys = await prisma.aiSystem.create({ data: { tenantId, name: `sys-${tenantId}` } });
    await decision(tenantId, `${tenantId}-pending`, sys.id, 'PENDING');
    await decision(tenantId, `${tenantId}-accepted`, sys.id, 'ACCEPTED');
    await decision(tenantId, `${tenantId}-unlinked`, null, 'PENDING');
    return sys.id;
}

/** The SQLSTATE-free message a statement fails with, or null when it succeeds. */
async function failureOf(sql: string, ...values: unknown[]): Promise<string | null> {
    try {
        await prisma.$executeRawUnsafe(sql, ...values);
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/**
 * Run `stmt` from INSIDE a trigger, one level deep — where the FK's referential
 * action runs it — and report how it fails, or null when it is admitted. A
 * throwaway trigger on a temp table executes the statement; the whole
 * transaction is always rolled back, so nothing a probe admits is kept.
 *
 * This is how the column-equality half of the admitted write is tested on its
 * own: a direct UPDATE never gets past the depth condition, so without this a
 * trigger that forgot to compare `provider` would look exactly as strict.
 */
const ROLLBACK = 'adl-probe-rollback';
async function nestedFailureOf(stmt: string): Promise<string | null> {
    try {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe('CREATE TEMP TABLE adl_probe (stmt text) ON COMMIT DROP');
            await tx.$executeRawUnsafe(
                'CREATE FUNCTION pg_temp.adl_probe_run() RETURNS trigger AS $f$ ' +
                    'BEGIN EXECUTE NEW.stmt; RETURN NEW; END $f$ LANGUAGE plpgsql',
            );
            await tx.$executeRawUnsafe(
                'CREATE TRIGGER adl_probe_trg AFTER INSERT ON adl_probe FOR EACH ROW EXECUTE FUNCTION pg_temp.adl_probe_run()',
            );
            await tx.$executeRawUnsafe('INSERT INTO adl_probe VALUES ($1)', stmt);
            throw new Error(ROLLBACK);
        });
        return null;
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return message.includes(ROLLBACK) ? null : message;
    }
}

/**
 * Leave nothing behind. Decision rows have no DELETE trigger and cascade from
 * the tenant, so they go first, which lets the purge run on main as well as on
 * the fix; then the tombstone's audit rows, then the tombstone.
 */
async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe('DELETE FROM "AiDecisionLog" WHERE "tenantId" = ANY($1)', TENANTS);
    const existing = await prisma.tenant.findMany({ where: { id: { in: TENANTS } }, select: { id: true } });
    for (const { id } of existing) {
        await prisma.tenant.update({ where: { id }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
        await purgeSoftDeletedTenants({ tenantId: id });
    }
    await deleteAuditRowsForTenants(prisma, TENANTS).catch(() => {});
    await prisma.tenant.deleteMany({ where: { id: { in: TENANTS } } });
}

describeFn('AI decision log through a tenant purge (#5848, real DB)', () => {
    afterAll(async () => {
        await cleanup();
        await appPrisma.$disconnect();
        await prisma.$disconnect();
        __resetAuditStreamForTests();
    });

    describe('a tenant purge keeps the AI decision log and drops only its AI-system link', () => {
        let purgedSystemId: string;
        let keptSystemId: string;
        let purgedBefore: DecisionRow[];
        let keptBefore: DecisionRow[];
        let purgeError: unknown;
        let result: Awaited<ReturnType<typeof purgeSoftDeletedTenants>> | undefined;

        beforeAll(async () => {
            await prisma.$connect();
            await cleanup();
            purgedSystemId = await seedTenant(PURGED);
            keptSystemId = await seedTenant(KEPT);
            purgedBefore = await decisionRows(PURGED);
            keptBefore = await decisionRows(KEPT);
            await prisma.tenant.update({ where: { id: PURGED }, data: { deletedAt: new Date('2026-01-01T00:00:00Z') } });
            try {
                result = await purgeSoftDeletedTenants({ tenantId: PURGED, dryRun: false });
            } catch (e) {
                purgeError = e;
            }
        });


        it('the fixture is what it claims: two linked rows and one unlinked row per tenant', () => {
            // Positive control: "every row survived unchanged" is vacuous over none.
            expect(purgedBefore.map((r) => r.aiSystemId)).toEqual(
                expect.arrayContaining([purgedSystemId, purgedSystemId, null]),
            );
            expect(purgedBefore).toHaveLength(3);
            expect(keptBefore.filter((r) => r.aiSystemId === keptSystemId)).toHaveLength(2);
            // The shape the bug needs: the log is retained, the AI system is not.
            expect(TENANT_PURGE_RETAINED.has('AiDecisionLog')).toBe(true);
            expect(TENANT_PURGE_RETAINED.has('AiSystem')).toBe(false);
        });

        it('the purge completes, and deletes the AI system', async () => {
            expect(purgeError).toBeUndefined();
            const [mine] = (result ?? []).filter((r) => r.tenantId === PURGED);
            expect(mine.dryRun).toBe(false);
            expect(mine.deleted.AiSystem).toBe(1);
            expect(mine.deleted.AiDecisionLog).toBeUndefined();
            expect(await prisma.aiSystem.count({ where: { tenantId: PURGED } })).toBe(0);
        });

        it('every decision row survives with aiSystemId NULL and every other column unchanged', async () => {
            const after = await decisionRows(PURGED);
            expect(after).toEqual(purgedBefore.map((r) => ({ ...r, aiSystemId: null })));
        });

        it("leaves another tenant's AI system and decision rows untouched", async () => {
            expect(await decisionRows(KEPT)).toEqual(keptBefore);
            expect(await prisma.aiSystem.count({ where: { id: keptSystemId } })).toBe(1);
        });
    });

    describe('the append-only trigger still refuses everything but the FK’s own SET NULL', () => {
        let a: string;
        let b: string;

        beforeAll(async () => {
            await prisma.$connect();
            await prisma.$executeRawUnsafe('DELETE FROM "AiDecisionLog" WHERE "tenantId" = $1', PROBE);
            await prisma.aiSystem.deleteMany({ where: { tenantId: PROBE } });
            await prisma.tenant.deleteMany({ where: { id: PROBE } });
            await createTenantWithDek({ id: PROBE, name: PROBE, slug: PROBE });
            a = (await prisma.aiSystem.create({ data: { tenantId: PROBE, name: 'a' } })).id;
            b = (await prisma.aiSystem.create({ data: { tenantId: PROBE, name: 'b' } })).id;
        });


        const id = (suffix: string) => `${PROBE}-${suffix}`;
        const linkOf = async (rowId: string) =>
            ((await prisma.$queryRawUnsafe('SELECT "aiSystemId" FROM "AiDecisionLog" WHERE "id" = $1', rowId)) as Array<{
                aiSystemId: string | null;
            }>)[0]?.aiSystemId;

        it('re-pointing aiSystemId at ANOTHER AI system is refused', async () => {
            await decision(PROBE, id('repoint'), a, 'PENDING');
            expect(
                await failureOf('UPDATE "AiDecisionLog" SET "aiSystemId" = $2 WHERE "id" = $1', id('repoint'), b),
            ).toContain('AiDecisionLog is append-only; only humanOutcome may transition');
            expect(await linkOf(id('repoint'))).toBe(a);
        });

        it('nulling aiSystemId AND changing any other column is refused', async () => {
            await decision(PROBE, id('null-plus'), a, 'PENDING');
            for (const [set, value] of [
                ['"provider"', 'other'],
                ['"agentId"', 'another-agent'],
                ['"agentProposalId"', 'another-proposal'],
                ['"humanOutcome"', 'ACCEPTED'],
            ] as const) {
                const cast = set === '"humanOutcome"' ? '::"AiHumanOutcome"' : '';
                expect(
                    await failureOf(
                        `UPDATE "AiDecisionLog" SET "aiSystemId" = NULL, ${set} = $2${cast} WHERE "id" = $1`,
                        id('null-plus'),
                        value,
                    ),
                ).toContain('AiDecisionLog is append-only; only humanOutcome may transition');
            }
            expect(await linkOf(id('null-plus'))).toBe(a);
        });

        it('a direct UPDATE that only nulls aiSystemId is refused: only the FK action may', async () => {
            await decision(PROBE, id('direct-null'), a, 'PENDING');
            expect(
                await failureOf('UPDATE "AiDecisionLog" SET "aiSystemId" = NULL WHERE "id" = $1', id('direct-null')),
            ).toContain('AiDecisionLog is append-only; only humanOutcome may transition');
            expect(await linkOf(id('direct-null'))).toBe(a);
        });

        it("the FK's own ON UPDATE CASCADE, a re-point from inside a trigger, is refused", async () => {
            const d = (await prisma.aiSystem.create({ data: { tenantId: PROBE, name: 'd' } })).id;
            await decision(PROBE, id('cascade'), d, 'PENDING');
            expect(
                await failureOf('UPDATE "AiSystem" SET "id" = $2 WHERE "id" = $1', d, `${d}-renamed`),
            ).toContain('AiDecisionLog is append-only; only humanOutcome may transition');
            expect(await linkOf(id('cascade'))).toBe(d);
        });

        it('from inside a trigger, only nulling the link is admitted: a NULL that moves any other column is refused', async () => {
            await decision(PROBE, id('nested'), a, 'PENDING');
            const nulling = (extra: string) =>
                `UPDATE "AiDecisionLog" SET "aiSystemId" = NULL${extra} WHERE "id" = '${id('nested')}'`;
            // POSITIVE CONTROL: the probe really runs one level deep, so the
            // refusals below are the column comparison speaking, not the depth.
            expect(await nestedFailureOf(nulling(''))).toBeNull();
            for (const extra of [
                `, "provider" = 'other'`,
                `, "outputSummary" = 'rewritten'`,
                `, "agentId" = 'another-agent'`,
                `, "agentProposalId" = 'another-proposal'`,
                `, "humanOutcome" = 'ACCEPTED'`,
                `, "createdAt" = now()`,
            ]) {
                expect(await nestedFailureOf(nulling(extra))).toContain(
                    'AiDecisionLog is append-only; only humanOutcome may transition',
                );
            }
            // Re-pointing from inside a trigger stays refused too.
            expect(
                await nestedFailureOf(
                    `UPDATE "AiDecisionLog" SET "aiSystemId" = '${b}' WHERE "id" = '${id('nested')}'`,
                ),
            ).toContain('AiDecisionLog is append-only; only humanOutcome may transition');
            expect(await linkOf(id('nested'))).toBe(a);
        });

        it('linking an unlinked row afterwards is refused', async () => {
            await decision(PROBE, id('link-later'), null, 'PENDING');
            expect(
                await failureOf('UPDATE "AiDecisionLog" SET "aiSystemId" = $2 WHERE "id" = $1', id('link-later'), a),
            ).toContain('AiDecisionLog is append-only; only humanOutcome may transition');
            expect(await linkOf(id('link-later'))).toBeNull();
        });

        it('humanOutcome still leaves PENDING exactly once', async () => {
            await decision(PROBE, id('stamp'), a, 'PENDING');
            expect(
                await failureOf(
                    `UPDATE "AiDecisionLog" SET "humanOutcome" = 'ACCEPTED' WHERE "id" = $1`,
                    id('stamp'),
                ),
            ).toBeNull();
            expect(
                await failureOf(
                    `UPDATE "AiDecisionLog" SET "humanOutcome" = 'REJECTED' WHERE "id" = $1`,
                    id('stamp'),
                ),
            ).toContain('AiDecisionLog.humanOutcome already recorded (append-only)');
            expect(
                await failureOf(
                    `UPDATE "AiDecisionLog" SET "humanOutcome" = 'PENDING' WHERE "id" = $1`,
                    id('stamp'),
                ),
            ).toContain('AiDecisionLog.humanOutcome already recorded (append-only)');
        });

        it('deleting the AI system nulls the link of every row naming it, stamped or not', async () => {
            const c = (await prisma.aiSystem.create({ data: { tenantId: PROBE, name: 'c' } })).id;
            await decision(PROBE, id('del-pending'), c, 'PENDING');
            await decision(PROBE, id('del-rejected'), c, 'REJECTED');
            const before = (await prisma.$queryRawUnsafe(
                'SELECT * FROM "AiDecisionLog" WHERE "id" = ANY($1) ORDER BY "id"',
                [id('del-pending'), id('del-rejected')],
            )) as DecisionRow[];
            expect(await failureOf('DELETE FROM "AiSystem" WHERE "id" = $1', c)).toBeNull();
            const after = (await prisma.$queryRawUnsafe(
                'SELECT * FROM "AiDecisionLog" WHERE "id" = ANY($1) ORDER BY "id"',
                [id('del-pending'), id('del-rejected')],
            )) as DecisionRow[];
            expect(after).toEqual(before.map((r) => ({ ...r, aiSystemId: null })));
        });
    });
});
