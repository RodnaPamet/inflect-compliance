/**
 * A framework with several packs is counted over the packs a workspace chose.
 *
 * ── WHAT THIS PROVES ────────────────────────────────────────────────────────
 *
 *   1. Installing a pack records it in `TenantFrameworkPack`, and coverage, the
 *      readiness report and the framework tree count only the requirements the
 *      recorded packs cite. The rest are listed as outside the chosen packs and
 *      are not in `total`, `unmapped` or any percentage.
 *   2. A second workspace that installed nothing on the same framework is not
 *      narrowed by the first one's choice: it sees every requirement.
 *   3. `TenantFrameworkPack` is tenant-isolated under `app_user`: tenant B
 *      reads none of tenant A's rows and cannot write one in A's name.
 *   4. The migration's backfill, replayed, rebuilds a missing row from the
 *      FRAMEWORK_PACK_INSTALLED audit row the install wrote.
 *
 * EU drone operations is the framework because it is the one with several
 * packs; its fixture is the source of every expected number below.
 */
import fs from 'node:fs';
import path from 'node:path';

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

import {
    computeCoverage,
    generateReadinessReport,
    getFrameworkTree,
    installPacks,
} from '@/app-layer/usecases/framework';
import { withTenantDb } from '@/lib/db-context';
import { hashForLookup } from '@/lib/security/encryption';
import type { FrameworkTreeNode } from '@/lib/framework-tree/types';

import { catalogPacks, loadAndValidateCatalogFile } from '../../prisma/catalog-loader';
import { applyCatalogFile } from '../../prisma/catalog-applier';
import { DB_AVAILABLE, DB_URL } from './db-helper';
import { makeRequestContext } from '../helpers/make-context';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: DB_URL }), transactionOptions: TENANT_TX_OPTIONS });
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(180_000);

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE = path.join(ROOT, 'prisma/fixtures/eu-uas-ops-control-templates.json');
const MIGRATION = path.join(ROOT, 'prisma/migrations/20261026120000_tenant_framework_pack/migration.sql');
const file = loadAndValidateCatalogFile(FIXTURE);
const KEY = 'EU-UAS-OPS';
const A2 = 'EU_UAS_OPEN_A2';

/** The requirement codes a pack's templates cite: the scope it gives. */
function codesCitedBy(packKey: string): string[] {
    const templateCodes = new Set(catalogPacks(file).find((p) => p.key === packKey)!.templateCodes ?? []);
    const codes = new Set<string>();
    for (const t of file.templates) if (templateCodes.has(t.code)) for (const c of t.requirementCodes) codes.add(c);
    return [...codes].sort();
}
const ALL_CODES = file.requirements.map((r) => r.code).sort();
const A2_CODES = codesCitedBy(A2);
const OUTSIDE_A2 = ALL_CODES.filter((c) => !A2_CODES.includes(c));

const TENANT_A = 't-pack-scope-a';
const TENANT_B = 't-pack-scope-b';
const ctxA = makeRequestContext('ADMIN', { tenantId: TENANT_A, tenantSlug: 'pack-scope-a', userId: 'u-pack-scope-a' });
const ctxB = makeRequestContext('ADMIN', { tenantId: TENANT_B, tenantSlug: 'pack-scope-b', userId: 'u-pack-scope-b' });

async function clearTenant(tenantId: string) {
    await prisma.tenantFrameworkPack.deleteMany({ where: { tenantId } });
    await prisma.task.deleteMany({ where: { tenantId } });
    await prisma.controlRequirementLink.deleteMany({ where: { tenantId } });
    await prisma.control.deleteMany({ where: { tenantId } });
}

function requirementNodes(nodes: readonly FrameworkTreeNode[], out: FrameworkTreeNode[] = []): FrameworkTreeNode[] {
    for (const n of nodes) {
        if (n.kind === 'requirement') out.push(n);
        requirementNodes(n.children, out);
    }
    return out;
}

