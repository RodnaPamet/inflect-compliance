/**
 * The migration that switches the ten admin-membership-only keys off in custom
 * roles carried ONLY by memberships that are not ADMIN, run from the migration
 * file itself against a real database.
 *
 * Owner decisions, 2026-10-30: a custom role granting one of
 * `ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS` may be carried only by an ADMIN
 * membership. The writers refuse a new such carriage; the migration settles the
 * roles already stored. The SQL is read OUT OF the migration and executed, not
 * re-typed. Pinned here:
 *
 *   - a role carried only by READER, EDITOR or AUDITOR memberships, of any
 *     status, in either tenant, ends with all ten keys stated `false`, and every
 *     other key of its blob — the rest of `admin` included — is what it was; its
 *     base is unchanged;
 *   - an ADMIN-based role carried that way is switched off too, including one
 *     whose blob has no `admin` domain (it would read ADMIN's defaults);
 *   - a role with ANY ADMIN carrier (a deactivated one included), a role nobody
 *     carries, and a role that already grants none of the ten as a request
 *     reads it are not touched at all (blob AND `updatedAt`);
 *   - a second run changes nothing anywhere in the table;
 *   - a legacy OWNER- or AI_ADMIN-based row under a NOT VALID #3734 CHECK does
 *     not make the migration fail, and is not touched.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { MembershipStatus, PrismaClient, Role } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { getPermissionsForRole, parsePermissionsJson } from '@/lib/permissions';
import { ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS } from '@/lib/roles';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const MIGRATION = path.resolve(
    __dirname,
    '../../prisma/migrations/20261030150000_admin_membership_only_keys_off_for_non_admin_custom_roles/migration.sql',
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

type Blob = Record<string, unknown>;
type Admin = Record<string, unknown>;

const TEN_OFF = Object.fromEntries(ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS.map((k) => [k, false]));

/** A whole stored blob: `base`'s defaults with `admin` keys set as given. */
function presetBlob(base: 'ADMIN' | 'EDITOR' | 'AUDITOR' | 'READER', admin: Admin = {}): Blob {
    const d = getPermissionsForRole(base);
    return { ...d, admin: { ...d.admin, ...admin } };
}

/** The same blob with only the ten keys stated `false`, the `admin` domain created if absent. */
function withTenOff(blob: Blob): Blob {
    const admin = typeof blob.admin === 'object' && blob.admin !== null ? (blob.admin as Admin) : {};
    return { ...blob, admin: { ...admin, ...TEN_OFF } };
}

const SEEDED_UPDATED_AT = new Date('2026-01-01T00:00:00.000Z');

