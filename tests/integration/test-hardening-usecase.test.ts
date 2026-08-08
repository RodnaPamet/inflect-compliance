/**
 * Integration coverage for `src/app-layer/usecases/test-hardening.ts`.
 *
 * DB-backed (per repo convention — integration tests never mock Prisma).
 * Seeds via a plain client; the usecases run through the prisma singleton
 * (DATABASE_URL points at the same test DB) inside runInTenantContext.
 *
 * Branches exercised:
 *   linkEvidenceWithHash:
 *     - run-not-found → notFound.
 *     - FILE kind with fileId → verifyFileIntegrity throws (no storage)
 *       → sha256Hash stays null (the catch arm), link still created.
 *     - non-FILE kind (LINK) → no hash attempt; created with nulls.
 *   verifyRunEvidence:
 *     - run-not-found → notFound.
 *     - FILE-kind link whose hash recompute throws → error-captured row.
 *     - non-FILE link → matches=null, error=null branch.
 *     - aggregate counts (totalLinks/fileLinks/integrityOk).
 *   snapshotTestRun:
 *     - pack-not-found / run-not-found → notFound.
 *     - FROZEN/EXPORTED pack → badRequest.
 *     - non-COMPLETED run → badRequest.
 *     - duplicate item → badRequest.
 *     - happy path → AuditPackItem created with snapshotJson + sortOrder.
 *   exportTestEvidenceBundle:
 *     - json format (default) returns rows.
 *     - csv format with rows → header + escaped cells.
 *     - csv format with zero rows → "No test runs found." sentinel.
 *     - controlId + periodDays filter branches.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    verifyRunEvidence,
    snapshotTestRun,
    exportTestEvidenceBundle,
} from '@/app-layer/usecases/test-hardening';
// PR-R — hashing on evidence link moved to the live linkEvidenceToRun path.
import { linkEvidenceToRun } from '@/app-layer/usecases/control';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }) });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `th-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE, userId: `u-${SUITE}` });

let controlId: string;
let planId: string;
let cycleId: string;

async function makeRun(over: Record<string, unknown> = {}): Promise<string> {
    const run = await prisma.controlTestRun.create({
        data: {
            tenant: { connect: { id: TENANT } },
            control: { connect: { id: controlId } },
            testPlan: { connect: { id: planId } },
            status: 'COMPLETED',
            result: 'PASS',
            createdBy: { connect: { id: ctx.userId } },
            executedBy: { connect: { id: ctx.userId } },
            executedAt: new Date(),
            ...over,
        },
    });
    return run.id;
}

describeFn('test-hardening usecases (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({
            where: { id: TENANT }, update: {},
            create: { id: TENANT, name: SUITE, slug: SUITE },
        });
        const email = `${SUITE}@example.test`;
        await prisma.user.upsert({
            where: { id: ctx.userId }, update: {},
            create: { id: ctx.userId, email, emailHash: hashForLookup(email) },
        });
        const control = await prisma.control.create({
            data: { tenantId: TENANT, name: 'C1', code: 'C-1' },
        });
        controlId = control.id;
        const plan = await prisma.controlTestPlan.create({
            data: { tenant: { connect: { id: TENANT } }, control: { connect: { id: controlId } }, createdBy: { connect: { id: ctx.userId } }, name: 'Plan 1' },
        });
        planId = plan.id;
        const cycle = await prisma.auditCycle.create({
            data: { tenant: { connect: { id: TENANT } }, frameworkKey: 'iso27001', frameworkVersion: '2022', name: 'Cycle', createdBy: { connect: { id: ctx.userId } } },
        });
        cycleId = cycle.id;
    });

    afterAll(async () => {
        await cleanup();
        await prisma.$disconnect();
    });

    async function cleanup() {
        await prisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT);
        });
        await prisma.auditPackItem.deleteMany({ where: { tenantId: TENANT } });
        await prisma.auditPack.deleteMany({ where: { tenantId: TENANT } });
        await prisma.controlTestEvidenceLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.controlTestRun.deleteMany({ where: { tenantId: TENANT } });
    }

    afterEach(async () => {
        await prisma.auditPackItem.deleteMany({ where: { tenantId: TENANT } });
        await prisma.auditPack.deleteMany({ where: { tenantId: TENANT } });
        await prisma.controlTestEvidenceLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.controlTestRun.deleteMany({ where: { tenantId: TENANT } });
    });

    // ── linkEvidenceToRun (hashing on the live path — PR-R) ──────────
    it('linkEvidenceToRun throws notFound for a missing run', async () => {
        await expect(linkEvidenceToRun(ctx, 'nope', { kind: 'LINK' })).rejects.toThrow(/not found/i);
    });

    it('linkEvidenceToRun REJECTS a FILE link whose fileId does not resolve in the tenant', async () => {
        // Fail-closed: an unresolvable FILE link can never be integrity-verified,
        // so it must be rejected at link time rather than stored with a null hash
        // that later scores VERIFIED. (Uses a non-completed run to isolate the
        // fileId check from the completed-run guard.)
        const runId = await makeRun({ status: 'PLANNED', result: null, executedAt: null });
        await expect(
            linkEvidenceToRun(ctx, runId, { kind: 'FILE', fileId: 'missing-file' }),
        ).rejects.toThrow(/does not exist in this tenant/i);
    });

    it('linkEvidenceToRun rejects adding evidence to a COMPLETED run', async () => {
        const runId = await makeRun(); // COMPLETED by default
        await expect(
            linkEvidenceToRun(ctx, runId, { kind: 'LINK', url: 'https://x' }),
        ).rejects.toThrow(/completed/i);
    });

    it('linkEvidenceToRun LINK kind creates without hashing', async () => {
        const runId = await makeRun({ status: 'PLANNED', result: null, executedAt: null });
        const link = await linkEvidenceToRun(ctx, runId, { kind: 'LINK', url: 'https://x' });
        expect(link.kind).toBe('LINK');
        expect(link.sha256Hash).toBeNull();
        expect(link.url).toBe('https://x');
    });

    it('linkEvidenceToRun FILE with a real FileRecord freezes its sha256 on the link (PR-R)', async () => {
        const runId = await makeRun({ status: 'PLANNED', result: null, executedAt: null });
        const file = await prisma.fileRecord.create({
            data: {
                tenantId: TENANT,
                pathKey: `t/${TENANT}/${randomUUID()}.txt`,
                originalName: 'evidence.txt',
                mimeType: 'text/plain',
                sizeBytes: 12,
                sha256: 'a'.repeat(64),
                storageProvider: 'local',
                uploadedByUserId: ctx.userId,
            },
        });
        const link = await linkEvidenceToRun(ctx, runId, { kind: 'FILE', fileId: file.id });
        expect(link.kind).toBe('FILE');
        // The integrity hash is frozen from FileRecord.sha256 — not null.
        expect(link.sha256Hash).toBe('a'.repeat(64));
        await prisma.fileRecord.delete({ where: { id: file.id } });
    });

    // ── verifyRunEvidence ────────────────────────────────────────────
    it('verifyRunEvidence throws notFound for a missing run', async () => {
        await expect(verifyRunEvidence(ctx, 'nope')).rejects.toThrow(/not found/i);
    });

    it('verifyRunEvidence FAILS integrity when a hashed FILE can no longer be verified (PR-R)', async () => {
        const runId = await makeRun();
        // A FILE link with a FROZEN hash whose file/record is gone → the integrity
        // check can no longer confirm it → this is a FAILURE, not a trivial pass.
        await prisma.controlTestEvidenceLink.create({
            data: { tenant: { connect: { id: TENANT } }, testRun: { connect: { id: runId } }, kind: 'FILE', fileId: 'missing', sha256Hash: 'abc', createdBy: { connect: { id: ctx.userId } } },
        });
        await prisma.controlTestEvidenceLink.create({
            data: { tenant: { connect: { id: TENANT } }, testRun: { connect: { id: runId } }, kind: 'LINK', url: 'https://x', createdBy: { connect: { id: ctx.userId } } },
        });
        const res = await verifyRunEvidence(ctx, runId);
        expect(res.totalLinks).toBe(2);
        expect(res.fileLinks).toBe(1);
        const fileRow = res.details.find((d) => d.kind === 'FILE')!;
        expect(fileRow.error).toBeTruthy();
        expect(fileRow.matches).toBe(false); // frozen hash, unverifiable → fail
        expect(res.mismatches).toBe(1);
        expect(res.unverifiable).toBe(0);
        // Non-FILE links carry no file integrity → matches null, never fail.
        const linkRow = res.details.find((d) => d.kind === 'LINK')!;
        expect(linkRow.matches).toBeNull();
        expect(linkRow.error).toBeNull();
        // A FILE link that failed verification drops integrityOk to false.
        expect(res.integrityOk).toBe(false);
    });

    it('verifyRunEvidence stays OK when a FILE link has no frozen hash (legacy, unverifiable)', async () => {
        const runId = await makeRun();
        await prisma.controlTestEvidenceLink.create({
            data: { tenant: { connect: { id: TENANT } }, testRun: { connect: { id: runId } }, kind: 'FILE', fileId: 'missing2', createdBy: { connect: { id: ctx.userId } } },
        });
        const res = await verifyRunEvidence(ctx, runId);
        // No stored hash → nothing to compare → unverifiable. This no longer
        // folds into a PASS: an unverifiable FILE link drops integrityOk to
        // false (the fail-open path is closed).
        expect(res.unverifiable).toBe(1);
        expect(res.integrityOk).toBe(false);
    });

    // ── snapshotTestRun ──────────────────────────────────────────────
    async function makePack(status: 'DRAFT' | 'FROZEN' | 'EXPORTED' = 'DRAFT'): Promise<string> {
        const pack = await prisma.auditPack.create({
            data: { tenant: { connect: { id: TENANT } }, cycle: { connect: { id: cycleId } }, name: 'Pack', status },
        });
        return pack.id;
    }

    it('snapshotTestRun throws notFound for a missing pack', async () => {
        const runId = await makeRun();
        await expect(snapshotTestRun(ctx, runId, 'nope')).rejects.toThrow(/pack not found/i);
    });

    it('snapshotTestRun rejects a FROZEN pack', async () => {
        const runId = await makeRun();
        const packId = await makePack('FROZEN');
        await expect(snapshotTestRun(ctx, runId, packId)).rejects.toThrow(/frozen\/exported/i);
    });

    it('snapshotTestRun rejects a non-COMPLETED run', async () => {
        const runId = await makeRun({ status: 'PLANNED', result: null, executedAt: null });
        const packId = await makePack('DRAFT');
        await expect(snapshotTestRun(ctx, runId, packId)).rejects.toThrow(/completed/i);
    });

    it('snapshotTestRun creates an item then rejects a duplicate', async () => {
        const runId = await makeRun();
        const packId = await makePack('DRAFT');
        const item = await snapshotTestRun(ctx, runId, packId);
        expect(item.entityType).toBe('TEST_RUN');
        expect(item.sortOrder).toBe(1);
        const parsed = JSON.parse(item.snapshotJson as string);
        expect(parsed.snapshotVersion).toBe(1);
        expect(parsed.testRun.id).toBe(runId);
        // Duplicate → badRequest.
        await expect(snapshotTestRun(ctx, runId, packId)).rejects.toThrow(/already in the audit pack/i);
    });

    it('snapshotTestRun increments sortOrder for a second distinct run', async () => {
        const packId = await makePack('DRAFT');
        const run1 = await makeRun();
        const run2 = await makeRun();
        const i1 = await snapshotTestRun(ctx, run1, packId);
        const i2 = await snapshotTestRun(ctx, run2, packId);
        expect(i2.sortOrder).toBe(i1.sortOrder + 1);
    });

    // ── exportTestEvidenceBundle ─────────────────────────────────────
    it('exportTestEvidenceBundle json (default) returns row objects', async () => {
        const runId = await makeRun({ notes: 'a,b "quoted"' });
        await prisma.controlTestEvidenceLink.create({
            data: { tenant: { connect: { id: TENANT } }, testRun: { connect: { id: runId } }, kind: 'FILE', fileId: 'f1', sha256Hash: 'h1', createdBy: { connect: { id: ctx.userId } } },
        });
        const out = (await exportTestEvidenceBundle(ctx, {})) as {
            rows: Array<Record<string, unknown>>;
            truncated: boolean;
        };
        expect(Array.isArray(out.rows)).toBe(true);
        expect(out.truncated).toBe(false);
        const rows = out.rows;
        expect(rows.length).toBeGreaterThanOrEqual(1);
        expect(rows[0].evidenceHashes).toContain('f1:h1');
    });

    it('exportTestEvidenceBundle csv escapes commas/quotes and joins rows', async () => {
        await makeRun({ notes: 'has, comma' });
        const csv = (await exportTestEvidenceBundle(ctx, { format: 'csv' })) as string;
        expect(csv.split('\n')[0]).toContain('runId'); // header row
        expect(csv).toContain('"has, comma"'); // quoted because of comma
    });

    it('exportTestEvidenceBundle csv with no rows returns the sentinel', async () => {
        const csv = (await exportTestEvidenceBundle(ctx, {
            format: 'csv',
            controlId: 'no-such-control',
        })) as string;
        expect(csv).toBe('No test runs found.\n');
    });

    it('exportTestEvidenceBundle honours controlId + periodDays filters', async () => {
        await makeRun();
        const { rows } = (await exportTestEvidenceBundle(ctx, {
            controlId,
            periodDays: 30,
        })) as { rows: unknown[] };
        expect(rows.length).toBeGreaterThanOrEqual(1);
    });
});