describeFn('a multi-pack framework is counted over the packs a workspace chose', () => {
    beforeAll(async () => {
        await applyCatalogFile(prisma, file, FIXTURE);
        for (const ctx of [ctxA, ctxB]) {
            await prisma.tenant.upsert({
                where: { id: ctx.tenantId }, update: {},
                create: { id: ctx.tenantId, name: ctx.tenantId, slug: ctx.tenantSlug! },
            });
            const email = `${ctx.userId}@example.test`;
            await prisma.user.upsert({
                where: { id: ctx.userId }, update: {},
                create: { id: ctx.userId, email, emailHash: hashForLookup(email) },
            });
            await clearTenant(ctx.tenantId);
        }
        // The fixture really does split the framework, or none of this means anything.
        expect(A2_CODES.length).toBeGreaterThan(0);
        expect(OUTSIDE_A2.length).toBeGreaterThan(0);

        await installPacks(ctxA, KEY, [A2]);
    });

    afterAll(async () => {
        await clearTenant(TENANT_A);
        await clearTenant(TENANT_B);
        await prisma.$disconnect();
    });

    it('records the chosen pack, once', async () => {
        await installPacks(ctxA, KEY, [A2]); // a re-install adds no second row
        const rows = await prisma.tenantFrameworkPack.findMany({
            where: { tenantId: TENANT_A },
            select: { pack: { select: { key: true } }, framework: { select: { key: true } } },
        });
        expect(rows).toEqual([{ pack: { key: A2 }, framework: { key: KEY } }]);
    });

    it('counts coverage over the chosen pack and lists the rest apart', async () => {
        const coverage = await computeCoverage(ctxA, KEY);

        expect(coverage.scope).toEqual({ kind: 'CHOSEN_PACKS', packKeys: [A2] });
        expect(coverage.total).toBe(A2_CODES.length);
        // Every in-scope requirement is cited by an installed template, so mapped.
        expect(coverage.mapped).toBe(A2_CODES.length);
        expect(coverage.unmappedRequirements).toEqual([]);
        expect(coverage.coveragePercent).toBe(100);
        expect(coverage.outOfScope).toBe(OUTSIDE_A2.length);
        expect(coverage.outOfScopeRequirements.map((r) => r.code).sort()).toEqual(OUTSIDE_A2);
        const sectionTotal = coverage.bySection.reduce((n, s) => n + s.total, 0);
        expect(sectionTotal).toBe(A2_CODES.length);
    });

    it('scopes the readiness report the same way', async () => {
        const report = await generateReadinessReport(ctxA, KEY);
        expect(report.scope).toEqual({ kind: 'CHOSEN_PACKS', packKeys: [A2] });
        expect(report.unmappedRequirements).toEqual([]);
        expect(report.outOfScopeRequirements.map((r) => r.code).sort()).toEqual(OUTSIDE_A2);
    });

    it('keeps every requirement in the tree, the others read as out of scope', async () => {
        const tree = await getFrameworkTree(ctxA, KEY);
        const reqs = requirementNodes(tree.nodes);
        expect(reqs.map((n) => n.code).sort()).toEqual(ALL_CODES);
        const flagged = reqs.filter((n) => n.outOfScope);
        expect(flagged.map((n) => n.code).sort()).toEqual(OUTSIDE_A2);
        expect(flagged.every((n) => n.complianceStatus === 'na')).toBe(true);
        expect(reqs.filter((n) => !n.outOfScope).some((n) => n.complianceStatus === 'na')).toBe(false);
    });

    it('does not narrow another workspace that chose nothing on the framework', async () => {
        const coverage = await computeCoverage(ctxB, KEY);
        expect(coverage.scope).toEqual({ kind: 'ALL' });
        expect(coverage.total).toBe(ALL_CODES.length);
        expect(coverage.mapped).toBe(0);
        expect(coverage.outOfScope).toBe(0);
        expect(coverage.outOfScopeRequirements).toEqual([]);
    });

    it('keeps the choice tenant-isolated under app_user', async () => {
        const pack = await prisma.frameworkPack.findUniqueOrThrow({ where: { key: A2 } });

        // Tenant B, with no filter of its own, reads none of tenant A's rows.
        const seenByB = await withTenantDb(TENANT_B, (tdb) => tdb.tenantFrameworkPack.findMany());
        expect(seenByB).toEqual([]);
        const seenByA = await withTenantDb(TENANT_A, (tdb) => tdb.tenantFrameworkPack.findMany());
        expect(seenByA.map((r) => r.packId)).toEqual([pack.id]);

        // ...and cannot record a choice in tenant A's name. A pack tenant A
        // does not hold, so only the row-level policy can refuse it.
        const other = await prisma.frameworkPack.findUniqueOrThrow({ where: { key: 'EU_UAS_OPEN_A1' } });
        await expect(
            withTenantDb(TENANT_B, (tdb) =>
                tdb.tenantFrameworkPack.create({
                    data: { tenantId: TENANT_A, frameworkId: other.frameworkId, packId: other.id },
                }),
            ),
        ).rejects.toThrow(/row-level security/i);
        // The same write in its own name succeeds, so the refusal was the tenant.
        await withTenantDb(TENANT_B, (tdb) =>
            tdb.tenantFrameworkPack.create({ data: { tenantId: TENANT_B, frameworkId: other.frameworkId, packId: other.id } }),
        );
        await prisma.tenantFrameworkPack.deleteMany({ where: { tenantId: TENANT_B } });
        expect(await prisma.tenantFrameworkPack.count({ where: { tenantId: TENANT_A } })).toBe(1);
    });

    it("the migration's backfill rebuilds a missing row from the install's audit row", async () => {
        const sql = fs.readFileSync(MIGRATION, 'utf8');
        const start = sql.indexOf('INSERT INTO "TenantFrameworkPack"');
        const end = sql.indexOf('DO NOTHING;', start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        // Narrowed to this suite's tenants so the replay writes nothing for
        // another suite's; the statement is otherwise the migration's own.
        const WHERE = `WHERE a."action" = 'FRAMEWORK_PACK_INSTALLED'`;
        const statement = sql.slice(start, end + 'DO NOTHING;'.length);
        expect(statement.split(WHERE)).toHaveLength(2);
        const backfill = statement.replace(WHERE, `${WHERE} AND a."tenantId" IN ('${TENANT_A}', '${TENANT_B}')`);

        const before = await prisma.tenantFrameworkPack.findMany({
            where: { tenantId: TENANT_A }, select: { tenantId: true, frameworkId: true, packId: true },
        });
        await prisma.tenantFrameworkPack.deleteMany({ where: { tenantId: TENANT_A } });

        await prisma.$executeRawUnsafe(backfill);
        const after = await prisma.tenantFrameworkPack.findMany({
            where: { tenantId: TENANT_A }, select: { tenantId: true, frameworkId: true, packId: true },
        });
        expect(after).toEqual(before);

        // Replaying it again inserts nothing.
        await prisma.$executeRawUnsafe(backfill);
        expect(await prisma.tenantFrameworkPack.count({ where: { tenantId: TENANT_A } })).toBe(1);
        // Tenant B installed nothing, so its audit trail gives it no row.
        expect(await prisma.tenantFrameworkPack.count({ where: { tenantId: TENANT_B } })).toBe(0);
    });
});
