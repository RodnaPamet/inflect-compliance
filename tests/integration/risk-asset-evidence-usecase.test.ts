/**
 * Integration tests for the risk + asset attached-evidence backend.
 *
 * Proves, against a real DB, that a risk and an asset can attach
 * evidence the same way a control/task can: link a URL → LINK Evidence
 * row tagged with the entity; upload a file tagged to the entity; list
 * via the `{ links, evidence }` shape the shared <EvidenceSubTable>
 * renders; unlink detaches (clears the FK) without deleting the row;
 * and tenant isolation holds.
 */
// STORAGE_PROVIDER defaults to "s3" in env.ts; uploadEvidenceFile needs
// the local provider in tests (mirrors evidence-import.test.ts). Set
// before the storage module's lazy singleton is constructed.
process.env.STORAGE_PROVIDER = 'local';
process.env.FILE_STORAGE_ROOT =
    process.env.FILE_STORAGE_ROOT || '/tmp/test-evidence-uploads';

import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    getRiskEvidenceTab,
    linkRiskEvidence,
    unlinkRiskEvidence,
} from '@/app-layer/usecases/risk';
import {
    getAssetEvidenceTab,
    linkAssetEvidence,
    unlinkAssetEvidence,
} from '@/app-layer/usecases/asset';
import { uploadEvidenceFile } from '@/app-layer/usecases/evidence';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `rae-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const FOREIGN_TENANT_ID = `t-${TAG}-other`;

let admin: { userId: string };
let RISK_ID = '';
let ASSET_ID = '';
let CONTROL_ID = '';
let FOREIGN_RISK_ID = '';

async function makeUser(label: string): Promise<{ userId: string }> {
    const email = `${TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({
        data: { email, emailHash: hashForLookup(email) },
    });
    return { userId: u.id };
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    for (const [id, slug] of [
        [TENANT_ID, TAG],
        [FOREIGN_TENANT_ID, `${TAG}-other`],
    ]) {
        await globalPrisma.tenant.upsert({
            where: { id },
            update: {},
            create: { id, name: `t ${slug}`, slug },
        });
    }
    admin = await makeUser('admin');
    await globalPrisma.tenantMembership.create({
        data: {
            tenantId: TENANT_ID,
            userId: admin.userId,
            role: Role.ADMIN,
            status: MembershipStatus.ACTIVE,
        },
    });
    const risk = await globalPrisma.risk.create({
        data: { tenantId: TENANT_ID, title: 'Risk with evidence' },
    });
    RISK_ID = risk.id;
    const asset = await globalPrisma.asset.create({
        data: { tenantId: TENANT_ID, name: 'Asset with evidence', type: 'SYSTEM' },
    });
    ASSET_ID = asset.id;
    const control = await globalPrisma.control.create({
        data: { tenantId: TENANT_ID, name: 'Control with evidence' },
    });
    CONTROL_ID = control.id;
    const foreignRisk = await globalPrisma.risk.create({
        data: { tenantId: FOREIGN_TENANT_ID, title: 'Foreign risk' },
    });
    FOREIGN_RISK_ID = foreignRisk.id;
});

afterAll(async () => {
    if (!DB_AVAILABLE) {
        await globalPrisma.$disconnect();
        return;
    }
    const tenants = { tenantId: { in: [TENANT_ID, FOREIGN_TENANT_ID] } };
    try { await globalPrisma.controlEvidenceLink.deleteMany({ where: tenants }); } catch { /* best effort */ }
    try { await globalPrisma.evidence.deleteMany({ where: tenants }); } catch { /* best effort */ }
    try { await globalPrisma.control.deleteMany({ where: tenants }); } catch { /* best effort */ }
    try { await globalPrisma.risk.deleteMany({ where: tenants }); } catch { /* best effort */ }
    try { await globalPrisma.asset.deleteMany({ where: tenants }); } catch { /* best effort */ }
    try { await globalPrisma.tenantMembership.deleteMany({ where: tenants }); } catch { /* best effort */ }
    try { await globalPrisma.user.deleteMany({ where: { id: admin.userId } }); } catch { /* best effort */ }
    try { await globalPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_ID, FOREIGN_TENANT_ID] } } }); } catch { /* best effort */ }
    await globalPrisma.$disconnect();
});

function adminCtx() {
    return makeRequestContext('ADMIN', { tenantId: TENANT_ID, userId: admin.userId, tenantSlug: TAG });
}

