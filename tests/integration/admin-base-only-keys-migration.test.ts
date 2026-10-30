/**
 * The migration that switches the Admin-base-only admin keys off on custom
 * roles built on READER, EDITOR or AUDITOR, run from the migration file itself
 * against a real database (#4581 A).
 *
 * Owner decision, 2026-10-30: a custom role may hold the admin permissions
 * whose server code asks the Admin tier only when it is based on ADMIN. The
 * usecases now refuse them on any other base; the migration switches off the
 * grants already stored. The SQL is read OUT OF the migration and executed,
 * not re-typed. Pinned here:
 *
 *   - on a READER, EDITOR or AUDITOR role, each of `admin.manage`,
 *     `admin.members`, `admin.owner_management` and `admin.tenant_lifecycle`
 *     stated `true` ends at `false`, inactive rows included, in every tenant —
 *     and every other key of the blob is what it was, the admin keys a custom
 *     role may hold on any base (`view`, the agent keys, DSAR) included;
 *   - the migration covers exactly the admin keys of `ADMIN_BASE_ONLY_PERMISSIONS`
 *     (personnel.manage is #4536's), so the list and the SQL cannot drift;
 *   - an ADMIN-based role, a blob with no `admin` domain, keys already `false`
 *     and a non-boolean value are not touched at all (blob AND `updatedAt`);
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
import { ADMIN_BASE_ONLY_PERMISSIONS } from '@/lib/custom-role-admin-base-rule';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const MIGRATION = path.resolve(
    __dirname,
    '../../prisma/migrations/20261030150000_admin_base_only_keys_off_for_non_admin_custom_roles/migration.sql',
);
const BASE_ROLE_CHECK = 'TenantCustomRole_base_role_not_built_in_scope';

/** The admin keys this migration owns: the list's, less #4536's personnel key. */
const KEYS = ADMIN_BASE_ONLY_PERMISSIONS.filter((k) => k.startsWith('admin.')).map((k) => k.slice('admin.'.length));

/** The migration's statements, comments stripped. Asserted to be one per key. */
function migrationStatements(): string[] {
    const statements = readFileSync(MIGRATION, 'utf8')
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    expect(statements).toHaveLength(KEYS.length);
    return statements;
}

type Blob = Record<string, Record<string, unknown>>;

/** `base`'s preset with the given admin keys overridden, as a custom role could store it. */
function blobWith(base: 'ADMIN' | 'EDITOR' | 'AUDITOR' | 'READER', admin: Record<string, unknown>): Blob {
    const preset = getPermissionsForRole(base) as unknown as Blob;
    return { ...preset, admin: { ...preset.admin, ...admin } };
}

/** Every admin key a custom role may hold on any base, granted, plus `grant`. */
function anyBaseKeysAnd(base: 'EDITOR' | 'AUDITOR' | 'READER', grant: Record<string, unknown>): Blob {
    return blobWith(base, {
        view: true,
        compliance_dsar_view: true,
        compliance_dsar_manage: true,
        agent_registry: true,
        agent_kill_switch: true,
        ...grant,
    });
}

const ALL_FOUR = Object.fromEntries(KEYS.map((k) => [k, true]));

/** `blob` with every migration key that it states `true` set to `false`. */
function expectedAfter(blob: Blob): Blob {
    const admin = { ...blob.admin };
    for (const k of KEYS) if (admin[k] === true) admin[k] = false;
    return { ...blob, admin };
}

const SEEDED_UPDATED_AT = new Date('2026-01-01T00:00:00.000Z');

