/**
 * `bulkSetControlStatus` / `bulkAssignControl` against a real database (#5376).
 *
 * Both verbs take a caller-supplied list of control ids and write with one
 * `updateMany`. What keeps a foreign tenant's control or a global library
 * control (tenantId NULL) out of that write is the repository's tenant
 * filter, and what keeps a stranger out of the owner column is the
 * active-member check. Neither had a behavioural test. These prove:
 *
 *   • a foreign-tenant id and a library id come back `not_found` and their
 *     rows are byte-for-byte unchanged (status, owner, updatedAt);
 *   • the owner must be an ACTIVE member of THIS tenant — a deactivated
 *     member, a member of another tenant only, and an unknown id are all
 *     refused with nothing written; `null` clears the owner;
 *   • exactly one audit row per control actually updated, none for the
 *     not_found ids;
 *   • a READER, and a custom role over EDITOR that withholds `controls.edit`,
 *     are refused before anything is written.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import { bulkSetControlStatus, bulkAssignControl } from '@/app-layer/usecases/control';
import { parsePermissionsJson } from '@/lib/permissions';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const TAG = `cbm-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const FOREIGN_TENANT_ID = `t-${TAG}-other`;

const userIds: string[] = [];
let admin = '';
let editor = '';
let deactivated = '';
let foreignOnly = '';

async function makeUser(label: string): Promise<string> {
    const email = `${TAG}-${label}@example.test`;
    const u = await globalPrisma.user.create({ data: { email, emailHash: hashForLookup(email) } });
    userIds.push(u.id);
    return u.id;
}

async function member(tenantId: string, userId: string, role: Role, status: MembershipStatus = MembershipStatus.ACTIVE) {
    await globalPrisma.tenantMembership.create({ data: { tenantId, userId, role, status } });
}

async function control(tenantId: string | null, name: string) {
    return globalPrisma.control.create({
        data: { tenantId, name: `${TAG} ${name}`, status: 'NOT_STARTED' },
    });
}

const ctx = (role: Role = Role.ADMIN, userId = admin) =>
    makeRequestContext(role, { tenantId: TENANT_ID, userId, tenantSlug: TAG });

async function auditRows(entityIds: string[], action: string) {
    return globalPrisma.auditLog.findMany({
        where: { tenantId: TENANT_ID, entity: 'Control', entityId: { in: entityIds }, action },
        select: { entityId: true },
    });
}

beforeAll(async () => {
    if (!DB_AVAILABLE) return;
    for (const [id, slug] of [[TENANT_ID, TAG], [FOREIGN_TENANT_ID, `${TAG}-other`]]) {
        await globalPrisma.tenant.create({ data: { id, name: `t ${slug}`, slug } });
    }
    admin = await makeUser('admin');
    editor = await makeUser('editor');
    deactivated = await makeUser('deactivated');
    foreignOnly = await makeUser('foreign');
    await member(TENANT_ID, admin, Role.ADMIN);
    await member(TENANT_ID, editor, Role.EDITOR);
    await member(TENANT_ID, deactivated, Role.EDITOR, MembershipStatus.DEACTIVATED);
    await member(FOREIGN_TENANT_ID, foreignOnly, Role.ADMIN);
});

afterAll(async () => {
    if (DB_AVAILABLE) {
        const tenants = { tenantId: { in: [TENANT_ID, FOREIGN_TENANT_ID] } };
        try { await globalPrisma.control.deleteMany({ where: tenants }); } catch { /* best effort */ }
        try { await globalPrisma.control.deleteMany({ where: { tenantId: null, name: { startsWith: TAG } } }); } catch { /* best effort */ }
        try { await globalPrisma.tenantMembership.deleteMany({ where: tenants }); } catch { /* best effort */ }
    }
    await globalPrisma.$disconnect();
});

