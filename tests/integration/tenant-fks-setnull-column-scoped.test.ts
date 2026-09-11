/**
 * #2356 SET NULL carve-out — the eight optional FKs that had to keep nulling.
 *
 * Batch 1 (20260911150000) made ten Asset/Task-component FKs composite and
 * deliberately left these eight alone: each is an OPTIONAL pointer whose parent
 * has a live hard-delete path, so "make it tenant-carrying" and "keep the
 * referential action" pull against each other. The batch-1 test says so in its
 * own header — FileRecord's three children were "filed rather than guessed".
 * This file is the answer, and it has to prove TWO things rather than one.
 *
 * ─── 1. The cross-tenant reference is now unrepresentable ───────────
 *
 * Same shape as batch 1, same reason for raw SQL: FK checks run AS THE TABLE
 * OWNER and bypass RLS, the usecase layer already refuses these writes, and a
 * test that went through it would pass against a database with no constraint at
 * all. Every negative anchors on the exact `conname` this migration added, so a
 * green assertion is evidence about the constraint it names — not about some
 * other constraint that happened to refuse the row. Every negative is paired
 * with the same INSERT against the tenant's OWN parent, because a constraint
 * that rejected every value would pass the negative alone and read as working
 * isolation.
 *
 * ─── 2. Deleting the parent still NULLS THE POINTER AND SUCCEEDS ────
 *
 * This is the half batch 1 could not deliver and the reason these eight were
 * carved out. A composite FK carrying `tenantId` cannot use plain SET NULL:
 * Postgres nulls EVERY referencing column, `tenantId` is NOT NULL, and the
 * parent delete aborts with SQLSTATE 23502 — reported against a column the
 * DELETE never mentioned. The migration installs the Postgres 15+ column-scoped
 * form, `ON DELETE SET NULL ("<the fk column>")`.
 *
 * So the delete cases below assert four things at once, and all four are load
 * bearing:
 *
 *   · the DELETE succeeds                 — not 23502 (whole-row SET NULL),
 *                                           not 23503 (someone "fixed" it to
 *                                           RESTRICT)
 *   · the child row SURVIVES              — the pointer was dropped, not the row
 *   · the pointer is NULL                 — the action actually ran
 *   · `tenantId` is UNCHANGED             — the column list did its job
 *
 * The last one is the whole point and is invisible to every other test: a plain
 * SET NULL that somehow succeeded would leave `tenantId` NULL, and a row whose
 * tenant has been erased is worse than the delete failing.
 *
 * `pg_constraint.confdelsetcols` is asserted by the migration's own
 * post-condition rather than here, because plain and column-scoped SET NULL are
 * BOTH `confdeltype = 'n'` and only the column list separates them. This file
 * exercises the BEHAVIOUR; the migration pins the DEFINITION.
 */
import { PrismaClient } from '@prisma/client';
import { prismaTestClient, resetDatabase } from '../helpers/db';

const prisma: PrismaClient = prismaTestClient();
jest.setTimeout(60_000);

const T1 = 'fk-sn-t1';
const T2 = 'fk-sn-t2';
const ACTOR_EMAIL = 'fk-sn-actor@example.test';

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
 * Hard-DELETE the parent with raw SQL, exactly as the data-lifecycle sweep does
 * (`DELETE FROM "<Model>" WHERE "id" = $1`), bypassing the soft-delete client
 * extension and any application-side referential handling. Returns nothing and
 * THROWS on refusal — which is the assertion.
 */
async function hardDelete(table: string, id: string): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id" = $1`, id);
}

/** Read back one child row's pointer and tenant, as the database has them. */
async function pointerAndTenant(
    table: string,
    id: string,
    column: string,
): Promise<{ pointer: string | null; tenantId: string | null } | undefined> {
    const rows = await prisma.$queryRawUnsafe<
        Array<{ pointer: string | null; tenantId: string | null }>
    >(`SELECT "${column}" AS "pointer", "tenantId" FROM "${table}" WHERE "id" = $1`, id);
    return rows[0];
}

// ── Fixtures ────────────────────────────────────────────────────────

