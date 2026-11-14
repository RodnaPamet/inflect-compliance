/**
 * A requirement that leaves a catalogue's scope leaves it in a database that
 * already installed the catalogue (#5316 item 7, owner decision 2026-11-14).
 *
 * ═══ WHY ═══
 *
 * #5644 corrected ASVS V2.6.1 and V11.1.6 from L1 to L2 and dropped both from
 * the L1 catalogue (`prisma/fixtures/asvs-l1-control-templates.json`). The
 * applier only ever adds rows and links, so a database that applied the L1
 * catalogue before #5644 kept both rows categorised L1 and linked to the
 * ASVS-V2 / ASVS-V11 templates, and every later pack install still reached
 * them. The file's `outOfScopeRequirements` entries are how it now says so:
 * the next apply (every container start) re-categorises the rows and removes
 * exactly those template links — and touches no tenant's control, link or task.
 *
 * The suite runs the REAL fixture through the REAL loader and applier, with
 * the framework, template and pack keys made suite-unique so it shares no
 * global row with any other suite. The pre-#5644 shape is rebuilt from the
 * current file by putting the two requirements back as #5644 found them.
 */
import path from 'node:path';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { installPack } from '@/app-layer/usecases/framework';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { REPO_ROOT } from '../helpers/repo-files';
import { type CatalogFile, loadAndValidateCatalogFile } from '../../prisma/catalog-loader';
import { applyCatalogFile } from '../../prisma/catalog-applier';

const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const FIXTURE = path.join(REPO_ROOT, 'prisma/fixtures/asvs-l1-control-templates.json');
const CURRENT = loadAndValidateCatalogFile(FIXTURE);

const SUITE = `oos-${randomUUID().slice(0, 8)}`;
const TENANT = `t-${SUITE}`;
const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: SUITE, userId: `u-${SUITE}` });

/** The two rows exactly as the pre-#5644 L1 catalogue declared them. */
const PRE_5644_ROWS = [
    {
        template: 'ASVS-V2',
        requirement: {
            code: 'V2.6.1',
            title: 'One-Time Lookup Secrets',
            summary: 'Ensure lookup or backup codes can each be used only once.',
            category: 'L1',
            section: 'Authentication',
            sortOrder: 23,
        },
    },
    {
        template: 'ASVS-V11',
        requirement: {
            code: 'V11.1.6',
            title: 'Prevent Logic Race Conditions',
            summary: 'Protect high-value operations from race conditions that could bypass business rules.',
            category: 'L1',
            section: 'Business Logic',
            sortOrder: 94,
        },
    },
] as const;
const MOVED = PRE_5644_ROWS.map((r) => r.requirement.code);

/** Make every global key suite-unique, so no other suite's rows are shared. */
function scoped(file: CatalogFile, suite: string): CatalogFile {
    const t = (code: string) => `${code}-${suite}`;
    return {
        ...file,
        framework: { ...file.framework, key: `OWASP-ASVS-${suite}` },
        templates: file.templates.map((tm) => ({ ...tm, code: t(tm.code) })),
        outOfScopeRequirements: file.outOfScopeRequirements.map((o) => ({
            ...o,
            unlinkTemplateCodes: o.unlinkTemplateCodes.map(t),
        })),
        pack: file.pack && {
            ...file.pack,
            key: `${file.pack.key}_${suite}`,
            templateCodes: file.pack.templateCodes?.map(t),
        },
    };
}

/** The L1 catalogue as a database that installed it before #5644 holds it. */
function pre5644(file: CatalogFile): CatalogFile {
    return {
        ...file,
        requirements: [...file.requirements, ...PRE_5644_ROWS.map((r) => r.requirement)],
        templates: file.templates.map((tm) => {
            const back = PRE_5644_ROWS.filter((r) => r.template === tm.code).map((r) => r.requirement.code);
            return back.length ? { ...tm, requirementCodes: [...tm.requirementCodes, ...back] } : tm;
        }),
        outOfScopeRequirements: [],
    };
}