describeFn('bulkSetControlStatus (integration)', () => {
    it('updates own controls; a foreign-tenant id and a library id are not_found and unchanged', async () => {
        const own1 = await control(TENANT_ID, 'own-1');
        const own2 = await control(TENANT_ID, 'own-2');
        const foreign = await control(FOREIGN_TENANT_ID, 'foreign');
        const library = await control(null, 'library');
        const foreignBefore = await globalPrisma.control.findUniqueOrThrow({ where: { id: foreign.id } });
        const libraryBefore = await globalPrisma.control.findUniqueOrThrow({ where: { id: library.id } });

        const out = await bulkSetControlStatus(ctx(), [own1.id, foreign.id, library.id, own2.id], 'IMPLEMENTED');

        expect(out.results).toEqual([
            { id: own1.id, status: 'ok' },
            { id: foreign.id, status: 'not_found' },
            { id: library.id, status: 'not_found' },
            { id: own2.id, status: 'ok' },
        ]);
        expect(out.updated).toBe(2);

        const own = await globalPrisma.control.findMany({ where: { id: { in: [own1.id, own2.id] } } });
        expect(own.map((c) => c.status)).toEqual(['IMPLEMENTED', 'IMPLEMENTED']);
        expect(await globalPrisma.control.findUniqueOrThrow({ where: { id: foreign.id } })).toEqual(foreignBefore);
        expect(await globalPrisma.control.findUniqueOrThrow({ where: { id: library.id } })).toEqual(libraryBefore);
    });

    it('writes exactly one CONTROL_STATUS_CHANGED row per updated control and none for not_found ids', async () => {
        const a = await control(TENANT_ID, 'audit-a');
        const b = await control(TENANT_ID, 'audit-b');
        const foreign = await control(FOREIGN_TENANT_ID, 'audit-foreign');

        await bulkSetControlStatus(ctx(), [a.id, b.id, foreign.id], 'IN_PROGRESS');

        const rows = await auditRows([a.id, b.id, foreign.id], 'CONTROL_STATUS_CHANGED');
        expect(rows.map((r) => r.entityId).sort()).toEqual([a.id, b.id].sort());
        const foreignRows = await globalPrisma.auditLog.count({ where: { entityId: foreign.id } });
        expect(foreignRows).toBe(0);
    });

    it('a list of only foreign and library ids writes nothing and audits nothing', async () => {
        const foreign = await control(FOREIGN_TENANT_ID, 'only-foreign');
        const library = await control(null, 'only-library');

        const out = await bulkSetControlStatus(ctx(), [foreign.id, library.id], 'IMPLEMENTED');

        expect(out.updated).toBe(0);
        expect(out.results.every((r) => r.status === 'not_found')).toBe(true);
        expect(await globalPrisma.auditLog.count({ where: { entityId: { in: [foreign.id, library.id] } } })).toBe(0);
    });

    it('refuses a READER and writes nothing', async () => {
        const c = await control(TENANT_ID, 'reader-status');
        await expect(bulkSetControlStatus(ctx(Role.READER), [c.id], 'IMPLEMENTED'))
            .rejects.toMatchObject({ status: 403 });
        expect((await globalPrisma.control.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('NOT_STARTED');
        expect(await auditRows([c.id], 'CONTROL_STATUS_CHANGED')).toEqual([]);
    });

    it('refuses a custom role over EDITOR that withholds controls.edit', async () => {
        const c = await control(TENANT_ID, 'custom-status');
        const custom = makeRequestContext(Role.EDITOR, {
            tenantId: TENANT_ID, userId: editor, tenantSlug: TAG,
            appPermissions: parsePermissionsJson({ controls: { edit: false } }, Role.EDITOR),
        });
        expect(custom.permissions.canWrite).toBe(true); // the coarse tier alone would admit it
        await expect(bulkSetControlStatus(custom, [c.id], 'IMPLEMENTED')).rejects.toMatchObject({ status: 403 });
        expect((await globalPrisma.control.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('NOT_STARTED');
    });
});

describeFn('bulkAssignControl (integration)', () => {
    it('assigns an active member; foreign-tenant and library ids are not_found and unchanged', async () => {
        const own = await control(TENANT_ID, 'assign-own');
        const foreign = await control(FOREIGN_TENANT_ID, 'assign-foreign');
        const library = await control(null, 'assign-library');
        const foreignBefore = await globalPrisma.control.findUniqueOrThrow({ where: { id: foreign.id } });
        const libraryBefore = await globalPrisma.control.findUniqueOrThrow({ where: { id: library.id } });

        const out = await bulkAssignControl(ctx(), [own.id, foreign.id, library.id], editor);

        expect(out.results).toEqual([
            { id: own.id, status: 'ok' },
            { id: foreign.id, status: 'not_found' },
            { id: library.id, status: 'not_found' },
        ]);
        expect(out.updated).toBe(1);
        expect((await globalPrisma.control.findUniqueOrThrow({ where: { id: own.id } })).ownerUserId).toBe(editor);
        expect(await globalPrisma.control.findUniqueOrThrow({ where: { id: foreign.id } })).toEqual(foreignBefore);
        expect(await globalPrisma.control.findUniqueOrThrow({ where: { id: library.id } })).toEqual(libraryBefore);
    });

    it.each([
        ['a DEACTIVATED member of this tenant', () => deactivated],
        ['a member of another tenant only', () => foreignOnly],
        ['an id that names no user', () => `no-such-user-${TAG}`],
    ])('refuses %s as owner and writes nothing', async (_label, ownerOf) => {
        const c = await control(TENANT_ID, `bad-owner-${randomUUID().slice(0, 6)}`);
        await expect(bulkAssignControl(ctx(), [c.id], ownerOf()))
            .rejects.toMatchObject({ status: 400, message: 'Owner must be an active member of this tenant' });
        expect((await globalPrisma.control.findUniqueOrThrow({ where: { id: c.id } })).ownerUserId).toBeNull();
        expect(await auditRows([c.id], 'CONTROL_OWNER_CHANGED')).toEqual([]);
    });

    it('null clears the owner', async () => {
        const c = await control(TENANT_ID, 'clear-owner');
        await bulkAssignControl(ctx(), [c.id], editor);
        await bulkAssignControl(ctx(), [c.id], null);
        expect((await globalPrisma.control.findUniqueOrThrow({ where: { id: c.id } })).ownerUserId).toBeNull();
    });

    it('writes exactly one CONTROL_OWNER_CHANGED row per updated control', async () => {
        const a = await control(TENANT_ID, 'owner-audit-a');
        const b = await control(TENANT_ID, 'owner-audit-b');
        const library = await control(null, 'owner-audit-library');

        await bulkAssignControl(ctx(), [a.id, b.id, library.id], admin);

        const rows = await auditRows([a.id, b.id, library.id], 'CONTROL_OWNER_CHANGED');
        expect(rows.map((r) => r.entityId).sort()).toEqual([a.id, b.id].sort());
    });

    it('refuses a READER and writes nothing', async () => {
        const c = await control(TENANT_ID, 'reader-assign');
        await expect(bulkAssignControl(ctx(Role.READER), [c.id], editor)).rejects.toMatchObject({ status: 403 });
        expect((await globalPrisma.control.findUniqueOrThrow({ where: { id: c.id } })).ownerUserId).toBeNull();
        expect(await auditRows([c.id], 'CONTROL_OWNER_CHANGED')).toEqual([]);
    });

    it('refuses a custom role over EDITOR that withholds controls.edit', async () => {
        const c = await control(TENANT_ID, 'custom-assign');
        const custom = makeRequestContext(Role.EDITOR, {
            tenantId: TENANT_ID, userId: editor, tenantSlug: TAG,
            appPermissions: parsePermissionsJson({ controls: { edit: false } }, Role.EDITOR),
        });
        await expect(bulkAssignControl(custom, [c.id], editor)).rejects.toMatchObject({ status: 403 });
        expect((await globalPrisma.control.findUniqueOrThrow({ where: { id: c.id } })).ownerUserId).toBeNull();
    });
});
