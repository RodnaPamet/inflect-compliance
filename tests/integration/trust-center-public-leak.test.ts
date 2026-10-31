/**
 * Integration coverage: the Trust Center public read leaks NOTHING beyond the
 * curated fields — the load-bearing security property of this feature.
 *
 * DB-backed (per repo convention). We deliberately seed REAL tenant data
 * (risks, a control) alongside the trust center, enable it, then fetch the
 * PUBLIC projection and assert it contains ONLY the curated allowlist — no
 * tenantId, no risk/control/evidence content, nothing the tenant didn't
 * explicitly publish. Plus: off-by-default, disabled→null (404), and
 * sanitisation of a hostile displayName.
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { getPublicTrustCenter } from '@/lib/trust-center/public';
import { upsertTrustCenter, setTrustCenterEnabled, getTrustCenter } from '@/app-layer/usecases/trust-center';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `tc-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const SLUG = SUITE; // trust slug defaults to the tenant slug
const SECRET_RISK_TITLE = `SECRET-RISK-${SUITE}`;
// OWNER ctx so the publish (admin.tenant_lifecycle) path is allowed.
const ctx = makeRequestContext('OWNER', { tenantId: TENANT, tenantSlug: SLUG, userId: `u-${SUITE}` });

describeFn('Trust Center public read — leak-proof (real DB)', () => {
    beforeAll(async () => {
        await prisma.$connect();
        await prisma.tenant.upsert({ where: { id: TENANT }, update: {}, create: { id: TENANT, name: SUITE, slug: SLUG } });
        const email = `${SUITE}@example.test`;
        await prisma.user.upsert({ where: { id: ctx.userId }, update: {}, create: { id: ctx.userId, email, emailHash: hashForLookup(email) } });
        // REAL sensitive tenant data that must NEVER appear on the public page.
        await prisma.risk.create({ data: { tenantId: TENANT, title: SECRET_RISK_TITLE, description: 'confidential', status: 'OPEN' } });
        await prisma.control.create({ data: { tenantId: TENANT, code: `CTRL-${SUITE}`, name: `SECRET-CONTROL-${SUITE}` } });
    });

    afterAll(async () => {
        await prisma.trustCenter.deleteMany({ where: { tenantId: TENANT } });
        await prisma.$disconnect();
    });

    it('is OFF by default — no public page before publish', async () => {
        await upsertTrustCenter(ctx, {
            displayName: 'Acme Inc.',
            tagline: 'Security at Acme',
            postureSummary: 'We run a mature security program.',
            securityContact: 'security@acme.test',
            publishedFrameworks: [{ key: 'SOC 2', statusLabel: 'Type II — current' }],
            publishedDocuments: [{ label: 'Whitepaper', url: 'https://acme.test/security.pdf' }],
        });
        // Composed but not enabled → public read returns null (404).
        expect(await getPublicTrustCenter(SLUG)).toBeNull();
    });

    it('after publish, exposes ONLY the curated allowlist — no tenant data leaks', async () => {
        await setTrustCenterEnabled(ctx, true);
        const pub = await getPublicTrustCenter(SLUG);
        expect(pub).not.toBeNull();

        // Exact allowlist of keys — a new field can't sneak through.
        expect(Object.keys(pub!).sort()).toEqual(
            ['displayName', 'indexable', 'postureSummary', 'publishedDocuments', 'publishedFrameworks', 'securityContact', 'slug', 'tagline', 'updatedAt'].sort(),
        );
        // No internal identifiers.
        expect((pub as unknown as Record<string, unknown>).tenantId).toBeUndefined();
        expect((pub as unknown as Record<string, unknown>).id).toBeUndefined();
        expect((pub as unknown as Record<string, unknown>).publishedByUserId).toBeUndefined();

        // The serialized public payload contains NONE of the real tenant data.
        const blob = JSON.stringify(pub);
        expect(blob).not.toContain(SECRET_RISK_TITLE);
        expect(blob).not.toContain('SECRET-CONTROL');
        expect(blob).not.toContain(TENANT);

        // It DOES contain exactly what the tenant curated.
        expect(pub!.displayName).toBe('Acme Inc.');
        expect(pub!.publishedFrameworks[0].key).toBe('SOC 2');
    });

    it('unpublish withdraws the page (→ null / 404)', async () => {
        await setTrustCenterEnabled(ctx, false);
        expect(await getPublicTrustCenter(SLUG)).toBeNull();
    });

    it('sanitises a hostile displayName, and refuses a javascript: document URL rather than store it', async () => {
        // #4824: the bad row is refused by name, not dropped behind a "saved",
        // and nothing of the refused save is written.
        await expect(
            upsertTrustCenter(ctx, {
                displayName: 'Acme',
                publishedDocuments: [
                    { label: 'Bad', url: 'javascript:alert(1)' },
                    { label: 'Good', url: 'https://acme.test/ok.pdf' },
                ],
            }),
        ).rejects.toThrow(/"Bad" must be a full web address/);
        expect(JSON.stringify((await getTrustCenter(ctx))!.publishedDocuments)).not.toContain('javascript:');

        await upsertTrustCenter(ctx, {
            displayName: 'Acme <script>alert(1)</script>',
            publishedDocuments: [{ label: 'Good', url: 'https://acme.test/ok.pdf' }],
        });
        const row = await getTrustCenter(ctx);
        expect(row!.displayName).not.toContain('<script');
        const docs = row!.publishedDocuments as Array<{ label: string; url: string }>;
        expect(docs).toHaveLength(1);
        expect(docs[0].url).toMatch(/^https:\/\//);
    });
});