const PRE = scoped(pre5644(CURRENT), SUITE);
const NOW = scoped(CURRENT, SUITE);
const FW_KEY = NOW.framework.key;
const PACK_KEY = NOW.pack!.key;
const tcode = (code: string) => `${code}-${SUITE}`;

/** A template no entry names, linked to V2.6.1 by some other writer. */
const OTHER_TEMPLATE = `OTHER-${SUITE}`;
/** A second database's catalogue: a fresh install, never pre-#5644. */
const FRESH_SUITE = `${SUITE}-fresh`;
const FRESH = scoped(CURRENT, FRESH_SUITE);

let frameworkId: string;

async function movedRows() {
    return prisma.frameworkRequirement.findMany({
        where: { framework: { key: FW_KEY }, code: { in: MOVED } },
        select: {
            code: true,
            category: true,
            templateLinks: { select: { template: { select: { code: true } } } },
        },
        orderBy: { code: 'asc' },
    });
}

/** Everything the tenant owns that hangs off the catalogue, as plain data. */
async function tenantSnapshot() {
    const controls = await prisma.control.findMany({
        where: { tenantId: TENANT },
        select: { id: true, code: true, name: true, status: true, updatedAt: true },
        orderBy: { id: 'asc' },
    });
    const links = await prisma.controlRequirementLink.findMany({
        where: { tenantId: TENANT },
        select: { id: true, controlId: true, requirementId: true },
        orderBy: { id: 'asc' },
    });
    const tasks = await prisma.task.findMany({
        where: { tenantId: TENANT },
        select: { id: true, title: true, status: true, updatedAt: true },
        orderBy: { id: 'asc' },
    });
    return { controls, links, tasks };
}

