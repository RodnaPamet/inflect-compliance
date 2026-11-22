/**
 * `linkEvidence` / `unlinkEvidence` (usecases/control/evidence.ts) against a
 * real database (#5376).
 *
 * The permission floor, the cross-control unlink and the cross-tenant ids had
 * no behavioural test. These prove:
 *
 *   • a READER, and a custom role over EDITOR that withholds `controls.edit`,
 *     cannot link or unlink, and nothing is written or deleted;
 *   • an unlink naming a link that belongs to ANOTHER control (same tenant)
 *     or to another tenant's control is a 404 and the link survives;
 *   • a FileRecord or a control of another tenant is refused on every link
 *     kind, with no row written;
 *   • a successful link and unlink each write their audit row.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { linkEvidence, unlinkEvidence } from '@/app-layer/usecases/control';
import { parsePermissionsJson } from '@/lib/permissions';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `cel-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const FOREIGN_TENANT_ID = `t-${TAG}-other`;

let admin = '';
let reader = '';
let CONTROL_ID = '';
let OTHER_CONTROL_ID = '';
let FOREIGN_CONTROL_ID = '';
let FOREIGN_FILE_ID = '';

async function makeUser(label: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    return u.id;
}

const ctx = (role: Role = Role.ADMIN, userId = admin) =>
    makeRequestContext(role, { tenantId: TENANT_ID, userId, tenantSlug: TAG });

/** A link row written straight to the table, so unlink tests do not lean on linkEvidence. */
async function seedLink(tenantId: string, controlId: string) {
    return globalPrisma.controlEvidenceLink.create({
        data: { tenantId, controlId, kind: 'INTEGRATION_RESULT', note: `${TAG} seeded`, createdByUserId: admin },
    });
}

async function auditCount(action: string, entityId: string) {
    return globalPrisma.auditLog.count({ where: { tenantId: TENANT_ID, entity: 'Control', entityId, action } });
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    for (const [id, slug] of [[TENANT_ID, TAG], [FOREIGN_TENANT_ID, `${TAG}-other`]]) {
        await globalPrisma.tenant.create({ data: { id, name: `t ${slug}`, slug } });
    }
    admin = await makeUser('admin');
    reader = await makeUser('reader');
    await globalPrisma.tenantMembership.createMany({
        data: [
            { tenantId: TENANT_ID, userId: admin, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
            { tenantId: TENANT_ID, userId: reader, role: Role.READER, status: MembershipStatus.ACTIVE },
            { tenantId: FOREIGN_TENANT_ID, userId: admin, role: Role.ADMIN, status: MembershipStatus.ACTIVE },
        ],
    });
    CONTROL_ID = (await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: `${TAG} control` } })).id;
    OTHER_CONTROL_ID = (await globalPrisma.control.create({ data: { tenantId: TENANT_ID, name: `${TAG} other` } })).id;
    FOREIGN_CONTROL_ID = (await globalPrisma.control.create({ data: { tenantId: FOREIGN_TENANT_ID, name: `${TAG} foreign` } })).id;
    FOREIGN_FILE_ID = (await globalPrisma.fileRecord.create({
        data: {
            tenantId: FOREIGN_TENANT_ID,
            pathKey: `${TAG}/foreign.pdf`,
            originalName: 'foreign.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            sha256: 'a'.repeat(64),
            status: 'STORED',
            scanStatus: 'CLEAN',
            uploadedByUserId: admin,
        },
    })).id;
});

afterAll(async () => {
    if (DB_AVAILABLE) {
        const tenants = { tenantId: { in: [TENANT_ID, FOREIGN_TENANT_ID] } };
        try { await globalPrisma.evidenceControlLink.deleteMany({ where: tenants }); } catch { /* best effort */ }
        try { await globalPrisma.evidence.deleteMany({ where: tenants }); } catch { /* best effort */ }
        try { await globalPrisma.controlEvidenceLink.deleteMany({ where: tenants }); } catch { /* best effort */ }
        try { await globalPrisma.fileRecord.deleteMany({ where: tenants }); } catch { /* best effort */ }
        try { await globalPrisma.control.deleteMany({ where: tenants }); } catch { /* best effort */ }
        try { await globalPrisma.tenantMembership.deleteMany({ where: tenants }); } catch { /* best effort */ }
    }
    await globalPrisma.$disconnect();
});

