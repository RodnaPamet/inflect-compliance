/**
 * EU drone operations reaches a database with its eight packs, and
 * a tenant installs exactly the subcategories it chose.
 *
 * ── WHAT THIS PROVES THAT THE GUARDRAIL CANNOT ──────────────────────────────
 *
 * `tests/guardrails/eu-uas-framework-coverage.test.ts` proves the FILES are
 * right: each pack cites only, and all of, the requirements that govern its
 * subcategory. This proves the WRITES are: that `applyCatalogFile` turns a
 * `packs` file into eight pack rows sharing template rows; that the library
 * import adopts the catalogue's framework row rather than colliding with it;
 * and that installing two packs that share their core creates each shared
 * control ONCE, while a later third pack adds only what is its own.
 *
 * `propagateDelta: false` for the same reason as the AIUC-1 import test.
 */
import path from 'node:path';

import type { PrismaClient } from '@prisma/client';

import { importLibraryFromFile } from '@/app-layer/services/library-importer';
import { installPacks } from '@/app-layer/usecases/framework';
import { hashForLookup } from '@/lib/security/encryption';

import { catalogPacks, loadAndValidateCatalogFile } from '../../prisma/catalog-loader';
import { applyCatalogFile } from '../../prisma/catalog-applier';
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';

const prisma: PrismaClient = prismaTestClient();
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../..');
const LIB_FILE = path.join(ROOT, 'src/data/libraries/eu-uas-ops.yaml');
const FIXTURE = path.join(ROOT, 'prisma/fixtures/eu-uas-ops-control-templates.json');
const file = loadAndValidateCatalogFile(FIXTURE);
const KEY = 'EU-UAS-OPS';
const PACKS = catalogPacks(file);
const tasksOf = new Map(file.templates.map((t) => [t.code, t.tasks.length]));
const packCodes = (key: string) => PACKS.find((p) => p.key === key)!.templateCodes ?? [];

async function snapshot() {
    const frameworks = await prisma.framework.findMany({ where: { key: KEY }, select: { id: true } });
    const requirements = await prisma.frameworkRequirement.findMany({
        where: { framework: { key: KEY } },
        select: { id: true, code: true, title: true, description: true, section: true },
        orderBy: { code: 'asc' },
    });
    return { frameworks, requirements };
}

