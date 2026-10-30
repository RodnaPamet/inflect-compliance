/**
 * The migration that switches `personnel.manage` off on custom roles built on
 * READER, EDITOR or AUDITOR, run from the migration file itself against a real
 * database (#4536).
 *
 * Owner decision, 2026-10-30: only a custom role based on ADMIN may hold
 * `personnel.manage`. The usecases now refuse it on any other base; the
 * migration switches off the grants already stored. The SQL is read OUT OF the
 * migration and executed, not re-typed. Pinned here:
 *
 *   - a READER, EDITOR or AUDITOR role stating `manage: true` ends at `false`,
 *     inactive rows included, in every tenant, and every other key of its blob
 *     is what it was — `personnel.view` included;
 *   - an ADMIN-based role, a blob with no `personnel` domain, a `manage`
 *     already `false` and a non-boolean `manage` are not touched at all (blob
 *     AND `updatedAt`);
 *   - a second run changes nothing anywhere in the table;
 *   - a legacy OWNER- or AI_ADMIN-based row under a NOT VALID #3734 CHECK does
 *     not make the migration fail, and is not touched.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { getPermissionsForRole, parsePermissionsJson } from '@/lib/permissions';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const MIGRATION = path.resolve(
    __dirname,
    '../../prisma/migrations/20261030130000_personnel_manage_off_for_non_admin_custom_roles/migration.sql',
);
const BASE_ROLE_CHECK = 'TenantCustomRole_base_role_not_built_in_scope';

/**
 * The migration's one statement, comments stripped. Asserted to BE one
 * statement, so an edit that adds a second cannot have this suite run only the
 * first.
 */
function migrationStatement(): string {
    const statements = readFileSync(MIGRATION, 'utf8')
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    expect(statements).toHaveLength(1);
    return statements[0];
}

type Blob = Record<string, Record<string, unknown>>;

/** A whole stored blob as the roles page could save it before #4536. */
function presetBlob(base: 'ADMIN' | 'EDITOR' | 'AUDITOR' | 'READER', personnel: Record<string, unknown>): Blob {
    return { ...getPermissionsForRole(base), personnel } as unknown as Blob;
}

/** The same blob with only `personnel.manage` set to `false`. */
function withManageOff(blob: Blob): Blob {
    return { ...blob, personnel: { ...blob.personnel, manage: false } };
}

const SEEDED_UPDATED_AT = new Date('2026-01-01T00:00:00.000Z');

