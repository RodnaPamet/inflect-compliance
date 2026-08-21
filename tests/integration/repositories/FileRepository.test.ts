/**
 * Integration coverage for FileRepository
 * (`src/app-layer/repositories/FileRepository.ts`).
 *
 * Operates over the RLS-protected `FileRecord` table. Each public
 * static method gets a happy-path exercise via prismaTestClient + an
 * RLS-rejection block mirroring `access-review-rls.test.ts`.
 *
 * Methods covered: createPending (defaulted + explicit-option
 * branches), markStored, markFailed, markDeleted, getById,
 * getByIdForTenant, listByTenant (status-filter branch + no-filter),
 * findBySha256, findPendingOlderThan, updateScanStatus (with/without
 * scanDetails), markScanClean, markScanInfected, findPendingScan
 * (tenant-filter branch + no-filter), getByPathKey,
 * isFileOwnedByTenant (evidence-match branch + filerecord-match branch
 * + neither).
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { DB_AVAILABLE } from '../db-helper';
import { prismaTestClient } from '../../helpers/db';
import { withTenantDb } from '@/lib/db-context';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../../helpers/make-context';
import { FileRepository } from '@/app-layer/repositories/FileRepository';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `file-${randomUUID().slice(0, 8)}`;
const TENANT_A = `t-${SUITE}-a`;
const TENANT_B = `t-${SUITE}-b`;

describeFn('FileRepository (integration — real DB)', () => {
    let prisma: PrismaClient;
    let userId = '';
    let CTX_A: ReturnType<typeof makeRequestContext>;

    function pendingData(overrides: Record<string, unknown> = {}) {
        return {
            pathKey: `path/${randomUUID()}`,
            originalName: 'doc.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: randomUUID().replace(/-/g, ''),
            ...overrides,
        };
    }

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        for (const id of [TENANT_A, TENANT_B]) {
            await prisma.tenant.upsert({
                where: { id },
                update: {},
                create: { id, name: id, slug: id },
            });
        }
        const email = `${SUITE}@example.test`;
        const user = await prisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        userId = user.id;
        CTX_A = makeRequestContext('ADMIN', { tenantId: TENANT_A, userId });
    });

    afterAll(async () => {
        await prisma.evidence.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await prisma.fileRecord.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await prisma.user.deleteMany({ where: { id: userId } });
        await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
        await prisma.$disconnect();
    });

    afterEach(async () => {
        await prisma.evidence.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
        await prisma.fileRecord.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    });

    it('createPending applies defaults; the lifecycle markers transition status', async () => {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        expect(rec.status).toBe('PENDING');
        expect(rec.uploadedByUserId).toBe(userId);
        expect(rec.domain).toBe('general'); // default branch
        expect(rec.bucket).toBeNull();
        expect(rec.storageProvider).toBeTruthy(); // env default branch

        const stored = await FileRepository.markStored(prisma, CTX_A, rec.id);
        expect(stored.status).toBe('STORED');
        expect(stored.scanStatus).toBe('PENDING');
        expect(stored.storedAt).not.toBeNull();

        const failed = await FileRepository.markFailed(prisma, CTX_A, rec.id);
        expect(failed.status).toBe('FAILED');

        const deleted = await FileRepository.markDeleted(prisma, CTX_A, rec.id);
        expect(deleted.status).toBe('DELETED');
    });

    it('createPending honours explicit storageProvider/bucket/domain options', async () => {
        const rec = await FileRepository.createPending(
            prisma,
            CTX_A,
            pendingData({ storageProvider: 's3', bucket: 'my-bucket', domain: 'evidence' }),
        );
        expect(rec.storageProvider).toBe('s3');
        expect(rec.bucket).toBe('my-bucket');
        expect(rec.domain).toBe('evidence');
    });

    it('getById / getByIdForTenant are tenant-scoped', async () => {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        expect((await FileRepository.getById(prisma, CTX_A, rec.id))?.id).toBe(rec.id);
        expect((await FileRepository.getByIdForTenant(prisma, TENANT_A, rec.id))?.id).toBe(rec.id);
        // wrong tenant → null on both
        expect(await FileRepository.getByIdForTenant(prisma, TENANT_B, rec.id)).toBeNull();
    });

    it('listByTenant filters by status when given, returns all otherwise', async () => {
        const a = await FileRepository.createPending(prisma, CTX_A, pendingData());
        const b = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, b.id);

        const all = await FileRepository.listByTenant(prisma, CTX_A);
        expect(all).toHaveLength(2);

        const pendingOnly = await FileRepository.listByTenant(prisma, CTX_A, { status: 'PENDING' });
        expect(pendingOnly.map((r) => r.id)).toEqual([a.id]);
    });

    it('findBySha256 finds a STORED record with the same hash', async () => {
        const sha = randomUUID().replace(/-/g, '');
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData({ sha256: sha }));
        // PENDING → not found (status filter is STORED).
        expect(await FileRepository.findBySha256(prisma, TENANT_A, sha)).toBeNull();
        await FileRepository.markStored(prisma, CTX_A, rec.id);
        expect((await FileRepository.findBySha256(prisma, TENANT_A, sha))?.id).toBe(rec.id);
    });

    it('findBySha256 still finds the record after quarantine moves it to FAILED', async () => {
        // A quarantined hash must not fall out of the dedup index — otherwise
        // the identical bytes re-enter as a fresh PENDING row that nothing has
        // scanned. The unit suite proves this against an in-memory table; this
        // is the same claim against the real column types and the real planner.
        const sha = randomUUID().replace(/-/g, '');
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData({ sha256: sha }));
        await FileRepository.markStored(prisma, CTX_A, rec.id);

        // Byte-for-byte the AV webhook's quarantine write: both columns move
        // in ONE conditional statement. Reproduced rather than imported so a
        // change to that shape shows up here as a failure, not a silent skip.
        const claimed = await prisma.fileRecord.updateMany({
            where: { id: rec.id, scanStatus: { not: 'INFECTED' } },
            data: { scanStatus: 'INFECTED', scanDetails: 'EICAR', status: 'FAILED' },
        });
        expect(claimed.count).toBe(1);

        const found = await FileRepository.findBySha256(prisma, TENANT_A, sha);
        expect(found?.id).toBe(rec.id);
        expect(found?.scanStatus).toBe('INFECTED');
        expect(found?.status).toBe('FAILED');
    });

    it('findBySha256 prefers the quarantined row over a clean STORED twin', async () => {
        // The same bytes can already be STORED from before the signature that
        // catches them shipped. The verdict has to win regardless of which row
        // the planner would reach first, so the clean row is inserted FIRST.
        const sha = randomUUID().replace(/-/g, '');
        const clean = await FileRepository.createPending(prisma, CTX_A, pendingData({ sha256: sha }));
        await FileRepository.markStored(prisma, CTX_A, clean.id);
        await FileRepository.markScanClean(prisma, clean.id);

        const bad = await FileRepository.createPending(prisma, CTX_A, pendingData({ sha256: sha }));
        await FileRepository.markStored(prisma, CTX_A, bad.id);
        await prisma.fileRecord.updateMany({
            where: { id: bad.id, scanStatus: { not: 'INFECTED' } },
            data: { scanStatus: 'INFECTED', scanDetails: 'EICAR', status: 'FAILED' },
        });

        const found = await FileRepository.findBySha256(prisma, TENANT_A, sha);
        expect(found?.id).toBe(bad.id);
    });

    it('a quarantined hash in another tenant does not poison this one', async () => {
        const sha = randomUUID().replace(/-/g, '');
        const ctxB = makeRequestContext('ADMIN', { tenantId: TENANT_B, userId });
        const bad = await FileRepository.createPending(prisma, ctxB, pendingData({ sha256: sha }));
        await prisma.fileRecord.updateMany({
            where: { id: bad.id },
            data: { scanStatus: 'INFECTED', status: 'FAILED' },
        });

        expect(await FileRepository.findBySha256(prisma, TENANT_A, sha)).toBeNull();
    });

    it('listQuarantined returns only this tenant\'s live INFECTED rows', async () => {
        // The unit suite proves the `where` OBJECT; this proves the
        // predicate against the real enum columns and the real planner —
        // `status: { not: 'DELETED' }` is an enum comparison, not a string
        // one, and a DELETED row that leaked into this list would offer an
        // action `clearInfectedVerdict` is guaranteed to refuse.
        const ctxB = makeRequestContext('ADMIN', { tenantId: TENANT_B, userId });

        const live = await FileRepository.createPending(prisma, CTX_A, pendingData());
        const deleted = await FileRepository.createPending(prisma, CTX_A, pendingData());
        const clean = await FileRepository.createPending(prisma, CTX_A, pendingData());
        const otherTenant = await FileRepository.createPending(prisma, ctxB, pendingData());

        await prisma.fileRecord.updateMany({
            where: { id: { in: [live.id, otherTenant.id] } },
            data: { scanStatus: 'INFECTED', status: 'FAILED', scanDetails: 'EICAR' },
        });
        await prisma.fileRecord.updateMany({
            where: { id: deleted.id },
            data: { scanStatus: 'INFECTED', status: 'DELETED' },
        });
        await prisma.fileRecord.updateMany({
            where: { id: clean.id },
            data: { scanStatus: 'CLEAN', status: 'STORED' },
        });

        const rows = await FileRepository.listQuarantined(prisma, TENANT_A, { take: 50 });

        expect(rows.map((r) => r.id)).toEqual([live.id]);
        expect(rows[0].scanDetails).toBe('EICAR');
        // The storage locator never leaves the layer.
        expect('pathKey' in rows[0]).toBe(false);
    });

    it('listQuarantined pages with a stable cursor', async () => {
        const made: string[] = [];
        for (const _ of [0, 1, 2]) {
            const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
            made.push(rec.id);
        }
        // Every row stamped at the SAME instant — the case a non-unique
        // sort key silently skips or repeats rows on.
        const stamped = new Date('2026-08-01T00:00:00.000Z');
        await prisma.fileRecord.updateMany({
            where: { id: { in: made } },
            data: { scanStatus: 'INFECTED', status: 'FAILED', scannedAt: stamped },
        });

        const first = await FileRepository.listQuarantined(prisma, TENANT_A, { take: 2 });
        expect(first).toHaveLength(2);

        const second = await FileRepository.listQuarantined(prisma, TENANT_A, {
            take: 2,
            cursor: first[1].id,
        });

        const seen = [...first.map((r) => r.id), ...second.map((r) => r.id)];
        expect(seen).toHaveLength(3);
        expect(new Set(seen).size).toBe(3);
        expect([...seen].sort()).toEqual([...made].sort());
    });

    it('findPendingOlderThan returns old PENDING records', async () => {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        // Back-date it so the lt filter matches.
        await prisma.fileRecord.update({
            where: { id: rec.id },
            data: { createdAt: new Date(Date.now() - 86_400_000) },
        });
        const old = await FileRepository.findPendingOlderThan(prisma, TENANT_A, new Date());
        expect(old.map((r) => r.id)).toContain(rec.id);
        // A cutoff in the past finds nothing.
        const none = await FileRepository.findPendingOlderThan(prisma, TENANT_A, new Date(0));
        expect(none).toHaveLength(0);
    });

    it('scan lifecycle: updateScanStatus (with details), markScanClean, markScanInfected', async () => {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, rec.id);

        // These now return `FileRecord | null` — `null` is the refusal
        // signal added with the INFECTED-is-terminal guard below.
        const withDetails = await FileRepository.updateScanStatus(prisma, rec.id, 'SKIPPED', 'no scanner');
        expect(withDetails?.scanStatus).toBe('SKIPPED');
        expect(withDetails?.scanDetails).toBe('no scanner');

        const clean = await FileRepository.markScanClean(prisma, rec.id);
        expect(clean?.scanStatus).toBe('CLEAN');

        const infected = await FileRepository.markScanInfected(prisma, rec.id, 'EICAR');
        expect(infected?.scanStatus).toBe('INFECTED');
        expect(infected?.scanDetails).toBe('EICAR');
    });

    // ── INFECTED is terminal on the ordinary path ────────────────────
    //
    // The download gates trust `scanStatus` alone, so a row that walks
    // back from INFECTED to CLEAN is a served-malware bug. The webhook
    // already refuses the reversal with a conditional claim; these three
    // tests assert the repository primitive refuses it too, since the
    // repository is the surface a future rescan job would reach for.

    it('updateScanStatus refuses to move an INFECTED row back to CLEAN', async () => {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, rec.id);
        await FileRepository.markScanInfected(prisma, rec.id, 'EICAR-Test-Signature');

        // Refusal is reported, not swallowed: null means "did not apply".
        expect(await FileRepository.updateScanStatus(prisma, rec.id, 'CLEAN')).toBeNull();

        // And the stored row never moved.
        const after = await prisma.fileRecord.findUniqueOrThrow({ where: { id: rec.id } });
        expect(after.scanStatus).toBe('INFECTED');
        expect(after.scanDetails).toBe('EICAR-Test-Signature');
    });

    it('updateScanStatus refuses every other exit from INFECTED (SKIPPED / PENDING)', async () => {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, rec.id);
        await FileRepository.markScanInfected(prisma, rec.id, 'EICAR-Test-Signature');

        expect(await FileRepository.updateScanStatus(prisma, rec.id, 'SKIPPED', 'no scanner')).toBeNull();
        expect(await FileRepository.updateScanStatus(prisma, rec.id, 'PENDING')).toBeNull();

        const after = await prisma.fileRecord.findUniqueOrThrow({ where: { id: rec.id } });
        expect(after.scanStatus).toBe('INFECTED');
        expect(after.scanDetails).toBe('EICAR-Test-Signature');
    });

    it('markScanClean refuses on an INFECTED row', async () => {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, rec.id);
        await FileRepository.markScanInfected(prisma, rec.id, 'EICAR-Test-Signature');

        expect(await FileRepository.markScanClean(prisma, rec.id)).toBeNull();
        expect(
            (await prisma.fileRecord.findUniqueOrThrow({ where: { id: rec.id } })).scanStatus,
        ).toBe('INFECTED');
    });

    it('forward scan transitions still apply (PENDING -> CLEAN -> INFECTED)', async () => {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, rec.id);

        expect((await FileRepository.markScanClean(prisma, rec.id))?.scanStatus).toBe('CLEAN');
        const infected = await FileRepository.markScanInfected(prisma, rec.id, 'EICAR');
        expect(infected?.scanStatus).toBe('INFECTED');
        expect(infected?.scanDetails).toBe('EICAR');
    });

    // ── The sanctioned escape hatch: clearInfectedVerdict ────────────
    //
    // Task #123 (un-quarantining a false positive) is its only legitimate
    // consumer. These tests pin the door's shape so that task can be built
    // against it: audited-by-signature, tenant-scoped, one exact transition,
    // and no resurrection of deleted rows.

    /** STORED + FAILED + INFECTED — the shape the AV webhook leaves behind. */
    async function quarantinedRecord() {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, rec.id);
        await FileRepository.markFailed(prisma, CTX_A, rec.id);
        await FileRepository.markScanInfected(prisma, rec.id, 'EICAR-Test-Signature');
        return rec;
    }

    const override = {
        tenantId: TENANT_A,
        clearedByUserId: 'admin-user',
        reason: 'Vendor confirmed the signature is a false positive',
        auditLogId: 'audit-row-1',
    };

    it('clearInfectedVerdict lifts scan verdict and quarantine in one transition, stamping provenance', async () => {
        const rec = await quarantinedRecord();

        const restored = await FileRepository.clearInfectedVerdict(prisma, rec.id, {
            ...override,
            clearedByUserId: userId,
        });

        expect(restored?.scanStatus).toBe('CLEAN');
        // Quarantine lifts in the SAME statement — never CLEAN-but-FAILED.
        expect(restored?.status).toBe('STORED');

        // The row carries the provenance of its own reversal.
        const details = JSON.parse(restored?.scanDetails ?? '{}');
        expect(details.result).toBe('false_positive_cleared');
        expect(details.reason).toBe(override.reason);
        expect(details.clearedByUserId).toBe(userId);
        expect(details.auditLogId).toBe('audit-row-1');
    });

    it('clearInfectedVerdict refuses a row that is not INFECTED', async () => {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, rec.id);
        await FileRepository.markScanClean(prisma, rec.id);

        expect(await FileRepository.clearInfectedVerdict(prisma, rec.id, override)).toBeNull();
    });

    it('clearInfectedVerdict never resurrects a DELETED row', async () => {
        const rec = await quarantinedRecord();
        await FileRepository.markDeleted(prisma, CTX_A, rec.id);

        expect(await FileRepository.clearInfectedVerdict(prisma, rec.id, override)).toBeNull();

        const after = await prisma.fileRecord.findUniqueOrThrow({ where: { id: rec.id } });
        expect(after.status).toBe('DELETED');
        expect(after.scanStatus).toBe('INFECTED');
    });

    it('clearInfectedVerdict is tenant-scoped: a foreign tenantId clears nothing', async () => {
        const rec = await quarantinedRecord();

        expect(
            await FileRepository.clearInfectedVerdict(prisma, rec.id, {
                ...override,
                tenantId: TENANT_B,
            }),
        ).toBeNull();

        expect(
            (await prisma.fileRecord.findUniqueOrThrow({ where: { id: rec.id } })).scanStatus,
        ).toBe('INFECTED');
    });

    it('clearInfectedVerdict demands a reason and the id of the audit row recording the decision', async () => {
        const rec = await quarantinedRecord();

        await expect(
            FileRepository.clearInfectedVerdict(prisma, rec.id, { ...override, reason: '   ' }),
        ).rejects.toThrow(/reason/i);

        await expect(
            FileRepository.clearInfectedVerdict(prisma, rec.id, { ...override, auditLogId: '' }),
        ).rejects.toThrow(/audit/i);

        // Neither rejected call touched the row.
        expect(
            (await prisma.fileRecord.findUniqueOrThrow({ where: { id: rec.id } })).scanStatus,
        ).toBe('INFECTED');
    });

    it('findPendingScan returns STORED+PENDING-scan rows, optionally tenant-filtered', async () => {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, rec.id); // scanStatus PENDING, status STORED

        const tenantScoped = await FileRepository.findPendingScan(prisma, TENANT_A);
        expect(tenantScoped.map((r) => r.id)).toContain(rec.id);

        // No tenant filter → still includes the row.
        const global = await FileRepository.findPendingScan(prisma);
        expect(global.map((r) => r.id)).toContain(rec.id);
    });

    it('findPendingScan excludes a row whose backoff has not expired, and orders fewest-attempts first', async () => {
        // The reason `findPendingScan` cannot just be "everything PENDING":
        // a row that will never earn a verdict is permanently PENDING and,
        // ordered oldest-first under a `take`, holds the head of the page
        // against every row behind it.
        const due = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, due.id);
        const backedOff = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, backedOff.id);
        await prisma.fileRecord.update({
            where: { id: backedOff.id },
            data: { scanAttempts: 4, nextScanAttemptAt: new Date(Date.now() + 3_600_000) },
        });

        const ids = (await FileRepository.findPendingScan(prisma, TENANT_A)).map((r) => r.id);
        expect(ids).toContain(due.id);
        expect(ids).not.toContain(backedOff.id);

        // Past its backoff it comes back — capped, not exiled — but behind
        // the row nobody has tried yet.
        const later = new Date(Date.now() + 7_200_000);
        const ordered = (await FileRepository.findPendingScan(prisma, TENANT_A, later)).map(
            (r) => r.id,
        );
        expect(ordered).toContain(backedOff.id);
        expect(ordered.indexOf(due.id)).toBeLessThan(ordered.indexOf(backedOff.id));
    });

    it('recordScanAttempt writes only the attempt columns, and only while the row is PENDING', async () => {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, rec.id);

        const attempts = await FileRepository.recordScanAttempt(prisma, rec.id, {
            tenantId: TENANT_A,
            attempts: 0,
        });
        expect(attempts).toBe(1);

        const after = await prisma.fileRecord.findUniqueOrThrow({ where: { id: rec.id } });
        expect(after.scanAttempts).toBe(1);
        expect(after.nextScanAttemptAt).not.toBeNull();
        expect(after.lastScanAttemptAt).not.toBeNull();
        // The verdict columns are untouched — an attempt is not a result.
        expect(after.scanStatus).toBe('PENDING');
        expect(after.scannedAt).toBeNull();
        expect(after.scanDetails).toBeNull();

        // Once a verdict lands, the bookkeeping stops: the row has left the
        // queue and a counter describing it would be stale forever.
        await prisma.fileRecord.update({
            where: { id: rec.id },
            data: { scanStatus: 'CLEAN', scannedAt: new Date() },
        });
        expect(
            await FileRepository.recordScanAttempt(prisma, rec.id, {
                tenantId: TENANT_A,
                attempts: 1,
            }),
        ).toBeNull();
        expect(
            (await prisma.fileRecord.findUniqueOrThrow({ where: { id: rec.id } })).scanAttempts,
        ).toBe(1);
    });

    it('recordScanAttempt cannot be used across tenants', async () => {
        const rec = await FileRepository.createPending(prisma, CTX_A, pendingData());
        await FileRepository.markStored(prisma, CTX_A, rec.id);
        expect(
            await FileRepository.recordScanAttempt(prisma, rec.id, {
                tenantId: TENANT_B,
                attempts: 0,
            }),
        ).toBeNull();
    });

    it('getByPathKey finds a record by its storage path', async () => {
        const data = pendingData();
        const rec = await FileRepository.createPending(prisma, CTX_A, data);
        expect((await FileRepository.getByPathKey(prisma, data.pathKey))?.id).toBe(rec.id);
    });

    // R5-P1 #1 — `isFileOwnedByTenant` was removed. It treated a match on the
    // caller-writable `Evidence.content` as proof of file ownership (the
    // cross-tenant read chain). Ownership now resolves through the tenant-scoped
    // FileRecord directly in `downloadFile` (+ assertTenantKey).

    // ── RLS isolation ────────────────────────────────────────────────

    it('app_user INSERT with own tenantId succeeds; foreign tenantId blocked', async () => {
        const id = await withTenantDb(TENANT_A, async (tx) => {
            const row = await tx.fileRecord.create({
                data: {
                    tenantId: TENANT_A,
                    pathKey: `rls/${randomUUID()}`,
                    originalName: 'rls.txt',
                    mimeType: 'text/plain',
                    sizeBytes: 1,
                    sha256: randomUUID().replace(/-/g, ''),
                    status: 'PENDING',
                    storageProvider: 'local',
                    uploadedByUserId: userId,
                },
            });
            return row.id;
        }, prisma);
        expect(await prisma.fileRecord.findUnique({ where: { id } })).not.toBeNull();

        await expect(
            withTenantDb(TENANT_A, async (tx) => {
                await tx.fileRecord.create({
                    data: {
                        tenantId: TENANT_B, // foreign
                        pathKey: `rls/${randomUUID()}`,
                        originalName: 'rogue.txt',
                        mimeType: 'text/plain',
                        sizeBytes: 1,
                        sha256: randomUUID().replace(/-/g, ''),
                        status: 'PENDING',
                        storageProvider: 'local',
                        uploadedByUserId: userId,
                    },
                });
            }, prisma),
        ).rejects.toThrow(/row-level security|new row violates|insert or update/i);
    });

    it('app_user SELECT only sees own-tenant file records', async () => {
        const a = await FileRepository.createPending(prisma, CTX_A, pendingData());
        const ctxB = makeRequestContext('ADMIN', { tenantId: TENANT_B, userId });
        const b = await FileRepository.createPending(prisma, ctxB, pendingData());

        const visibleToA = await withTenantDb(TENANT_A, async (tx) => {
            return tx.fileRecord.findMany({
                where: { id: { in: [a.id, b.id] } },
                select: { id: true },
            });
        }, prisma);
        const ids = new Set(visibleToA.map((r) => r.id));
        expect(ids.has(a.id)).toBe(true);
        expect(ids.has(b.id)).toBe(false);
    });
});
