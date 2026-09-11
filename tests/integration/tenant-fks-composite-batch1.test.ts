/**
 * #2356 batch 1 — the DATABASE refuses a cross-tenant reference for the five
 * targets of the Asset/Task connected component, with the application bypassed.
 *
 * Postgres runs foreign-key checks AS THE TABLE OWNER, which bypasses row-level
 * security — RLS does not constrain what a FK will accept. So a single-column
 * `xId -> Target(id)` between two tenant-scoped tables leaves a cross-tenant
 * reference REPRESENTABLE however carefully the application filters. Migration
 * 20260911150000_tenant_fks_composite_batch1_asset_task_component closes that
 * for ten sites against Asset, Task, ScannerRun and RiskSuggestionSession.
 *
 * ─── Why these write RAW SQL ────────────────────────────────────────
 *
 * Every negative below is an `INSERT` issued with `$executeRawUnsafe`, not a
 * Prisma `create`. Two reasons, and both matter:
 *
 *   1. The usecase layer already refuses these writes. A test that went
 *      through it would pass on a database with no constraint at all, which is
 *      precisely the state this migration exists to leave behind.
 *   2. Raw SQL surfaces Postgres's own message, which NAMES the constraint.
 *      `.rejects.toThrow(/foreign key/i)` would also pass on a missing column,
 *      a bad enum, or — the case that actually matters here — the WRONG
 *      constraint refusing the row. Each assertion below anchors on the exact
 *      `conname` this migration added, so a green test is evidence about the
 *      constraint it claims to be about.
 *
 * ─── Why each case is a pair ────────────────────────────────────────
 *
 * A constraint that rejected EVERY value would pass the negative alone and read
 * as working isolation. So every negative is followed by the same INSERT with
 * the tenant's OWN parent, which must succeed — proving the constraint refuses
 * the TENANT and not the column.
 *
 * ─── FileRecord ─────────────────────────────────────────────────────
 *
 * FileRecord's composite key lands in this batch with no FK referencing it yet:
 * all three of its children (Evidence.fileRecordId, FileRecord.
 * previousFileRecordId, AccessReview.evidenceFileRecordId) are effectively
 * `SetNull` today, so converting them is a delete-behaviour decision that is
 * filed rather than guessed. Its case therefore proves the property this batch
 * actually delivers for FileRecord — that `(id, tenantId)` is usable as a
 * composite FK target and binds — by standing up a probe table inside a
 * transaction that is always rolled back.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'fk-b1-t1';
const T2 = 'fk-b1-t2';
const ACTOR_EMAIL = 'fk-b1-actor@example.test';
const UPLOADER_EMAIL = 'fk-b1-uploader@example.test';

/** `Task.createdByUserId` and `RiskSuggestionSession.createdByUserId` are NOT
 *  NULL and reference `User`, so one actor is created for the whole file. */
let actorId = '';