const asset = (tenantId: string, name: string) =>
    prisma.asset.create({ data: { tenantId, name, type: 'SYSTEM' } });

const task = (tenantId: string, title: string) =>
    prisma.task.create({ data: { tenantId, title, createdByUserId: actorId } });

/**
 * `AssetVulnerability.cveId` references the GLOBAL `Cve` catalogue (not
 * tenant-scoped), so both AssetVulnerability probes need a real CVE row or they
 * fail on `AssetVulnerability_cveId_fkey` — a constraint this migration does not
 * touch, reported as if the migration were at fault.
 */
const CVE_ID = 'CVE-2026-FKSN';

let fileSeq = 0;
const fileRecord = (tenantId: string, name: string) =>
    prisma.fileRecord.create({
        data: {
            tenantId,
            pathKey: `fk-sn/${tenantId}/${name}/${(fileSeq += 1)}`,
            originalName: name,
            mimeType: 'text/plain',
            sizeBytes: 1,
            sha256: `sha-${tenantId}-${name}-${fileSeq}`,
            uploadedByUserId: actorId,
        },
    });

async function clearProbeRows() {
    await resetDatabase(prisma);
    await prisma.riskSuggestionSession.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await prisma.scannerRun.deleteMany({ where: { tenantId: { in: [T1, T2] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [T1, T2] } } });
    await prisma.user.deleteMany({ where: { email: ACTOR_EMAIL } });
    await prisma.cve.deleteMany({ where: { id: CVE_ID } });
}

beforeAll(async () => {
    await clearProbeRows();
    for (const id of [T1, T2]) {
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
    }
    const actor = await prisma.user.create({ data: { email: ACTOR_EMAIL, name: 'fk-sn actor' } });
    actorId = actor.id;
    await prisma.cve.upsert({
        where: { id: CVE_ID },
        update: {},
        create: {
            id: CVE_ID,
            publishedAt: new Date(),
            lastModifiedAt: new Date(),
            summary: 'probe CVE for the #2356 SET NULL carve-out',
        },
    });
});

afterAll(clearProbeRows);

// ════════════════════════════════════════════════════════════════════
//  1. THE CROSS-TENANT REFERENCE IS REFUSED
// ════════════════════════════════════════════════════════════════════

