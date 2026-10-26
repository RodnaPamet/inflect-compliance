/**
 * Integration coverage: DORA installs through the GENERIC framework-install
 * machinery — no DORA-specific code path.
 *
 * DB-backed (per repo convention — integration tests never mock Prisma).
 * The test seeds a DORA (kind=REGULATION) framework + requirements + control
 * templates + a pack via a plain client, then drives the SAME
 * `previewPackInstall` / `installPack` / `computeCoverage` usecases every
 * other framework uses (through the prisma singleton inside
 * runInTenantContext). If DORA needed special-casing this test would force
 * it to surface; it does not.
 *
 * Framework key/version, template codes and pack key are suite-unique so the
 * suite is parallel-safe (ControlTemplate.code + FrameworkPack.key are global
 * unique columns).
 */
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { previewPackInstall, installPack, computeCoverage } from '@/app-layer/usecases/framework';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE = `dora-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE, userId: `u-${SUITE}` });

// Framework.key is a standalone @unique column shared across the base test
// DB (and with the real seed's 'DORA'); suite-suffix it so the suite is
// parallel-safe and never collides with seeded data.
const FW_KEY = `DORA-${SUITE}`;
const FW_VERSION = `2022/2554-${SUITE}`;
const PACK_KEY = `DORA_BASELINE_${SUITE}`;
// DORA-style codes, suite-suffixed for global uniqueness.
const TEMPLATES = [
    { code: `DORA-6-${SUITE}`, title: 'ICT risk management framework', reqKey: 'DORA.Art.6' },
    { code: `DORA-17-${SUITE}`, title: 'ICT-related incident management process', reqKey: 'DORA.Art.17' },
    { code: `DORA-28-${SUITE}`, title: 'ICT third-party risk strategy', reqKey: 'DORA.Art.28' },
];

let frameworkId: string;

describeFn('DORA framework install (real DB, generic flow)', () => {
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

        // Framework + requirements (kind REGULATION — the DORA shape).
        const fw = await prisma.framework.create({
            data: {
                key: FW_KEY,
                version: FW_VERSION,
                name: 'Digital Operational Resilience Act',
                kind: 'REGULATION',
                description: 'Regulation (EU) 2022/2554',
            },
        });
        frameworkId = fw.id;

        const pack = await prisma.frameworkPack.create({
            data: { key: PACK_KEY, name: 'DORA Baseline Pack', frameworkId: fw.id, version: FW_VERSION },
        });

        for (const t of TEMPLATES) {
            const req = await prisma.frameworkRequirement.create({
                data: { frameworkId: fw.id, code: t.reqKey, title: t.title, section: 'DORA', sortOrder: 1 },
            });
            const tmpl = await prisma.controlTemplate.create({
                data: { code: t.code, title: t.title, category: 'DORA', defaultFrequency: 'QUARTERLY' },
            });
            await prisma.controlTemplateTask.create({
                data: { templateId: tmpl.id, title: 'Implement', description: 'Implement the control.' },
            });
            await prisma.controlTemplateRequirementLink.create({
                data: { templateId: tmpl.id, requirementId: req.id },
            });
            await prisma.packTemplateLink.create({
                data: { packId: pack.id, templateId: tmpl.id },
            });
        }
    });

    afterAll(async () => {
        // Tidy the globally-unique rows this suite created so reruns stay clean.
        const tmpls = await prisma.controlTemplate.findMany({
            where: { code: { in: TEMPLATES.map((t) => t.code) } }, select: { id: true },
        });
        const tids = tmpls.map((t) => t.id);
        if (tids.length) {
            await prisma.packTemplateLink.deleteMany({ where: { templateId: { in: tids } } });
            await prisma.controlTemplateRequirementLink.deleteMany({ where: { templateId: { in: tids } } });
            await prisma.controlTemplateTask.deleteMany({ where: { templateId: { in: tids } } });
            await prisma.controlTemplate.deleteMany({ where: { id: { in: tids } } });
        }
        if (frameworkId) {
            await prisma.controlRequirementLink.deleteMany({ where: { requirement: { frameworkId } } });
            await prisma.control.deleteMany({ where: { tenantId: TENANT } });
            await prisma.frameworkPack.deleteMany({ where: { frameworkId } });
            await prisma.frameworkRequirement.deleteMany({ where: { frameworkId } });
            await prisma.framework.delete({ where: { id: frameworkId } }).catch(() => {});
        }
        await prisma.$disconnect();
    });

    it('preview reports the DORA pack as fully new for a fresh tenant', async () => {
        const preview = await previewPackInstall(ctx, PACK_KEY);
        expect(preview.framework.key).toBe(FW_KEY);
        expect(preview.totalTemplates).toBe(TEMPLATES.length);
        expect(preview.newControls).toBe(TEMPLATES.length);
        expect(preview.existingControls).toBe(0);
    });

    it('installPack creates controls + tasks + requirement links via the generic path', async () => {
        const result = await installPack(ctx, PACK_KEY);
        expect(result.framework).toBe(FW_KEY);
        expect(result.controlsCreated).toBe(TEMPLATES.length);
        expect(result.tasksCreated).toBe(TEMPLATES.length); // one task per template
        expect(result.mappingsCreated).toBe(TEMPLATES.length);

        const controls = await prisma.control.findMany({
            where: { tenantId: TENANT, code: { in: TEMPLATES.map((t) => t.code) } },
            select: { code: true },
        });
        expect(controls.map((c) => c.code).sort()).toEqual(TEMPLATES.map((t) => t.code).sort());
    });

    it('is idempotent — a second install creates no duplicate controls', async () => {
        const result = await installPack(ctx, PACK_KEY);
        expect(result.controlsCreated).toBe(0);

        const count = await prisma.control.count({
            where: { tenantId: TENANT, code: { in: TEMPLATES.map((t) => t.code) } },
        });
        expect(count).toBe(TEMPLATES.length);
    });

    it('computeCoverage reflects the installed DORA controls', async () => {
        const coverage = await computeCoverage(ctx, FW_KEY, FW_VERSION);
        expect(coverage.framework.key).toBe(FW_KEY);
        expect(coverage.total).toBe(TEMPLATES.length);
        expect(coverage.mapped).toBe(TEMPLATES.length);
        expect(coverage.coveragePercent).toBe(100);
    });
});