describeFn('admin-base-only keys off for READER/EDITOR/AUDITOR custom roles (migration, real DB)', () => {
    let prisma: PrismaClient;
    const tag = `abmig-${randomUUID().slice(0, 8)}`;
    const tenantA = `${tag}-a`;
    const tenantB = `${tag}-b`;
    const ids: string[] = [];

    type Seed = { id: string; tenantId: string; baseRole: string; isActive: boolean; blob: unknown };

    async function insertRole(db: { $executeRawUnsafe: PrismaClient['$executeRawUnsafe'] }, s: Seed): Promise<void> {
        await db.$executeRawUnsafe(
            `INSERT INTO "TenantCustomRole" (id, "tenantId", name, "baseRole", "permissionsJson", "isActive", "updatedAt")
             VALUES ($1, $2, $1, $3::"Role", $4::jsonb, $5, $6)`,
            s.id,
            s.tenantId,
            s.baseRole,
            JSON.stringify(s.blob),
            s.isActive,
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
    function seed(key: string, s: Omit<Seed, 'id'>): void {
        const row = { ...s, id: `${tag}-${key}` };
        seeds[key] = row;
        ids.push(row.id);
    }

    // Switched off: every key the row grants, and nothing else.
    seed('reader-all', { tenantId: tenantA, baseRole: 'READER', isActive: true, blob: anyBaseKeysAnd('READER', ALL_FOUR) });
    seed('editor-all', { tenantId: tenantA, baseRole: 'EDITOR', isActive: true, blob: anyBaseKeysAnd('EDITOR', ALL_FOUR) });
    seed('auditor-all', { tenantId: tenantA, baseRole: 'AUDITOR', isActive: true, blob: anyBaseKeysAnd('AUDITOR', ALL_FOUR) });
    seed('auditor-deleted', { tenantId: tenantA, baseRole: 'AUDITOR', isActive: false, blob: anyBaseKeysAnd('AUDITOR', ALL_FOUR) });
    seed('reader-tenant-b', { tenantId: tenantB, baseRole: 'READER', isActive: true, blob: anyBaseKeysAnd('READER', ALL_FOUR) });
    for (const k of KEYS) {
        seed(`editor-only-${k}`, { tenantId: tenantA, baseRole: 'EDITOR', isActive: true, blob: anyBaseKeysAnd('EDITOR', { [k]: true }) });
    }
    const SWITCHED_OFF = ['reader-all', 'editor-all', 'auditor-all', 'auditor-deleted', 'reader-tenant-b', ...KEYS.map((k) => `editor-only-${k}`)];

    // Left exactly as they were.
    seed('admin', { tenantId: tenantA, baseRole: 'ADMIN', isActive: true, blob: blobWith('ADMIN', ALL_FOUR) });
    const noAdmin = blobWith('READER', {});
    delete noAdmin.admin;
    seed('reader-no-domain', { tenantId: tenantA, baseRole: 'READER', isActive: true, blob: noAdmin });
    seed('reader-any-base-only', { tenantId: tenantA, baseRole: 'READER', isActive: true, blob: anyBaseKeysAnd('READER', {}) });
    seed('editor-strings', { tenantId: tenantB, baseRole: 'EDITOR', isActive: true, blob: blobWith('EDITOR', Object.fromEntries(KEYS.map((k) => [k, 'true']))) });
    const UNTOUCHED = ['admin', 'reader-no-domain', 'reader-any-base-only', 'editor-strings'];

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        for (const id of [tenantA, tenantB]) await prisma.tenant.create({ data: { id, name: id, slug: id } });
        for (const s of Object.values(seeds)) await insertRole(prisma, s);
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "TenantCustomRole" WHERE id = ANY($1::text[])`, ids);
        await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
        await prisma.$disconnect();
    });

    it('covers exactly the admin keys of the rule', () => {
        const sql = readFileSync(MIGRATION, 'utf8').replace(/--[^\n]*/g, '');
        const set = [...sql.matchAll(/'\{admin,([a-z_]+)\}'/g)].map((m) => m[1]).sort();
        const where = [...sql.matchAll(/-> 'admin' -> '([a-z_]+)'/g)].map((m) => m[1]).sort();
        expect(set).toEqual([...KEYS].sort());
        expect(where).toEqual([...KEYS].sort());
    });

    it('switches each stated grant off, touches nothing else, and a second run changes nothing', async () => {
        const statements = migrationStatements();
        const before = Object.fromEntries(
            await Promise.all(Object.keys(seeds).map(async (k) => [k, await readRole(prisma, seeds[k].id)] as const)),
        );

        for (const statement of statements) await prisma.$executeRawUnsafe(statement);

        const after = Object.fromEntries(
            await Promise.all(Object.keys(seeds).map(async (k) => [k, await readRole(prisma, seeds[k].id)] as const)),
        );

        for (const key of SWITCHED_OFF) {
            // The whole blob, so a change to any other key fails here.
            expect({ key, blob: after[key].blob }).toEqual({ key, blob: expectedAfter(seeds[key].blob as Blob) });
            expect(after[key].updatedAt.getTime()).toBeGreaterThan(SEEDED_UPDATED_AT.getTime());
            // What a member carrying the role is now allowed, through the same
            // parse the request context uses.
            const admin = parsePermissionsJson(after[key].blob, seeds[key].baseRole as Role).admin as Record<string, boolean>;
            for (const k of KEYS) expect({ key, k, held: admin[k] }).toEqual({ key, k, held: false });
            expect(admin.view).toBe(true);
            expect(admin.agent_registry).toBe(true);
        }

        for (const key of UNTOUCHED) {
            expect({ key, row: after[key] }).toEqual({ key, row: before[key] });
        }

        // Idempotent: nothing in the whole table matches any more.
        for (const statement of statements) expect(await prisma.$executeRawUnsafe(statement)).toBe(0);
        for (const key of Object.keys(seeds)) {
            expect({ key, row: await readRole(prisma, seeds[key].id) }).toEqual({ key, row: after[key] });
        }
    });

    it('a legacy OWNER- or AI_ADMIN-based row under a NOT VALID #3734 CHECK neither fails the migration nor is touched', async () => {
        const statements = migrationStatements();
        const ROLLBACK = new Error('rollback: this test leaves no schema change behind');
        const seen: Record<string, unknown> = {};
        const legacy = [
            { id: `${tag}-legacy-owner`, tenantId: tenantA, baseRole: 'OWNER', isActive: true, blob: anyBaseKeysAnd('READER', ALL_FOUR) },
            { id: `${tag}-legacy-ai-admin`, tenantId: tenantA, baseRole: 'AI_ADMIN', isActive: true, blob: anyBaseKeysAnd('READER', ALL_FOUR) },
        ];

        await prisma
            .$transaction(
                async (tx) => {
                    await tx.$executeRawUnsafe(`ALTER TABLE "TenantCustomRole" DROP CONSTRAINT "${BASE_ROLE_CHECK}"`);
                    for (const row of legacy) await insertRole(tx, row);
                    await tx.$executeRawUnsafe(
                        `ALTER TABLE "TenantCustomRole" ADD CONSTRAINT "${BASE_ROLE_CHECK}"
                         CHECK ("baseRole" NOT IN ('OWNER', 'AI_ADMIN')) NOT VALID`,
                    );
                    try {
                        for (const statement of statements) await tx.$executeRawUnsafe(statement);
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