describeFn('personnel.manage off for READER/EDITOR/AUDITOR custom roles (migration, real DB)', () => {
    let prisma: PrismaClient;
    const tag = `pmmig-${randomUUID().slice(0, 8)}`;
    const tenantA = `${tag}-a`;
    const tenantB = `${tag}-b`;
    const ids: string[] = [];

    type Seed = { id: string; tenantId: string; baseRole: string; isActive: boolean; blob: unknown };

    async function insertRole(
        db: { $executeRawUnsafe: PrismaClient['$executeRawUnsafe'] },
        seed: Seed,
    ): Promise<void> {
        await db.$executeRawUnsafe(
            `INSERT INTO "TenantCustomRole" (id, "tenantId", name, "baseRole", "permissionsJson", "isActive", "updatedAt")
             VALUES ($1, $2, $1, $3::"Role", $4::jsonb, $5, $6)`,
            seed.id,
            seed.tenantId,
            seed.baseRole,
            JSON.stringify(seed.blob),
            seed.isActive,
            SEEDED_UPDATED_AT,
        );
    }

    async function readRole(
        db: { $queryRawUnsafe: PrismaClient['$queryRawUnsafe'] },
        id: string,
    ): Promise<{ blob: unknown; updatedAt: Date }> {
        const rows = await db.$queryRawUnsafe<Array<{ blob: unknown; updatedAt: Date }>>(
            `SELECT "permissionsJson" AS blob, "updatedAt" FROM "TenantCustomRole" WHERE id = $1`,
            id,
        );
        expect(rows).toHaveLength(1);
        return rows[0];
    }

    const seeds: Record<string, Seed> = {};
    function seed(key: string, s: Omit<Seed, 'id'>): Seed {
        const row = { ...s, id: `${tag}-${key}` };
        seeds[key] = row;
        ids.push(row.id);
        return row;
    }

    // Switched off.
    seed('reader', { tenantId: tenantA, baseRole: 'READER', isActive: true, blob: presetBlob('READER', { view: false, manage: true }) });
    seed('editor', { tenantId: tenantA, baseRole: 'EDITOR', isActive: true, blob: presetBlob('EDITOR', { view: false, manage: true }) });
    seed('auditor', { tenantId: tenantA, baseRole: 'AUDITOR', isActive: true, blob: presetBlob('AUDITOR', { view: false, manage: true }) });
    seed('auditor-deleted', { tenantId: tenantA, baseRole: 'AUDITOR', isActive: false, blob: presetBlob('AUDITOR', { view: false, manage: true }) });
    // A role a custom view grant still holds: `view` is not this migration's.
    seed('reader-view', { tenantId: tenantA, baseRole: 'READER', isActive: true, blob: presetBlob('ADMIN', { view: true, manage: true }) });
    seed('reader-tenant-b', { tenantId: tenantB, baseRole: 'READER', isActive: true, blob: presetBlob('READER', { view: false, manage: true }) });
    const SWITCHED_OFF = ['reader', 'editor', 'auditor', 'auditor-deleted', 'reader-view', 'reader-tenant-b'];

    // Left exactly as they were.
    seed('admin', { tenantId: tenantA, baseRole: 'ADMIN', isActive: true, blob: presetBlob('ADMIN', { view: true, manage: true }) });
    // A blob saved before the people layer existed: no `personnel` domain at all.
    const noPersonnel = presetBlob('READER', {});
    delete noPersonnel.personnel;
    seed('reader-no-domain', { tenantId: tenantA, baseRole: 'READER', isActive: true, blob: noPersonnel });
    seed('editor-already-off', { tenantId: tenantA, baseRole: 'EDITOR', isActive: true, blob: presetBlob('EDITOR', { view: false, manage: false }) });
    seed('reader-string-manage', { tenantId: tenantB, baseRole: 'READER', isActive: true, blob: presetBlob('READER', { view: false, manage: 'true' }) });
    const UNTOUCHED = ['admin', 'reader-no-domain', 'editor-already-off', 'reader-string-manage'];

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        for (const id of [tenantA, tenantB]) {
            await prisma.tenant.create({ data: { id, name: id, slug: id } });
        }
        for (const s of Object.values(seeds)) await insertRole(prisma, s);
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "TenantCustomRole" WHERE id = ANY($1::text[])`, ids);
        await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
        await prisma.$disconnect();
    });

    it('switches the stated grant off, touches nothing else, and a second run changes nothing', async () => {
        const statement = migrationStatement();
        const before = Object.fromEntries(
            await Promise.all(Object.keys(seeds).map(async (k) => [k, await readRole(prisma, seeds[k].id)] as const)),
        );

        // Global by design: other suites' leftovers may match too, so the first
        // count is a floor rather than an exact figure.
        const firstRun = await prisma.$executeRawUnsafe(statement);
        expect(firstRun).toBeGreaterThanOrEqual(SWITCHED_OFF.length);

        const after = Object.fromEntries(
            await Promise.all(Object.keys(seeds).map(async (k) => [k, await readRole(prisma, seeds[k].id)] as const)),
        );

        for (const key of SWITCHED_OFF) {
            // The whole blob, so a change to any other key — `view` included —
            // fails here, not only a wrong `manage`.
            expect({ key, blob: after[key].blob }).toEqual({ key, blob: withManageOff(seeds[key].blob as Blob) });
            expect(after[key].updatedAt.getTime()).toBeGreaterThan(SEEDED_UPDATED_AT.getTime());
            // What a member carrying the role is now allowed, through the same
            // parse the request context uses.
            expect(parsePermissionsJson(after[key].blob, seeds[key].baseRole as Role).personnel.manage).toBe(false);
        }
        expect((after['reader-view'].blob as Blob).personnel.view).toBe(true);

        for (const key of UNTOUCHED) {
            expect({ key, row: after[key] }).toEqual({ key, row: before[key] });
        }
        expect(parsePermissionsJson(after.admin.blob, 'ADMIN').personnel.manage).toBe(true);

        // Idempotent: nothing in the whole table matches any more, and our rows
        // read back byte-for-byte as the first run left them.
        expect(await prisma.$executeRawUnsafe(statement)).toBe(0);
        for (const key of Object.keys(seeds)) {
            expect({ key, row: await readRole(prisma, seeds[key].id) }).toEqual({ key, row: after[key] });
        }
    });

    it('a legacy OWNER- or AI_ADMIN-based row under a NOT VALID #3734 CHECK neither fails the migration nor is touched', async () => {
        const statement = migrationStatement();
        const ROLLBACK = new Error('rollback: this test leaves no schema change behind');
        const seen: Record<string, unknown> = {};
        const legacy = [
            { id: `${tag}-legacy-owner`, tenantId: tenantA, baseRole: 'OWNER', isActive: true, blob: presetBlob('READER', { view: false, manage: true }) },
            { id: `${tag}-legacy-ai-admin`, tenantId: tenantA, baseRole: 'AI_ADMIN', isActive: true, blob: presetBlob('READER', { view: false, manage: true }) },
        ];

        await prisma
            .$transaction(
                async (tx) => {
                    // The state #3734's WARNING branch leaves: the CHECK present
                    // but NOT VALID over rows built on OWNER and AI_ADMIN.
                    await tx.$executeRawUnsafe(`ALTER TABLE "TenantCustomRole" DROP CONSTRAINT "${BASE_ROLE_CHECK}"`);
                    for (const row of legacy) await insertRole(tx, row);
                    await tx.$executeRawUnsafe(
                        `ALTER TABLE "TenantCustomRole" ADD CONSTRAINT "${BASE_ROLE_CHECK}"
                         CHECK ("baseRole" NOT IN ('OWNER', 'AI_ADMIN')) NOT VALID`,
                    );

                    try {
                        await tx.$executeRawUnsafe(statement);
                        seen.migration = 'ok';
                    } catch (e) {
                        seen.migration = e instanceof Error ? e.message : String(e);
                        throw ROLLBACK;
                    }
                    seen.rows = await Promise.all(legacy.map((row) => readRole(tx, row.id)));
                    throw ROLLBACK;
                },
                { timeout: 30_000 },
            )
            .catch((e) => {
                if (e !== ROLLBACK) throw e;
            });

        expect(seen).toEqual({
            migration: 'ok',
            rows: legacy.map((row) => ({ blob: row.blob, updatedAt: SEEDED_UPDATED_AT })),
        });
        const constraint = await prisma.$queryRawUnsafe<Array<{ convalidated: boolean }>>(
            `SELECT convalidated FROM pg_constraint WHERE conname = $1`,
            BASE_ROLE_CHECK,
        );
        expect(constraint).toEqual([{ convalidated: true }]);
    });
});