/** Capture the error text of a raw write that must fail. */
async function failureOf(sql: string, ...params: unknown[]): Promise<string> {
    try {
        await prisma.$executeRawUnsafe(sql, ...params);
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
    throw new Error(
        `EXPECTED THIS WRITE TO BE REFUSED BY THE DATABASE, but it succeeded:\n${sql}`,
    );
}

/**
 * Child rows before tenants, in this exact order.
 *
 * `resetDatabase` clears its ROOTS plus everything reachable from one by a
 * foreign key. `ScannerRun` and `RiskSuggestionSession` are neither, so they
 * survive its TRUNCATE ... CASCADE and then refuse the tenant delete — found
 * by the delete actually failing on `RiskSuggestionSession_tenantId_fkey`, not
 * by reading the root list. `Tenant` is not a root either, and Asset/Task
 * reference it with a constraint that refuses rather than cascades.
 *
 * Run from `beforeAll` as well as `afterAll`: a suite that dies mid-flight
 * leaves these rows behind, and the next run's `tenant.create` then fails on
 * `Tenant_pkey` — a setup error that reports as ten failing assertions about
 * foreign keys. Idempotent setup is cheaper than reading that twice.
 */
async function clearProbeRows() {
    await resetDatabase(prisma);
    await prisma.riskSuggestionSession.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await prisma.scannerRun.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
    await prisma.user.deleteMany({ where: { email: { in: [ACTOR_EMAIL, UPLOADER_EMAIL] } } });
}

beforeAll(async () => {
    await clearProbeRows();
    for (const id of [T1, T2]) {
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }
    const actor = await prisma.user.create({ data: { email: ACTOR_EMAIL, name: 'fk-b1 actor' } });
    actorId = actor.id;
});

afterAll(clearProbeRows);

// ── Asset ───────────────────────────────────────────────────────────

describe('Asset (id, tenantId)', () => {
    it("AssetRiskLink cannot point at another tenant's Asset", async () => {
        const ownAsset = await prisma.asset.create({
            data: { tenantId: T1, name: 'own asset', type: 'SYSTEM' },
        });
        const foreignAsset = await prisma.asset.create({
            data: { tenantId: T2, name: 'foreign asset', type: 'SYSTEM' },
        });
        const ownRisk = await prisma.risk.create({
            data: { tenantId: T1, title: 'own risk' },
        });

        const insert =
            'INSERT INTO "AssetRiskLink" ("id", "tenantId", "assetId", "riskId") VALUES ($1, $2, $3, $4)';

        // NEGATIVE — the foreign asset. `riskId` is this tenant's own, so the
        // only thing that can refuse this row is the Asset constraint, and the
        // assertion says so by name.
        const msg = await failureOf(insert, 'arl-neg', T1, foreignAsset.id, ownRisk.id);
        expect(msg).toContain('AssetRiskLink_assetId_tenantId_fkey');

        // POSITIVE COMPANION — same statement, own asset.
        const rows = await prisma.$executeRawUnsafe(
            insert, 'arl-pos', T1, ownAsset.id, ownRisk.id,
        );
        expect(rows).toBe(1);
    });
});

// ── Task ────────────────────────────────────────────────────────────

describe('Task (id, tenantId)', () => {
    it("TaskLink cannot point at another tenant's Task", async () => {
        const ownTask = await prisma.task.create({
            data: { tenantId: T1, title: 'own task', createdByUserId: actorId },
        });
        const foreignTask = await prisma.task.create({
            data: { tenantId: T2, title: 'foreign task', createdByUserId: actorId },
        });

        const insert =
            'INSERT INTO "TaskLink" ("id", "tenantId", "taskId", "entityType", "entityId") '
            + `VALUES ($1, $2, $3, 'RISK', $4)`;

        const msg = await failureOf(insert, 'tl-neg', T1, foreignTask.id, 'some-risk');
        expect(msg).toContain('TaskLink_taskId_tenantId_fkey');

        const rows = await prisma.$executeRawUnsafe(
            insert, 'tl-pos', T1, ownTask.id, 'some-risk',
        );
        expect(rows).toBe(1);
    });
});

// ── ScannerRun ──────────────────────────────────────────────────────

describe('ScannerRun (id, tenantId)', () => {
    it("ScannerFinding cannot point at another tenant's ScannerRun", async () => {
        const run = (tenantId: string, src: string) => prisma.scannerRun.create({
            data: {
                tenantId, source: src, scanType: 'SAST', ranAt: new Date(),
                outcome: 'PASS', ingestedVia: 'API',
            },
        });
        const ownRun = await run(T1, 'SEMGREP');
        const foreignRun = await run(T2, 'TRIVY');

        const insert =
            'INSERT INTO "ScannerFinding" '
            + '("id", "tenantId", "scannerRunId", "fingerprint", "ruleId", "severity", "title", "updatedAt") '
            + `VALUES ($1, $2, $3, $4, 'rule-1', 'HIGH', 'probe finding', now())`;

        const msg = await failureOf(insert, 'sf-neg', T1, foreignRun.id, 'fp-neg');
        expect(msg).toContain('ScannerFinding_scannerRunId_tenantId_fkey');

        const rows = await prisma.$executeRawUnsafe(
            insert, 'sf-pos', T1, ownRun.id, 'fp-pos',
        );
        expect(rows).toBe(1);
    });
});

// ── RiskSuggestionSession ───────────────────────────────────────────

describe('RiskSuggestionSession (id, tenantId)', () => {
    it("RiskSuggestionItem cannot point at another tenant's session", async () => {
        const session = (tenantId: string) => prisma.riskSuggestionSession.create({
            data: { tenantId, createdByUserId: actorId, inputJson: '{}' },
        });
        const ownSession = await session(T1);
        const foreignSession = await session(T2);

        const insert =
            'INSERT INTO "RiskSuggestionItem" ("id", "tenantId", "sessionId", "title", "updatedAt") '
            + `VALUES ($1, $2, $3, 'probe item', now())`;

        const msg = await failureOf(insert, 'rsi-neg', T1, foreignSession.id);
        expect(msg).toContain('RiskSuggestionItem_sessionId_tenantId_fkey');

        const rows = await prisma.$executeRawUnsafe(insert, 'rsi-pos', T1, ownSession.id);
        expect(rows).toBe(1);
    });
});

// ── FileRecord ──────────────────────────────────────────────────────

describe('FileRecord (id, tenantId)', () => {
    /**
     * Stand up a probe child whose only FK is the composite one, run `body`,
     * then ALWAYS roll back — the throw at the end is what discards the DDL.
     * Postgres is transactional for DDL, so nothing survives this call.
     */
    async function withProbeChild(body: (tx: PrismaClient, insert: string) => Promise<void>) {
        const insert = 'INSERT INTO "_fk_b1_probe" ("id", "tenantId", "fileRecordId") VALUES ($1, $2, $3)';
        const ROLLBACK = '__fk_b1_probe_rollback__';
        try {
            await prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(
                    `CREATE TABLE "_fk_b1_probe" (
                         "id" TEXT PRIMARY KEY,
                         "tenantId" TEXT NOT NULL,
                         "fileRecordId" TEXT NOT NULL,
                         CONSTRAINT "_fk_b1_probe_fileRecordId_tenantId_fkey"
                             FOREIGN KEY ("fileRecordId", "tenantId")
                             REFERENCES "FileRecord"("id", "tenantId")
                             ON DELETE CASCADE ON UPDATE CASCADE
                     )`,
                );
                await body(tx as unknown as PrismaClient, insert);
                throw new Error(ROLLBACK);
            });
        } catch (err) {
            if (!(err instanceof Error) || err.message !== ROLLBACK) throw err;
        }
    }

    async function file(tenantId: string, tag: string) {
        return prisma.fileRecord.create({
            data: {
                tenantId,
                pathKey: `fk-b1/${tag}`,
                originalName: `${tag}.pdf`,
                mimeType: 'application/pdf',
                sizeBytes: 1,
                sha256: tag.padEnd(64, '0'),
                uploadedByUserId: actorId,
            },
        });
    }

    it('a composite FK against FileRecord(id, tenantId) refuses a foreign tenant', async () => {
        const foreignFile = await file(T2, 'foreign');

        // One transaction per arm: the first failed statement aborts the whole
        // Postgres transaction, so the negative cannot share one with the
        // positive.
        let negative = '';
        await withProbeChild(async (tx, insert) => {
            try {
                await tx.$executeRawUnsafe(insert, 'probe-neg', T1, foreignFile.id);
            } catch (err) {
                negative = err instanceof Error ? err.message : String(err);
                return;
            }
            throw new Error('EXPECTED the cross-tenant probe INSERT to be refused; it succeeded');
        });
        expect(negative).toContain('_fk_b1_probe_fileRecordId_tenantId_fkey');
    });

    it('the same composite FK accepts the tenant\'s own FileRecord', async () => {
        const ownFile = await file(T1, 'own');

        let inserted = 0;
        await withProbeChild(async (tx, insert) => {
            inserted = await tx.$executeRawUnsafe(insert, 'probe-pos', T1, ownFile.id);
        });
        expect(inserted).toBe(1);
    });

    it('the probe table left nothing behind', async () => {
        const rows = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
            `select count(*)::bigint as c from information_schema.tables
              where table_schema = 'public' and table_name = '_fk_b1_probe'`,
        );
        expect(Number(rows[0].c)).toBe(0);
    });
});