describe('the database refuses a cross-tenant reference on all eight sites', () => {
    it("Evidence cannot point at another tenant's Asset, Task or FileRecord", async () => {
        const own = {
            a: await asset(T1, 'ev own asset'),
            t: await task(T1, 'ev own task'),
            f: await fileRecord(T1, 'ev-own'),
        };
        const foreign = {
            a: await asset(T2, 'ev foreign asset'),
            t: await task(T2, 'ev foreign task'),
            f: await fileRecord(T2, 'ev-foreign'),
        };

        const insert =
            'INSERT INTO "Evidence" ("id", "tenantId", "type", "title", "updatedAt", "assetId", "taskId", "fileRecordId") '
            + `VALUES ($1, $2, 'LINK', 'probe', now(), $3, $4, $5)`;

        // One foreign pointer at a time, the other two this tenant's own, so
        // the constraint that refuses is the one each assertion names.
        expect(
            await failureOf(insert, 'ev-neg-a', T1, foreign.a.id, own.t.id, own.f.id),
        ).toContain('Evidence_assetId_tenantId_fkey');
        expect(
            await failureOf(insert, 'ev-neg-t', T1, own.a.id, foreign.t.id, own.f.id),
        ).toContain('Evidence_taskId_tenantId_fkey');
        expect(
            await failureOf(insert, 'ev-neg-f', T1, own.a.id, own.t.id, foreign.f.id),
        ).toContain('Evidence_fileRecordId_tenantId_fkey');

        // POSITIVE COMPANION — same statement, all three own.
        expect(
            await prisma.$executeRawUnsafe(insert, 'ev-pos', T1, own.a.id, own.t.id, own.f.id),
        ).toBe(1);
    });

    it("AccessReview cannot point at another tenant's FileRecord", async () => {
        const ownFile = await fileRecord(T1, 'ar-own');
        const foreignFile = await fileRecord(T2, 'ar-foreign');

        const insert =
            'INSERT INTO "AccessReview" ("id", "tenantId", "name", "reviewerUserId", "createdByUserId", "updatedAt", "evidenceFileRecordId") '
            + 'VALUES ($1, $2, $3, $4, $4, now(), $5)';

        expect(
            await failureOf(insert, 'ar-neg', T1, 'probe review', actorId, foreignFile.id),
        ).toContain('AccessReview_evidenceFileRecordId_tenantId_fkey');

        expect(
            await prisma.$executeRawUnsafe(insert, 'ar-pos', T1, 'probe review', actorId, ownFile.id),
        ).toBe(1);
    });

    it("FileRecord cannot name another tenant's FileRecord as its previous version", async () => {
        // Self-referential, and the one site where a careless reading of the
        // relation would have the parent and child be the same row.
        const ownPrev = await fileRecord(T1, 'fr-own-prev');
        const foreignPrev = await fileRecord(T2, 'fr-foreign-prev');

        const insert =
            'INSERT INTO "FileRecord" ("id", "tenantId", "pathKey", "originalName", "mimeType", "sizeBytes", "sha256", "uploadedByUserId", "updatedAt", "previousFileRecordId") '
            + `VALUES ($1, $2, $3, 'probe.txt', 'text/plain', 1, $4, $5, now(), $6)`;

        expect(
            await failureOf(insert, 'fr-neg', T1, 'fk-sn/fr-neg', 'sha-fr-neg', actorId, foreignPrev.id),
        ).toContain('FileRecord_previousFileRecordId_tenantId_fkey');

        expect(
            await prisma.$executeRawUnsafe(
                insert, 'fr-pos', T1, 'fk-sn/fr-pos', 'sha-fr-pos', actorId, ownPrev.id,
            ),
        ).toBe(1);
    });

    it("AssetVulnerability cannot point at another tenant's remediation Task", async () => {
        const host = await asset(T1, 'av host');
        const ownTask = await task(T1, 'av own task');
        const foreignTask = await task(T2, 'av foreign task');

        const insert =
            'INSERT INTO "AssetVulnerability" ("id", "tenantId", "assetId", "cveId", "matchedVia", "remediationTaskId") '
            + `VALUES ($1, $2, $3, $5, 'PROBE', $4)`;

        expect(
            await failureOf(insert, 'av-neg', T1, host.id, foreignTask.id, CVE_ID),
        ).toContain('AssetVulnerability_remediationTaskId_tenantId_fkey');

        expect(
            await prisma.$executeRawUnsafe(insert, 'av-pos', T1, host.id, ownTask.id, CVE_ID),
        ).toBe(1);
    });

    it("ScannerFinding cannot point at another tenant's Asset", async () => {
        const run = await prisma.scannerRun.create({
            data: {
                tenantId: T1, source: 'SEMGREP', scanType: 'SAST',
                ranAt: new Date(), outcome: 'PASS', ingestedVia: 'API',
            },
        });
        const ownAsset = await asset(T1, 'sf own asset');
        const foreignAsset = await asset(T2, 'sf foreign asset');

        const insert =
            'INSERT INTO "ScannerFinding" ("id", "tenantId", "scannerRunId", "fingerprint", "ruleId", "severity", "title", "updatedAt", "assetId") '
            + `VALUES ($1, $2, $3, $4, 'rule-1', 'HIGH', 'probe finding', now(), $5)`;

        expect(
            await failureOf(insert, 'sf-neg', T1, run.id, 'fp-sn-neg', foreignAsset.id),
        ).toContain('ScannerFinding_assetId_tenantId_fkey');

        expect(
            await prisma.$executeRawUnsafe(insert, 'sf-pos', T1, run.id, 'fp-sn-pos', ownAsset.id),
        ).toBe(1);
    });

    it("RiskSuggestionItem cannot point at another tenant's Asset", async () => {
        const session = await prisma.riskSuggestionSession.create({
            data: { tenantId: T1, createdByUserId: actorId, inputJson: '{}' },
        });
        const ownAsset = await asset(T1, 'rsi own asset');
        const foreignAsset = await asset(T2, 'rsi foreign asset');

        const insert =
            'INSERT INTO "RiskSuggestionItem" ("id", "tenantId", "sessionId", "title", "updatedAt", "assetId") '
            + `VALUES ($1, $2, $3, 'probe suggestion', now(), $4)`;

        expect(
            await failureOf(insert, 'rsi-neg', T1, session.id, foreignAsset.id),
        ).toContain('RiskSuggestionItem_assetId_tenantId_fkey');

        expect(
            await prisma.$executeRawUnsafe(insert, 'rsi-pos', T1, session.id, ownAsset.id),
        ).toBe(1);
    });
});

