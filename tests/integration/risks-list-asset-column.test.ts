/**
 * B1-3 — the Risks list's Asset column carries real data.
 *
 * WHY THIS EXISTS: the column shipped rendered, sortable and toggleable,
 * while `riskListSelect` selected no asset at all. Every row showed "—" and
 * sorting by it was a no-op. That is worse than having no column: an empty
 * Asset column reads as "no risk in this tenant is linked to an asset",
 * which is a false claim about the tenant's data rather than a missing
 * feature.
 *
 * Nothing caught it because every layer was individually coherent — the
 * column def existed, the sort accessor existed, the i18n key existed, the
 * type declared `asset: { name } | null`. Only reading a row back from the
 * repository shows the field was never populated. (It could not have been:
 * `Risk` has no singular asset relation. The real one is the many-to-many
 * `AssetRiskLink`.)
 *
 * These tests assert the SHAPE the list page consumes, so a future select
 * that drops the join fails here rather than in front of a user.
 */
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { listRisks } from '@/app-layer/usecases/risk';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

jest.setTimeout(60_000);

const SUITE = `rasset-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE}`;
let userId = '';

type Row = {
    id: string;
    title: string;
    assetLinks?: Array<{ asset: { id: string; name: string } }>;
    _count?: { assetLinks: number };
};

async function seedRisk(title: string) {
    const r = await globalPrisma.risk.create({
        data: { tenantId: TENANT_ID, title, likelihood: 3, impact: 3, score: 9 },
    });
    return r.id;
}

async function seedAsset(name: string) {
    const a = await globalPrisma.asset.create({
        data: { tenantId: TENANT_ID, name, type: 'APPLICATION' },
    });
    return a.id;
}

async function link(assetId: string, riskId: string) {
    await globalPrisma.assetRiskLink.create({
        data: { tenantId: TENANT_ID, assetId, riskId },
    });
}

const ctx = () => makeRequestContext('ADMIN', { userId, tenantId: TENANT_ID });

/** listRisks' return type follows the Prisma row shape. */
const rows = async (): Promise<Row[]> =>
    (await listRisks(ctx())) as unknown as Row[];

describeFn('risks list — the Asset column has data (B1-3)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE}`, slug: SUITE },
        });
        const email = `${SUITE}@example.test`;
        const u = await globalPrisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        userId = u.id;
    });

    afterEach(async () => {
        await globalPrisma.assetRiskLink.deleteMany({ where: { tenantId: TENANT_ID } }).catch(() => {});
        await globalPrisma.risk.deleteMany({ where: { tenantId: TENANT_ID } }).catch(() => {});
        await globalPrisma.asset.deleteMany({ where: { tenantId: TENANT_ID } }).catch(() => {});
    });

    afterAll(async () => {
        await globalPrisma.auditLog.deleteMany({ where: { tenantId: TENANT_ID } }).catch(() => {});
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } }).catch(() => {});
        await globalPrisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
        await globalPrisma.$disconnect().catch(() => {});
    });

    it('surfaces the linked asset — the regression that made every row "—"', async () => {
        const riskId = await seedRisk('Linked risk');
        await link(await seedAsset('Payroll DB'), riskId);

        const [row] = await rows();

        expect(row.assetLinks?.[0]?.asset?.name).toBe('Payroll DB');
        expect(row._count?.assetLinks).toBe(1);
    });

    it('reports the true total while fetching only one link', async () => {
        const riskId = await seedRisk('Multi-linked risk');
        for (const name of ['Alpha', 'Bravo', 'Charlie']) {
            await link(await seedAsset(name), riskId);
        }

        const [row] = await rows();

        // Bounded: a risk wired to many assets must not fan the list query
        // out. One row comes back…
        expect(row.assetLinks).toHaveLength(1);
        // …but the count is honest, so the cell can render "Alpha +2"
        // rather than naming one asset as though it were the only one.
        expect(row._count?.assetLinks).toBe(3);
    });

    it('leaves an unlinked risk empty rather than inventing a link', async () => {
        await seedRisk('Unlinked risk');

        const [row] = await rows();

        expect(row.assetLinks ?? []).toHaveLength(0);
        expect(row._count?.assetLinks).toBe(0);
    });

    it('does not surface another tenant’s asset link', async () => {
        const otherTenant = `t-other-${SUITE}`;
        await globalPrisma.tenant.create({
            data: { id: otherTenant, name: 'other', slug: `other-${SUITE}` },
        });
        const riskId = await seedRisk('Ours');
        const foreignAsset = await globalPrisma.asset.create({
            data: { tenantId: otherTenant, name: 'Their asset', type: 'APPLICATION' },
        });
        // A link row carrying the OTHER tenant's id, pointing at our risk.
        await globalPrisma.assetRiskLink.create({
            data: { tenantId: otherTenant, assetId: foreignAsset.id, riskId },
        });

        const [row] = await rows();

        expect(row.assetLinks ?? []).toHaveLength(0);
        expect(row._count?.assetLinks).toBe(0);

        await globalPrisma.assetRiskLink.deleteMany({ where: { tenantId: otherTenant } }).catch(() => {});
        await globalPrisma.asset.deleteMany({ where: { tenantId: otherTenant } }).catch(() => {});
        await globalPrisma.tenant.deleteMany({ where: { id: otherTenant } }).catch(() => {});
    });
});