describeFn('a requirement that leaves the catalogue scope leaves it in an existing database', () => {
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

        // The database before #5644: the L1 catalogue with both rows at L1 …
        const applied = await applyCatalogFile(prisma, PRE, FIXTURE);
        frameworkId = applied.framework.id;
        // … a tenant that installed the pack, so its controls link both rows …
        await installPack(ctx, PACK_KEY);
        // … and a template the entry does not name, linked by another writer.
        const other = await prisma.controlTemplate.create({
            data: { code: OTHER_TEMPLATE, title: 'Other writer', category: 'Other' },
        });
        const v261 = await prisma.frameworkRequirement.findUniqueOrThrow({
            where: { frameworkId_code: { frameworkId, code: 'V2.6.1' } },
        });
        await prisma.controlTemplateRequirementLink.create({
            data: { templateId: other.id, requirementId: v261.id },
        });
    });

    afterAll(async () => {
        await deleteAuditRowsForTenants(prisma, TENANT);
        const codes = [
            OTHER_TEMPLATE,
            ...PRE.templates.map((t) => t.code),
            ...FRESH.templates.map((t) => t.code),
        ];
        const tids = (
            await prisma.controlTemplate.findMany({ where: { code: { in: codes } }, select: { id: true } })
        ).map((t) => t.id);
        const fwIds = (
            await prisma.framework.findMany({
                where: { key: { in: [FW_KEY, FRESH.framework.key] } },
                select: { id: true },
            })
        ).map((f) => f.id);
        await prisma.controlRequirementLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.taskLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.task.deleteMany({ where: { tenantId: TENANT } });
        await prisma.control.deleteMany({ where: { tenantId: TENANT } });
        await prisma.packTemplateLink.deleteMany({ where: { templateId: { in: tids } } });
        await prisma.controlTemplateRequirementLink.deleteMany({ where: { templateId: { in: tids } } });
        await prisma.controlTemplateTask.deleteMany({ where: { templateId: { in: tids } } });
        await prisma.controlTemplate.deleteMany({ where: { id: { in: tids } } });
        await prisma.frameworkPack.deleteMany({ where: { frameworkId: { in: fwIds } } });
        await prisma.frameworkRequirement.deleteMany({ where: { frameworkId: { in: fwIds } } });
        await prisma.framework.deleteMany({ where: { id: { in: fwIds } } });
        await prisma.$disconnect();
    });

    it('starts from the pre-#5644 state (not vacuous)', async () => {
        // Every later assertion is about a change from THIS state, so it is
        // checked rather than assumed: both rows L1, each linked to its
        // template, and the tenant's installed controls linked to both.
        expect(CURRENT.outOfScopeRequirements.map((o) => o.code).sort()).toEqual([...MOVED].sort());
        expect(await movedRows()).toEqual([
            {
                code: 'V11.1.6',
                category: 'L1',
                templateLinks: [{ template: { code: tcode('ASVS-V11') } }],
            },
            {
                code: 'V2.6.1',
                category: 'L1',
                templateLinks: expect.arrayContaining([
                    { template: { code: tcode('ASVS-V2') } },
                    { template: { code: OTHER_TEMPLATE } },
                ]),
            },
        ]);
        const tenantLinks = await prisma.controlRequirementLink.count({
            where: { tenantId: TENANT, requirement: { frameworkId, code: { in: MOVED } } },
        });
        expect(tenantLinks).toBe(2);
    });

    it('the applier alone, without the entries, changes nothing', async () => {
        // The defect: dropping a requirement from the file is invisible to a
        // database that already holds it.
        await applyCatalogFile(prisma, { ...NOW, outOfScopeRequirements: [] }, FIXTURE);
        const rows = await movedRows();
        expect(rows.map((r) => [r.code, r.category, r.templateLinks.length])).toEqual([
            ['V11.1.6', 'L1', 1],
            ['V2.6.1', 'L1', 2],
        ]);
    });

    it('the catalogue re-categorises both rows to L2 and unlinks them from the L1 templates', async () => {
        const before = await tenantSnapshot();
        const otherLinksBefore = await prisma.controlTemplateRequirementLink.count({
            where: { template: { code: { in: [tcode('ASVS-V2'), tcode('ASVS-V11')] } } },
        });

        const result = await applyCatalogFile(prisma, NOW, FIXTURE);

        expect(result.outOfScope).toEqual({ recategorised: 2, linksRemoved: 2 });
        expect(await movedRows()).toEqual([
            { code: 'V11.1.6', category: 'L2', templateLinks: [] },
            // A link the file did not write and does not name is not its to remove.
            { code: 'V2.6.1', category: 'L2', templateLinks: [{ template: { code: OTHER_TEMPLATE } }] },
        ]);
        // The rest of the two templates' links are untouched: exactly two went.
        const otherLinksAfter = await prisma.controlTemplateRequirementLink.count({
            where: { template: { code: { in: [tcode('ASVS-V2'), tcode('ASVS-V11')] } } },
        });
        expect(otherLinksAfter).toBe(otherLinksBefore - 2);

        // The tenant's own controls, their requirement links and their tasks
        // are byte-for-byte what they were.
        const after = await tenantSnapshot();
        expect(before.controls.length).toBeGreaterThan(0);
        expect(before.tasks.length).toBeGreaterThan(0);
        expect(after).toEqual(before);
        const stillLinked = await prisma.controlRequirementLink.count({
            where: { tenantId: TENANT, requirement: { frameworkId, code: { in: MOVED } } },
        });
        expect(stillLinked).toBe(2);
    });

    it('is idempotent: a second apply changes nothing', async () => {
        const result = await applyCatalogFile(prisma, NOW, FIXTURE);
        expect(result.outOfScope).toEqual({ recategorised: 0, linksRemoved: 0 });
        expect((await movedRows()).map((r) => r.category)).toEqual(['L2', 'L2']);
    });

    it('a fresh install never creates the rows it no longer declares', async () => {
        const result = await applyCatalogFile(prisma, FRESH, FIXTURE);
        expect(result.outOfScope).toEqual({ recategorised: 0, linksRemoved: 0 });
        const rows = await prisma.frameworkRequirement.count({
            where: { framework: { key: FRESH.framework.key }, code: { in: MOVED } },
        });
        expect(rows).toBe(0);
    });
});