describeFn('EU UAS: the catalogue lands eight packs over one framework row', () => {
    beforeAll(async () => {
        await resetDatabase(prisma);
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('writes the framework, its 51 requirements, 53 templates and the eight packs', async () => {
        const result = await applyCatalogFile(prisma, file, FIXTURE);
        expect(result.framework.created).toBe(true);
        expect(result.packs.map((p) => p.key)).toEqual(PACKS.map((p) => p.key));

        expect((await snapshot()).requirements).toHaveLength(51);
        expect(await prisma.controlTemplate.count({ where: { code: { startsWith: 'UAS-' } } })).toBe(53);

        // Each pack links exactly its own templates — the shared core into all
        // eight — and every pack hangs off the one framework row.
        for (const pack of PACKS) {
            const row = await prisma.frameworkPack.findUniqueOrThrow({
                where: { key: pack.key },
                include: { templateLinks: { include: { template: { select: { code: true } } } }, framework: { select: { key: true } } },
            });
            expect(row.framework.key).toBe(KEY);
            expect(row.templateLinks.map((l) => l.template.code).sort()).toEqual([...(pack.templateCodes ?? [])].sort());
        }
    });

    it('the library import then adopts the SAME framework and requirement rows', async () => {
        const before = await snapshot();
        const result = await importLibraryFromFile(prisma, LIB_FILE, { propagateDelta: false });
        expect({ created: result.requirementsCreated, deprecated: result.requirementsDeprecated })
            .toEqual({ created: 0, deprecated: 0 });
        expect(await snapshot()).toEqual(before);
    });

    it('re-applying the catalogue changes nothing', async () => {
        const before = await snapshot();
        const authored = file.templates.reduce((n, t) => n + t.tasks.length, 0);
        const result = await applyCatalogFile(prisma, file, FIXTURE);
        expect(result.tasks).toEqual({ created: 0, updated: 0, deprecated: 0, unchanged: authored });
        expect(result.packs.every((p) => !p.created)).toBe(true);
        expect(await snapshot()).toEqual(before);
    });
});

describeFn('EU UAS: a tenant installs the subcategories it chose', () => {
    const TENANT = 't-eu-uas-install';
    const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: 'eu-uas-install', userId: 'u-eu-uas-install' });

    beforeAll(async () => {
        await resetDatabase(prisma);
        await applyCatalogFile(prisma, file, FIXTURE);
        // Upserts: `resetDatabase` keeps tenants and users, so a re-run finds them.
        await prisma.tenant.upsert({
            where: { id: TENANT }, update: {},
            create: { id: TENANT, name: 'EU UAS operator', slug: 'eu-uas-install' },
        });
        const email = 'eu-uas-install@example.test';
        await prisma.user.upsert({
            where: { id: ctx.userId }, update: {},
            create: { id: ctx.userId, email, emailHash: hashForLookup(email) },
        });
        // Controls are tenant-scoped and may survive a reset the same way.
        await prisma.task.deleteMany({ where: { tenantId: TENANT } });
        await prisma.controlRequirementLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.control.deleteMany({ where: { tenantId: TENANT } });
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    const controlCodes = async () =>
        (await prisma.control.findMany({ where: { tenantId: TENANT }, select: { code: true } }))
            .map((c) => c.code ?? '')
            .sort();

    it('refuses an empty choice and writes nothing', async () => {
        await expect(installPacks(ctx, KEY, [])).rejects.toThrow(/at least one pack/i);
        expect(await controlCodes()).toEqual([]);
    });

    it('installs A2 and A3 together, each shared control once', async () => {
        const union = [...new Set([...packCodes('EU_UAS_OPEN_A2'), ...packCodes('EU_UAS_OPEN_A3')])];
        const result = await installPacks(ctx, KEY, ['EU_UAS_OPEN_A2', 'EU_UAS_OPEN_A3']);

        expect(await controlCodes()).toEqual([...union].sort());
        expect(result.controlsCreated).toBe(union.length);
        expect(result.tasksCreated).toBe(union.reduce((n, c) => n + (tasksOf.get(c) ?? 0), 0));
        // No A1, STS, authorisation or LUC control came with them.
        expect((await controlCodes()).filter((c) => /^UAS-(A1|STS|OA|LUC|SPEC)/.test(c))).toEqual([]);
    });

    it('adding A1 later creates only what A1 adds', async () => {
        const before = await controlCodes();
        const result = await installPacks(ctx, KEY, ['EU_UAS_OPEN_A1']);
        const added = (await controlCodes()).filter((c) => !before.includes(c));
        expect(added).toEqual(['UAS-A1-01', 'UAS-A1-02', 'UAS-A1-03']);
        expect(result.controlsCreated).toBe(3);
    });
});

describeFn('EU UAS: the class C2 pack gives a tenant what A2 and A3 give', () => {
    const TENANT = 't-eu-uas-c2';
    const ctx = makeRequestContext('ADMIN', { tenantId: TENANT, tenantSlug: 'eu-uas-c2', userId: 'u-eu-uas-c2' });

    beforeAll(async () => {
        await resetDatabase(prisma);
        await applyCatalogFile(prisma, file, FIXTURE);
        await prisma.tenant.upsert({
            where: { id: TENANT }, update: {},
            create: { id: TENANT, name: 'EU UAS C2 operator', slug: 'eu-uas-c2' },
        });
        const email = 'eu-uas-c2@example.test';
        await prisma.user.upsert({
            where: { id: ctx.userId }, update: {},
            create: { id: ctx.userId, email, emailHash: hashForLookup(email) },
        });
        await prisma.task.deleteMany({ where: { tenantId: TENANT } });
        await prisma.controlRequirementLink.deleteMany({ where: { tenantId: TENANT } });
        await prisma.control.deleteMany({ where: { tenantId: TENANT } });
    });

    afterAll(async () => {
        await prisma.$disconnect();
    });

    it('installs the A2 and A3 controls, each once, and nothing else', async () => {
        const union = [...new Set([...packCodes('EU_UAS_OPEN_A2'), ...packCodes('EU_UAS_OPEN_A3')])];
        const result = await installPacks(ctx, KEY, ['EU_UAS_CLASS_C2']);

        const codes = (await prisma.control.findMany({ where: { tenantId: TENANT }, select: { code: true } }))
            .map((c) => c.code ?? '')
            .sort();
        expect(codes).toEqual([...union].sort());
        expect(result.controlsCreated).toBe(union.length);

        // Ticking A2 as well afterwards adds nothing: the C2 pack already holds it.
        const again = await installPacks(ctx, KEY, ['EU_UAS_OPEN_A2']);
        expect(again.controlsCreated).toBe(0);
    });
});
