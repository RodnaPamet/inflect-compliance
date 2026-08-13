/**
 * Integration coverage for the evidence file-access usecases that had
 * ZERO prior test references:
 *   - getEvidenceFileRecord  (happy path + notFound + DELETED branch)
 *   - downloadEvidenceFile    (STRICT policy: role-aware access, AV-scan
 *                              guard branches, soft-deleted block, local
 *                              stream + provider dispatch, audit log)
 *
 * Files are seeded through the real `uploadEvidenceFile` usecase so the
 * FileRecord + Evidence rows are wired exactly as production creates them.
 */
// STORAGE_PROVIDER defaults to "s3" in env.ts; the file usecases need the
// local provider in tests. Set before the storage singleton is constructed.
process.env.STORAGE_PROVIDER = 'local';
process.env.FILE_STORAGE_ROOT =
    process.env.FILE_STORAGE_ROOT || '/tmp/test-evidence-file-access';

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    uploadEvidenceFile,
    getEvidenceFileRecord,
    downloadEvidenceFile,
} from '@/app-layer/usecases/evidence';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(40_000);

const TAG = `efa-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;

let adminUserId = '';
let CONTROL_ID = '';

async function makeUser(label: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return u.id;
}

function adminCtx() {
    return makeRequestContext('ADMIN', { tenantId: TENANT_ID, userId: adminUserId, tenantSlug: TAG });
}
function readerCtx() {
    return makeRequestContext('READER', { tenantId: TENANT_ID, userId: adminUserId, tenantSlug: TAG });
}

/** Unique-content text file so each upload exercises the create (non-dedup) path. */
const txtFile = (body: string, name = 'doc.txt') =>
    new File([body], name, { type: 'text/plain' });

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    await globalPrisma.tenant.upsert({
        where: { id: TENANT_ID },
        update: {},
        create: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG },
    });
    adminUserId = await makeUser('admin');
    await globalPrisma.tenantMembership.create({
        data: { tenantId: TENANT_ID, userId: adminUserId, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
    });
    const control = await globalPrisma.control.create({
        data: { tenantId: TENANT_ID, name: 'Control for file access' },
    });
    CONTROL_ID = control.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) { await globalPrisma.$disconnect(); return; }
    const tenants = { tenantId: TENANT_ID };
    for (const fn of [
        () => globalPrisma.auditLog.deleteMany({ where: tenants }),
        () => globalPrisma.notification.deleteMany({ where: tenants }),
        () => globalPrisma.controlEvidenceLink.deleteMany({ where: tenants }),
        () => globalPrisma.evidenceReview.deleteMany({ where: tenants }),
        () => globalPrisma.evidence.deleteMany({ where: tenants }),
        () => globalPrisma.fileRecord.deleteMany({ where: tenants }),
        () => globalPrisma.control.deleteMany({ where: tenants }),
        () => globalPrisma.tenantMembership.deleteMany({ where: tenants }),
        () => globalPrisma.user.deleteMany({ where: { id: adminUserId } }),
        () => globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }),
    ]) { try { await fn(); } catch { /* best effort */ } }
    await globalPrisma.$disconnect();
});

describeFn('getEvidenceFileRecord (integration)', () => {
    it('returns the FileRecord for a stored evidence file', async () => {
        const ev = await uploadEvidenceFile(adminCtx(), txtFile(`gefr-${randomUUID()}`), {
            title: 'gefr ok',
        });
        const rec = await getEvidenceFileRecord(adminCtx(), ev.fileRecord.id);
        expect(rec.id).toBe(ev.fileRecord.id);
        expect(rec.status).toBe('STORED');
    });

    it('throws notFound for an unknown file id', async () => {
        await expect(getEvidenceFileRecord(adminCtx(), 'file-does-not-exist')).rejects.toThrow();
    });

    it('throws notFound when the file record is DELETED', async () => {
        const ev = await uploadEvidenceFile(adminCtx(), txtFile(`gefr-del-${randomUUID()}`), {
            title: 'gefr deleted',
        });
        await globalPrisma.fileRecord.update({
            where: { id: ev.fileRecord.id },
            data: { status: 'DELETED' },
        });
        await expect(getEvidenceFileRecord(adminCtx(), ev.fileRecord.id)).rejects.toThrow();
    });

    it('does not return a foreign-tenant file record', async () => {
        const ev = await uploadEvidenceFile(adminCtx(), txtFile(`gefr-tenant-${randomUUID()}`), {
            title: 'gefr tenant',
        });
        const foreignCtx = makeRequestContext('ADMIN', {
            tenantId: 'tenant-other-xyz', userId: adminUserId, tenantSlug: 'other',
        });
        await expect(getEvidenceFileRecord(foreignCtx, ev.fileRecord.id)).rejects.toThrow();
    });
});

describeFn('downloadEvidenceFile (integration)', () => {
    it('ADMIN downloads a stored local file → stream mode + audit row', async () => {
        const ev = await uploadEvidenceFile(adminCtx(), txtFile(`dl-admin-${randomUUID()}`), {
            title: 'dl admin', controlId: CONTROL_ID,
        });
        // Mark the scan CLEAN, exactly as the INFECTED/CLEAN tests below do.
        // `uploadEvidenceFile` leaves scanStatus at its PENDING default, and
        // under AV_SCAN_MODE=strict (the real default, now honoured by the env
        // mock) PENDING is deliberately not servable. This test asserts the
        // happy path — a file that HAS been scanned — so it has to say so.
        await globalPrisma.fileRecord.update({
            where: { id: ev.fileRecord.id }, data: { scanStatus: 'CLEAN' },
        });
        const res = await downloadEvidenceFile(adminCtx(), ev.fileRecord.id);
        expect(res.mode).toBe('stream');
        expect(res.originalName).toBe('doc.txt');
        if (res.mode === 'stream') expect(res.stream).toBeDefined();

        const log = await globalPrisma.auditLog.findFirst({
            where: { tenantId: TENANT_ID, action: 'EVIDENCE_DOWNLOADED', entityId: ev.fileRecord.id },
        });
        expect(log).not.toBeNull();
    });

    it('throws notFound for an unknown file id', async () => {
        await expect(downloadEvidenceFile(adminCtx(), 'nope')).rejects.toThrow();
    });

    it('throws notFound when the file record is not STORED (PENDING/FAILED)', async () => {
        const ev = await uploadEvidenceFile(adminCtx(), txtFile(`dl-pending-${randomUUID()}`), {
            title: 'dl pending',
        });
        await globalPrisma.fileRecord.update({ where: { id: ev.fileRecord.id }, data: { status: 'PENDING' } });
        await expect(downloadEvidenceFile(adminCtx(), ev.fileRecord.id)).rejects.toThrow();
    });

    it('throws forbidden when the file scanStatus is INFECTED', async () => {
        const ev = await uploadEvidenceFile(adminCtx(), txtFile(`dl-inf-${randomUUID()}`), {
            title: 'dl infected', controlId: CONTROL_ID,
        });
        await globalPrisma.fileRecord.update({ where: { id: ev.fileRecord.id }, data: { scanStatus: 'INFECTED' } });
        await expect(downloadEvidenceFile(adminCtx(), ev.fileRecord.id)).rejects.toThrow(
            /infected/i,
        );
    });

    // NOTE: the `evidence?.deletedAt` block inside downloadEvidenceFile is
    // unreachable through the app prisma client — the soft-delete extension
    // injects `deletedAt: null` on findFirst, so a genuinely soft-deleted
    // evidence row is filtered out (returns undefined) before the deletedAt
    // check runs. Documented as uncovered-by-design rather than faked.

    it('READER can download evidence that IS linked to a control', async () => {
        const ev = await uploadEvidenceFile(adminCtx(), txtFile(`dl-reader-ok-${randomUUID()}`), {
            title: 'dl reader ok', controlId: CONTROL_ID,
        });
        await globalPrisma.fileRecord.update({ where: { id: ev.fileRecord.id }, data: { scanStatus: 'CLEAN' } });
        const res = await downloadEvidenceFile(readerCtx(), ev.fileRecord.id);
        expect(res.mode).toBe('stream');
    });

    it('READER is forbidden from downloading evidence NOT linked to a control', async () => {
        const ev = await uploadEvidenceFile(adminCtx(), txtFile(`dl-reader-block-${randomUUID()}`), {
            title: 'dl reader block', // no controlId
        });
        await globalPrisma.fileRecord.update({ where: { id: ev.fileRecord.id }, data: { scanStatus: 'CLEAN' } });
        await expect(downloadEvidenceFile(readerCtx(), ev.fileRecord.id)).rejects.toThrow(
            /linked to a control/i,
        );
    });
});