describeFn('linkEvidence / unlinkEvidence (integration)', () => {
    describe('permission floor', () => {
        const denied = () => [
            ['READER', ctx(Role.READER, reader)],
            ['custom role over EDITOR without controls.edit', makeRequestContext(Role.EDITOR, {
                tenantId: TENANT_ID, userId: admin, tenantSlug: TAG,
                appPermissions: parsePermissionsJson({ controls: { edit: false } }, Role.EDITOR),
            })],
        ] as const;

        it('refuses linkEvidence on every kind and writes nothing', async () => {
            for (const [label, c] of denied()) {
                for (const data of [
                    { kind: 'LINK', url: `https://example.com/${label}` },
                    { kind: 'INTEGRATION_RESULT', note: label },
                ]) {
                    await expect(linkEvidence(c, CONTROL_ID, data)).rejects.toMatchObject({ status: 403 });
                }
            }
            expect(await globalPrisma.evidenceControlLink.count({ where: { controlId: CONTROL_ID } })).toBe(0);
            expect(await globalPrisma.controlEvidenceLink.count({ where: { controlId: CONTROL_ID } })).toBe(0);
        });

        it('refuses unlinkEvidence and the link survives', async () => {
            const link = await seedLink(TENANT_ID, CONTROL_ID);
            for (const [, c] of denied()) {
                await expect(unlinkEvidence(c, CONTROL_ID, link.id)).rejects.toMatchObject({ status: 403 });
            }
            expect(await globalPrisma.controlEvidenceLink.findUnique({ where: { id: link.id } })).not.toBeNull();
            await globalPrisma.controlEvidenceLink.delete({ where: { id: link.id } });
        });
    });

    describe('unlink scope', () => {
        it('a link id that belongs to another control is a 404 and nothing is deleted', async () => {
            const link = await seedLink(TENANT_ID, OTHER_CONTROL_ID);
            await expect(unlinkEvidence(ctx(), CONTROL_ID, link.id)).rejects.toMatchObject({ status: 404 });
            expect(await globalPrisma.controlEvidenceLink.findUnique({ where: { id: link.id } })).not.toBeNull();
            expect(await auditCount('CONTROL_EVIDENCE_UNLINKED', CONTROL_ID)).toBe(0);
            await globalPrisma.controlEvidenceLink.delete({ where: { id: link.id } });
        });

        it("a link id on another tenant's control is a 404 and nothing is deleted", async () => {
            const link = await seedLink(FOREIGN_TENANT_ID, FOREIGN_CONTROL_ID);
            await expect(unlinkEvidence(ctx(), FOREIGN_CONTROL_ID, link.id)).rejects.toMatchObject({ status: 404 });
            await expect(unlinkEvidence(ctx(), CONTROL_ID, link.id)).rejects.toMatchObject({ status: 404 });
            expect(await globalPrisma.controlEvidenceLink.findUnique({ where: { id: link.id } })).not.toBeNull();
            await globalPrisma.controlEvidenceLink.delete({ where: { id: link.id } });
        });

        it('a successful unlink deletes the link and writes one CONTROL_EVIDENCE_UNLINKED row', async () => {
            const link = await seedLink(TENANT_ID, CONTROL_ID);
            const before = await auditCount('CONTROL_EVIDENCE_UNLINKED', CONTROL_ID);
            await expect(unlinkEvidence(ctx(), CONTROL_ID, link.id)).resolves.toEqual({ success: true });
            expect(await globalPrisma.controlEvidenceLink.findUnique({ where: { id: link.id } })).toBeNull();
            expect(await auditCount('CONTROL_EVIDENCE_UNLINKED', CONTROL_ID)).toBe(before + 1);
        });
    });

    describe('cross-tenant ids on link', () => {
        it("a FILE naming another tenant's FileRecord is refused and creates no evidence", async () => {
            await expect(linkEvidence(ctx(), CONTROL_ID, { kind: 'FILE', fileId: FOREIGN_FILE_ID }))
                .rejects.toMatchObject({ status: 404 });
            expect(await globalPrisma.evidence.count({ where: { fileRecordId: FOREIGN_FILE_ID } })).toBe(0);
            expect(await globalPrisma.evidenceControlLink.count({ where: { controlId: CONTROL_ID } })).toBe(0);
        });

        it("an INTEGRATION_RESULT naming another tenant's FileRecord is refused and writes no link", async () => {
            await expect(linkEvidence(ctx(), CONTROL_ID, { kind: 'INTEGRATION_RESULT', fileId: FOREIGN_FILE_ID }))
                .rejects.toMatchObject({ status: 404 });
            expect(await globalPrisma.controlEvidenceLink.count({ where: { fileId: FOREIGN_FILE_ID } })).toBe(0);
        });

        it("linking onto another tenant's control is a 404 on every kind and writes nothing", async () => {
            for (const data of [
                { kind: 'LINK', url: 'https://example.com/foreign' },
                { kind: 'FILE', fileId: FOREIGN_FILE_ID },
                { kind: 'INTEGRATION_RESULT', note: 'foreign' },
            ]) {
                await expect(linkEvidence(ctx(), FOREIGN_CONTROL_ID, data)).rejects.toMatchObject({ status: 404 });
            }
            expect(await globalPrisma.controlEvidenceLink.count({ where: { controlId: FOREIGN_CONTROL_ID } })).toBe(0);
            expect(await globalPrisma.evidenceControlLink.count({ where: { controlId: FOREIGN_CONTROL_ID } })).toBe(0);
        });
    });

    describe('audit', () => {
        it('a LINK writes one CONTROL_EVIDENCE_LINKED row naming the new record', async () => {
            const before = await auditCount('CONTROL_EVIDENCE_LINKED', CONTROL_ID);
            const ev = await linkEvidence(ctx(), CONTROL_ID, { kind: 'LINK', url: 'https://example.com/audit' });
            const rows = await globalPrisma.auditLog.findMany({
                where: { tenantId: TENANT_ID, entityId: CONTROL_ID, action: 'CONTROL_EVIDENCE_LINKED' },
                select: { detailsJson: true, userId: true },
            });
            expect(rows).toHaveLength(before + 1);
            expect(rows.some((r) => (r.detailsJson as { targetId?: string } | null)?.targetId === ev.id)).toBe(true);
            expect(rows.every((r) => r.userId === admin)).toBe(true);
        });

        it('an INTEGRATION_RESULT writes one CONTROL_EVIDENCE_LINKED row', async () => {
            const before = await auditCount('CONTROL_EVIDENCE_LINKED', CONTROL_ID);
            await linkEvidence(ctx(), CONTROL_ID, { kind: 'INTEGRATION_RESULT', note: 'scan result' });
            expect(await auditCount('CONTROL_EVIDENCE_LINKED', CONTROL_ID)).toBe(before + 1);
        });
    });
});