// ════════════════════════════════════════════════════════════════════
//  2. DELETING THE PARENT NULLS THE POINTER AND LEAVES tenantId ALONE
// ════════════════════════════════════════════════════════════════════

describe('the parent delete still succeeds, and nulls ONLY the pointer', () => {
    it('deleting an Asset nulls Evidence.assetId and keeps its tenant', async () => {
        const doomed = await asset(T1, 'doomed asset');
        const ev = await prisma.evidence.create({
            data: { tenantId: T1, type: 'LINK', title: 'survives its asset', assetId: doomed.id },
        });

        // Must NOT raise: 23502 is the whole-row SET NULL bug, 23503 is RESTRICT.
        await hardDelete('Asset', doomed.id);

        const after = await pointerAndTenant('Evidence', ev.id, 'assetId');
        expect(after).toBeDefined();
        expect(after?.pointer).toBeNull();
        expect(after?.tenantId).toBe(T1);
    });

    it('deleting a Task nulls AssetVulnerability.remediationTaskId and keeps its tenant', async () => {
        const host = await asset(T1, 'av delete host');
        const doomed = await task(T1, 'doomed task');
        const av = await prisma.assetVulnerability.create({
            data: {
                tenantId: T1, assetId: host.id, cveId: CVE_ID,
                matchedVia: 'PROBE', remediationTaskId: doomed.id,
            },
        });

        await hardDelete('Task', doomed.id);

        const after = await pointerAndTenant('AssetVulnerability', av.id, 'remediationTaskId');
        expect(after).toBeDefined();
        expect(after?.pointer).toBeNull();
        expect(after?.tenantId).toBe(T1);
    });

    it('deleting a FileRecord nulls AccessReview.evidenceFileRecordId and keeps its tenant', async () => {
        const doomed = await fileRecord(T1, 'doomed-file');
        const review = await prisma.accessReview.create({
            data: {
                tenantId: T1, name: 'survives its evidence file',
                reviewerUserId: actorId, createdByUserId: actorId,
                evidenceFileRecordId: doomed.id,
            },
        });

        await hardDelete('FileRecord', doomed.id);

        const after = await pointerAndTenant('AccessReview', review.id, 'evidenceFileRecordId');
        expect(after).toBeDefined();
        expect(after?.pointer).toBeNull();
        expect(after?.tenantId).toBe(T1);
    });

    it('deleting a prior FileRecord version nulls the successor’s back-pointer', async () => {
        // The self-referential site: parent and child are the same TABLE, so a
        // whole-row SET NULL here would null the tenant of a row that is itself
        // somebody's parent.
        const prior = await fileRecord(T1, 'prior-version');
        const successor = await prisma.fileRecord.create({
            data: {
                tenantId: T1, pathKey: 'fk-sn/successor', originalName: 'successor.txt',
                mimeType: 'text/plain', sizeBytes: 1, sha256: 'sha-successor',
                uploadedByUserId: actorId, previousFileRecordId: prior.id,
            },
        });

        await hardDelete('FileRecord', prior.id);

        const after = await pointerAndTenant('FileRecord', successor.id, 'previousFileRecordId');
        expect(after).toBeDefined();
        expect(after?.pointer).toBeNull();
        expect(after?.tenantId).toBe(T1);
    });
});