describeFn('the ten admin-membership-only keys off for roles only non-Admins carry (migration, real DB)', () => {
    let prisma: PrismaClient;
    const tag = `amomig-${randomUUID().slice(0, 8)}`;
    const tenantA = `${tag}-a`;
    const tenantB = `${tag}-b`;
    const roleIds: string[] = [];
    const userIds: string[] = [];

    type Carrier = { role: Role; status?: MembershipStatus };
    type Seed = {
        id: string;
        tenantId: string;
        baseRole: string;
        isActive: boolean;
        blob: unknown;
        carriers: Carrier[];
    };

    async function insertRole(db: { $executeRawUnsafe: PrismaClient['$executeRawUnsafe'] }, seed: Seed) {
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

    /** One membership per carrier, each for a user of its own. */
    async function insertCarriers(
        db: { user: PrismaClient['user']; tenantMembership: PrismaClient['tenantMembership'] },
        seed: Seed,
    ) {
        for (const [i, carrier] of seed.carriers.entries()) {
            const { id: userId } = await db.user.create({
                data: { email: `${seed.id}-u${i}@example.com`, name: `${seed.id}-u${i}` },
                select: { id: true },
            });
            userIds.push(userId);
            await db.tenantMembership.create({
                data: {
                    tenantId: seed.tenantId,
                    userId,
                    role: carrier.role,
                    status: carrier.status ?? 'ACTIVE',
                    customRoleId: seed.id,
                },
            });
        }
    }

    async function readRole(
        db: { $queryRawUnsafe: PrismaClient['$queryRawUnsafe'] },
        id: string,
    ): Promise<{ baseRole: string; blob: unknown; updatedAt: Date }> {
        const rows = await db.$queryRawUnsafe<Array<{ baseRole: string; blob: unknown; updatedAt: Date }>>(
            `SELECT "baseRole"::text AS "baseRole", "permissionsJson" AS blob, "updatedAt" FROM "TenantCustomRole" WHERE id = $1`,
            id,
        );
        expect(rows).toHaveLength(1);
        return rows[0];
    }

    const seeds: Record<string, Seed> = {};
    function seed(key: string, s: Omit<Seed, 'id'>): Seed {
        const row = { ...s, id: `${tag}-${key}` };
        seeds[key] = row;
        roleIds.push(row.id);
        return row;
    }

    const READER: Carrier = { role: 'READER' };

    // ── Switched off ──
    // One of the six and one of the four, carried by a READER.
    seed('reader', { tenantId: tenantA, baseRole: 'READER', isActive: true, blob: presetBlob('READER', { sso: true, scim: true }), carriers: [READER] });
    // Mixed carriers, none ADMIN.
    seed('editor', {
        tenantId: tenantA,
        baseRole: 'EDITOR',
        isActive: true,
        blob: presetBlob('EDITOR', { compliance_dsar_manage: true, agent_external_tools: true }),
        carriers: [{ role: 'EDITOR' }, { role: 'AUDITOR' }],
    });
    // Its only carrier is deactivated: status does not matter.
    seed('auditor-deactivated-carrier', {
        tenantId: tenantA,
        baseRole: 'AUDITOR',
        isActive: true,
        blob: presetBlob('AUDITOR', { agent_harness_ingest: true }),
        carriers: [{ role: 'READER', status: 'DEACTIVATED' }],
    });
    // An authoring grant a request DERIVES from the review key (the blob predates
    // `agent_skill_author`): stating both false is what switches it off.
    const derived = presetBlob('READER', { agent_skill_review: true });
    delete (derived.admin as Admin).agent_skill_author;
    seed('reader-derived-author', { tenantId: tenantA, baseRole: 'READER', isActive: true, blob: derived, carriers: [READER] });
    // ADMIN base, carried by a READER: nine of the ten by default. The base stays.
    seed('admin-base', { tenantId: tenantA, baseRole: 'ADMIN', isActive: true, blob: presetBlob('ADMIN'), carriers: [READER] });
    // ADMIN base with no `admin` domain: it reads ADMIN's defaults, so it grants.
    const noAdminDomain = presetBlob('ADMIN');
    delete noAdminDomain.admin;
    seed('admin-base-no-domain', { tenantId: tenantA, baseRole: 'ADMIN', isActive: true, blob: noAdminDomain, carriers: [{ role: 'EDITOR' }] });
    // ADMIN base stating a key as a string: not a boolean, so it reads the default.
    seed('admin-base-string', {
        tenantId: tenantB,
        baseRole: 'ADMIN',
        isActive: true,
        blob: { ...presetBlob('ADMIN', TEN_OFF), admin: { ...presetBlob('ADMIN', TEN_OFF).admin as Admin, sso: 'false' } },
        carriers: [READER],
    });
    seed('reader-tenant-b', { tenantId: tenantB, baseRole: 'READER', isActive: true, blob: presetBlob('READER', { agent_tool_exposure: true }), carriers: [READER] });
    seed('reader-inactive', { tenantId: tenantB, baseRole: 'READER', isActive: false, blob: presetBlob('READER', { agent_policy_card: true }), carriers: [{ role: 'READER', status: 'REMOVED' }] });
    // Each of the ten on its own, on every base the migration judges, so no key
    // can drop out of either of its two lists unnoticed.
    const NON_ADMIN_BASES = ['READER', 'EDITOR', 'AUDITOR'] as const;
    const ONE_KEY: string[] = [];
    for (const [i, k] of ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS.entries()) {
        const base = NON_ADMIN_BASES[i % NON_ADMIN_BASES.length];
        seed(`only-${k}`, { tenantId: tenantB, baseRole: base, isActive: true, blob: presetBlob(base, { ...TEN_OFF, [k]: true }), carriers: [READER] });
        seed(`admin-only-${k}`, { tenantId: tenantB, baseRole: 'ADMIN', isActive: true, blob: presetBlob('ADMIN', { ...TEN_OFF, [k]: true }), carriers: [READER] });
        ONE_KEY.push(`only-${k}`, `admin-only-${k}`);
    }
    const SWITCHED_OFF = [
        ...ONE_KEY,
        'reader',
        'editor',
        'auditor-deactivated-carrier',
        'reader-derived-author',
        'admin-base',
        'admin-base-no-domain',
        'admin-base-string',
        'reader-tenant-b',
        'reader-inactive',
    ];

    // ── Left exactly as they were ──
    // Any ADMIN carrier keeps the role whole, a deactivated one included.
    seed('mixed-with-admin', {
        tenantId: tenantA,
        baseRole: 'READER',
        isActive: true,
        blob: presetBlob('READER', { sso: true, scim: true }),
        carriers: [READER, { role: 'ADMIN', status: 'DEACTIVATED' }],
    });
    seed('admin-carried', { tenantId: tenantA, baseRole: 'ADMIN', isActive: true, blob: presetBlob('ADMIN'), carriers: [{ role: 'ADMIN' }] });
    // Nobody carries it.
    seed('no-carriers', { tenantId: tenantA, baseRole: 'READER', isActive: true, blob: presetBlob('READER', { agent_ownership: true }), carriers: [] });
    // Grants none of the ten as a request reads it.
    seed('reader-already-off', { tenantId: tenantA, baseRole: 'READER', isActive: true, blob: presetBlob('READER', TEN_OFF), carriers: [READER] });
    seed('reader-string-true', { tenantId: tenantB, baseRole: 'READER', isActive: true, blob: presetBlob('READER', { sso: 'true' }), carriers: [READER] });
    const missingKeys = presetBlob('READER');
    delete (missingKeys.admin as Admin).scim;
    delete (missingKeys.admin as Admin).agent_skill_author;
    seed('reader-missing-keys', { tenantId: tenantB, baseRole: 'READER', isActive: true, blob: missingKeys, carriers: [READER] });
    seed('admin-base-all-off', { tenantId: tenantB, baseRole: 'ADMIN', isActive: true, blob: presetBlob('ADMIN', TEN_OFF), carriers: [READER] });
    const UNTOUCHED = [
        'mixed-with-admin',
        'admin-carried',
        'no-carriers',
        'reader-already-off',
        'reader-string-true',
        'reader-missing-keys',
        'admin-base-all-off',
    ];

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        for (const id of [tenantA, tenantB]) {
            await prisma.tenant.create({ data: { id, name: id, slug: id } });
        }
        for (const s of Object.values(seeds)) {
            await insertRole(prisma, s);
            await insertCarriers(prisma, s);
        }
    });

    afterAll(async () => {
        await prisma.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" = ANY($1::text[])`, [tenantA, tenantB]);
        await prisma.$executeRawUnsafe(`DELETE FROM "TenantCustomRole" WHERE id = ANY($1::text[])`, roleIds);
        await prisma.user.deleteMany({ where: { id: { in: userIds } } });
        await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
        await prisma.$disconnect();
    });

    it('the population is what the cases say it is', () => {
        expect([...SWITCHED_OFF, ...UNTOUCHED].sort()).toEqual(Object.keys(seeds).sort());
        // Every switched-off seed grants at least one of the ten as a request reads it…
        for (const key of SWITCHED_OFF) {
            const parsed = parsePermissionsJson(seeds[key].blob, seeds[key].baseRole as Role).admin as Admin;
            expect({ key, grants: ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS.some((k) => parsed[k] === true) }).toEqual({ key, grants: true });
        }
        // …and so does every untouched one whose reason is its carriers.
        for (const key of ['mixed-with-admin', 'admin-carried', 'no-carriers']) {
            const parsed = parsePermissionsJson(seeds[key].blob, seeds[key].baseRole as Role).admin as Admin;
            expect({ key, grants: ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS.some((k) => parsed[k] === true) }).toEqual({ key, grants: true });
        }
    });

    it('switches the ten off where only non-Admins carry the role, touches nothing else, and a second run changes nothing', async () => {
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
            // The whole blob, so a change to any other key — the rest of the
            // `admin` domain included — fails here, not only a wrong one of the ten.
            expect({ key, blob: after[key].blob }).toEqual({ key, blob: withTenOff(seeds[key].blob as Blob) });
            expect({ key, base: after[key].baseRole }).toEqual({ key, base: seeds[key].baseRole });
            expect(after[key].updatedAt.getTime()).toBeGreaterThan(SEEDED_UPDATED_AT.getTime());
            // What a member carrying the role is now allowed, through the same
            // parse the request context uses.
            const admin = parsePermissionsJson(after[key].blob, seeds[key].baseRole as Role).admin as Admin;
            expect({ key, granted: ADMIN_MEMBERSHIP_ONLY_ADMIN_KEYS.filter((k) => admin[k] === true) }).toEqual({ key, granted: [] });
        }
        // An ADMIN base keeps everything else it grants.
        for (const key of ['admin-base', 'admin-base-no-domain']) {
            const admin = parsePermissionsJson(after[key].blob, 'ADMIN').admin;
            expect({ key, manage: admin.manage, members: admin.members, view: admin.view }).toEqual({
                key,
                manage: true,
                members: true,
                view: true,
            });
        }

        for (const key of UNTOUCHED) {
            expect({ key, row: after[key] }).toEqual({ key, row: before[key] });
        }

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
        const legacy: Seed[] = [
            { id: `${tag}-legacy-owner`, tenantId: tenantA, baseRole: 'OWNER', isActive: true, blob: presetBlob('READER', { sso: true }), carriers: [READER] },
            { id: `${tag}-legacy-ai-admin`, tenantId: tenantA, baseRole: 'AI_ADMIN', isActive: true, blob: presetBlob('READER', { scim: true }), carriers: [READER] },
        ];

        await prisma
            .$transaction(
                async (tx) => {
                    // The state #3734's WARNING branch leaves: the CHECK present
                    // but NOT VALID over rows built on OWNER and AI_ADMIN.
                    await tx.$executeRawUnsafe(`ALTER TABLE "TenantCustomRole" DROP CONSTRAINT "${BASE_ROLE_CHECK}"`);
                    for (const row of legacy) {
                        await insertRole(tx, row);
                        await insertCarriers(tx, row);
                    }
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
            rows: legacy.map((row) => ({ baseRole: row.baseRole, blob: row.blob, updatedAt: SEEDED_UPDATED_AT })),
        });
        const constraint = await prisma.$queryRawUnsafe<Array<{ convalidated: boolean }>>(
            `SELECT convalidated FROM pg_constraint WHERE conname = $1`,
            BASE_ROLE_CHECK,
        );
        expect(constraint).toEqual([{ convalidated: true }]);
    });
});