// ── The rewrite is complete, not merely additive ─────────────────────

describe('no single-column constraint survived the rewrite', () => {
    it('all ten old constraints are gone and all ten new ones are present', async () => {
        const NEW = [
            'AssetRiskLink_assetId_tenantId_fkey',
            'AssetVulnerability_assetId_tenantId_fkey',
            'ControlAsset_assetId_tenantId_fkey',
            'EvidenceAssetLink_assetId_tenantId_fkey',
            'FindingAsset_assetId_tenantId_fkey',
            'RiskSuggestionItem_sessionId_tenantId_fkey',
            'ScannerFinding_scannerRunId_tenantId_fkey',
            'TaskComment_taskId_tenantId_fkey',
            'TaskLink_taskId_tenantId_fkey',
            'TaskWatcher_taskId_tenantId_fkey',
        ];
        const OLD = [
            'AssetRiskLink_assetId_fkey',
            'AssetVulnerability_assetId_fkey',
            'ControlAsset_assetId_fkey',
            'EvidenceAssetLink_assetId_fkey',
            'FindingAsset_assetId_fkey',
            'RiskSuggestionItem_sessionId_fkey',
            'ScannerFinding_scannerRunId_fkey',
            'TaskComment_taskId_fkey',
            'TaskLink_taskId_fkey',
            'TaskWatcher_taskId_fkey',
        ];

        const rows = await prisma.$queryRawUnsafe<{ conname: string }[]>(
            `select conname from pg_constraint where contype = 'f' and conname = any($1::text[])`,
            [...NEW, ...OLD],
        );
        const live = new Set(rows.map((r) => r.conname));

        // Pinned exact lists in BOTH directions rather than counts: a count
        // stays green if one constraint is swapped for another, and an empty
        // selection is a pass.
        expect(NEW.filter((c) => !live.has(c))).toStrictEqual([]);
        expect(OLD.filter((c) => live.has(c))).toStrictEqual([]);
    });

    it('all five composite parent keys exist as unique indexes', async () => {
        const EXPECTED = [
            'Asset_id_tenantId_key',
            'FileRecord_id_tenantId_key',
            'RiskSuggestionSession_id_tenantId_key',
            'ScannerRun_id_tenantId_key',
            'Task_id_tenantId_key',
        ];
        const rows = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
            `select indexname from pg_indexes
              where schemaname = 'public' and indexname = any($1::text[])`,
            EXPECTED,
        );
        expect(rows.map((r) => r.indexname).sort()).toStrictEqual([...EXPECTED].sort());
    });

    it('every converted constraint still cascades on delete', async () => {
        // This migration must not move referential semantics: all ten were
        // ON DELETE CASCADE before it and must still be after. 'c' = CASCADE.
        const rows = await prisma.$queryRawUnsafe<{ conname: string; confdeltype: string }[]>(
            `select conname, confdeltype::text from pg_constraint
              where contype = 'f' and conname like any (array[
                  'AssetRiskLink_assetId_tenantId_fkey',
                  'AssetVulnerability_assetId_tenantId_fkey',
                  'ControlAsset_assetId_tenantId_fkey',
                  'EvidenceAssetLink_assetId_tenantId_fkey',
                  'FindingAsset_assetId_tenantId_fkey',
                  'RiskSuggestionItem_sessionId_tenantId_fkey',
                  'ScannerFinding_scannerRunId_tenantId_fkey',
                  'TaskComment_taskId_tenantId_fkey',
                  'TaskLink_taskId_tenantId_fkey',
                  'TaskWatcher_taskId_tenantId_fkey'
              ])
              order by conname`,
        );
        expect(rows).toHaveLength(10);
        expect(rows.filter((r) => r.confdeltype !== 'c')).toStrictEqual([]);
    });
});