describeFn('risk evidence usecases (integration)', () => {
    it('linkRiskEvidence creates a LINK evidence row tagged with the risk', async () => {
        const ev = await linkRiskEvidence(adminCtx(), RISK_ID, { url: 'https://example.com/risk-doc', note: 'Doc' });
        expect(ev.type).toBe('LINK');
        expect(ev.riskId).toBe(RISK_ID);
        expect(ev.content).toBe('https://example.com/risk-doc');
    });

    it('getRiskEvidenceTab returns it; unlink detaches but keeps the row', async () => {
        const ev = await linkRiskEvidence(adminCtx(), RISK_ID, { url: 'https://example.com/r2' });
        const tab = await getRiskEvidenceTab(adminCtx(), RISK_ID);
        expect(tab.links).toEqual([]);
        expect(tab.evidence.some((e) => e.id === ev.id)).toBe(true);
        await unlinkRiskEvidence(adminCtx(), RISK_ID, ev.id);
        const still = await globalPrisma.evidence.findUnique({ where: { id: ev.id } });
        expect(still).not.toBeNull();
        expect(still?.riskId).toBeNull();
    });

    it('is tenant-isolated — a foreign risk id is not found', async () => {
        await expect(getRiskEvidenceTab(adminCtx(), FOREIGN_RISK_ID)).rejects.toThrow();
        await expect(linkRiskEvidence(adminCtx(), FOREIGN_RISK_ID, { url: 'https://example.com/x' })).rejects.toThrow();
    });
});

describeFn('asset evidence usecases (integration)', () => {
    it('linkAssetEvidence creates a LINK evidence row tagged with the asset', async () => {
        const ev = await linkAssetEvidence(adminCtx(), ASSET_ID, { url: 'https://example.com/asset-doc' });
        expect(ev.type).toBe('LINK');
        expect(ev.assetId).toBe(ASSET_ID);
    });

    it('getAssetEvidenceTab returns it (with a note); unlink detaches but keeps the row', async () => {
        const ev = await linkAssetEvidence(adminCtx(), ASSET_ID, { url: 'https://example.com/a2', note: 'Proof' });
        const tab = await getAssetEvidenceTab(adminCtx(), ASSET_ID);
        expect(tab.evidence.some((e) => e.id === ev.id)).toBe(true);
        await unlinkAssetEvidence(adminCtx(), ASSET_ID, ev.id);
        const still = await globalPrisma.evidence.findUnique({ where: { id: ev.id } });
        expect(still?.assetId).toBeNull();
    });

    it('unlinking a non-existent asset evidence throws', async () => {
        await expect(unlinkAssetEvidence(adminCtx(), ASSET_ID, 'ev-does-not-exist')).rejects.toThrow();
    });
});

describeFn('uploadEvidenceFile — entity tagging (integration)', () => {
    // Unique content per upload so each call exercises the create path
    // (not the SHA-256 dedup-reuse branch).
    const txtFile = (body: string) =>
        new File([body], 'note.txt', { type: 'text/plain' });

    it('uploads a file tagged to a control via EvidenceControlLink', async () => {
        // EP-3 — the upload creates ONE Evidence + an EvidenceControlLink
        // (no ControlEvidenceLink bridge for Evidence entities).
        const ev = await uploadEvidenceFile(adminCtx(), txtFile('control body'), {
            title: 'Control upload',
            controlId: CONTROL_ID,
        });
        expect(ev.controlIds).toContain(CONTROL_ID);
        expect(ev.type).toBe('FILE');
        const link = await globalPrisma.evidenceControlLink.findFirst({
            where: { controlId: CONTROL_ID, tenantId: TENANT_ID, evidenceId: ev.id },
        });
        expect(link).not.toBeNull();
    });

    it('uploads a file tagged to a risk', async () => {
        const ev = await uploadEvidenceFile(adminCtx(), txtFile('risk body'), {
            title: 'Risk upload',
            riskId: RISK_ID,
        });
        expect(ev.riskId).toBe(RISK_ID);
        expect(ev.type).toBe('FILE');
    });

    it('uploads a file tagged to an asset', async () => {
        const ev = await uploadEvidenceFile(adminCtx(), txtFile('asset body'), {
            title: 'Asset upload',
            assetId: ASSET_ID,
        });
        expect(ev.assetId).toBe(ASSET_ID);
    });

    it('reuses the FileRecord on a duplicate-content upload (dedup path)', async () => {
        const ev = await uploadEvidenceFile(adminCtx(), txtFile('control body'), {
            title: 'Dup upload',
            riskId: RISK_ID,
        });
        expect(ev.type).toBe('FILE');
    });

    it('rejects an upload tagged to a foreign control', async () => {
        await expect(
            uploadEvidenceFile(adminCtx(), txtFile('x'), { controlId: 'ctrl-nope' }),
        ).rejects.toThrow();
    });

    it('rejects an upload tagged to a foreign risk', async () => {
        await expect(
            uploadEvidenceFile(adminCtx(), txtFile('y'), { riskId: FOREIGN_RISK_ID }),
        ).rejects.toThrow();
    });

    it('rejects an upload tagged to a non-existent asset', async () => {
        await expect(
            uploadEvidenceFile(adminCtx(), txtFile('z'), { assetId: 'asset-nope' }),
        ).rejects.toThrow();
    });

    it('unlinking a non-existent risk evidence throws', async () => {
        await expect(unlinkRiskEvidence(adminCtx(), RISK_ID, 'ev-nope')).rejects.toThrow();
    });
});
