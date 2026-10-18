/**
 * Assigning AI_ADMIN against a real database (#3699 deploy 2), across two
 * tenants.
 *
 * The role's two writers are the members-page role change and an Entra group
 * mapping. A mocked repository cannot establish the properties that matter
 * here, so each is shown on real rows:
 *
 *   - the value round-trips through Postgres and the generated client (the
 *     rolling-deploy hazard deploy 1 existed for), and the change is audited
 *     as MEMBER_ROLE_CHANGED in the tenant it happened in;
 *   - an OWNER of tenant A cannot reach tenant B's membership, and a mapping
 *     in tenant A promotes nobody in tenant B — not even the same person;
 *   - an ADMIN can neither assign nor remove the role, and cannot create a
 *     mapping to it;
 *   - a membership never ends up as AI_ADMIN with a custom role, in either
 *     order.
 *
 * The role is spelled as the literal `'AI_ADMIN'` rather than `Role.AI_ADMIN`,
 * as the deploy-1 suites do, so a runner whose generated client predates the
 * value fails with Prisma's own message rather than a TypeError.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { getPermissionsForRole } from '@/lib/permissions';
import type { PrismaClient, Role } from '@prisma/client';

import { updateTenantMemberRole } from '@/app-layer/usecases/tenant-admin';
import { assignCustomRole, createCustomRole } from '@/app-layer/usecases/custom-roles';
import { createEntraGroupMapping } from '@/app-layer/usecases/entra-group-mappings';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import { syncEntraMembershipRole } from '@/lib/auth/entra-group-sync';
import { SCIM_GROUP_ASSIGNABLE_ROLES } from '@/lib/scim/roles';
import { BUILT_IN_SCOPE_REFUSAL } from '@/lib/roles';

const describeFn = DB_AVAILABLE ? describe : describe.skip;

const AI_ADMIN = 'AI_ADMIN' as Role;
const AI_ADMIN_GROUP = '0a1b2c3d-0000-4000-8000-00000000a1ad';

describeFn('AI_ADMIN assignment (real DB, two tenants)', () => {
    let prisma: PrismaClient;
    const stamp = Date.now();

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
    });

    // No teardown deletes. Every tenant and user here is under a per-run slug,
    // the tenants' last-OWNER trigger refuses a bare membership delete, and a
    // tenant or user delete would first need its audit rows cleared with the
    // immutability triggers off (`tests/guards/integration-suite-audit-teardown.test.ts`).
    // `resetDatabase` truncates, so leaving the rows costs nothing.
    afterAll(async () => {
        await prisma.$disconnect();
    });

    async function tenant(suffix: string) {
        const slug = `ai-admin-d2-${suffix}-${stamp}`;
        const ownerEmail = `ai-admin-d2-owner-${suffix}-${stamp}@example.com`;
        const result = await createTenantWithOwner({
            name: `AI admin d2 ${suffix}`,
            slug,
            ownerEmail,
            requestId: `req-${suffix}`,
        });
        const ownerCtx = makeRequestContext('OWNER', {
            userId: result.ownerUserId,
            tenantId: result.tenant.id,
            tenantSlug: slug,
            appPermissions: getPermissionsForRole('OWNER'),
        });
        return { tenantId: result.tenant.id, slug, ownerCtx };
    }

    async function user(suffix: string) {
        const email = `ai-admin-d2-${suffix}-${stamp}@example.com`;
        return prisma.user.create({ data: { email, name: suffix }, select: { id: true } });
    }

    async function member(tenantId: string, userId: string, role: Role) {
        return prisma.tenantMembership.create({
            data: { tenantId, userId, role, status: 'ACTIVE' },
            select: { id: true },
        });
    }

    const roleOf = async (membershipId: string) =>
        (await prisma.tenantMembership.findUniqueOrThrow({
            where: { id: membershipId },
            select: { role: true, customRoleId: true },
        }));

    it('the members-page role change: an OWNER promotes and demotes in their own tenant only, audited there', async () => {
        const a = await tenant('a1');
        const b = await tenant('b1');
        const person = await user('person-1');
        const inA = await member(a.tenantId, person.id, 'READER');
        const inB = await member(b.tenantId, person.id, 'READER');

        await updateTenantMemberRole(a.ownerCtx, { membershipId: inA.id, role: AI_ADMIN });
        expect(await roleOf(inA.id)).toEqual({ role: 'AI_ADMIN', customRoleId: null });

        const audit = await prisma.auditLog.findFirst({
            where: { tenantId: a.tenantId, entityId: inA.id, action: 'MEMBER_ROLE_CHANGED' },
            select: { tenantId: true },
        });
        expect(audit).toEqual({ tenantId: a.tenantId });

        // Tenant A's OWNER cannot reach tenant B's row of the same person.
        await expect(
            updateTenantMemberRole(a.ownerCtx, { membershipId: inB.id, role: AI_ADMIN }),
        ).rejects.toThrow(/not found/i);
        expect(await roleOf(inB.id)).toEqual({ role: 'READER', customRoleId: null });
        expect(
            await prisma.auditLog.count({ where: { tenantId: b.tenantId, entityId: inB.id } }),
        ).toBe(0);

        await updateTenantMemberRole(a.ownerCtx, { membershipId: inA.id, role: 'EDITOR' });
        expect((await roleOf(inA.id)).role).toBe('EDITOR');
    });

    it('an ADMIN can neither assign nor remove it', async () => {
        const a = await tenant('a2');
        const adminUser = await user('admin-2');
        await member(a.tenantId, adminUser.id, 'ADMIN');
        const adminCtx = makeRequestContext('ADMIN', {
            userId: adminUser.id,
            tenantId: a.tenantId,
            tenantSlug: a.slug,
            appPermissions: getPermissionsForRole('ADMIN'),
        });
        const reader = await member(a.tenantId, (await user('reader-2')).id, 'READER');
        const aiAdmin = await member(a.tenantId, (await user('ai-2')).id, AI_ADMIN);

        await expect(
            updateTenantMemberRole(adminCtx, { membershipId: reader.id, role: AI_ADMIN }),
        ).rejects.toThrow(/Only an OWNER can assign or remove the AI_ADMIN role/);
        await expect(
            updateTenantMemberRole(adminCtx, { membershipId: aiAdmin.id, role: 'READER' }),
        ).rejects.toThrow(/Only an OWNER can assign or remove the AI_ADMIN role/);
        expect((await roleOf(reader.id)).role).toBe('READER');
        expect((await roleOf(aiAdmin.id)).role).toBe('AI_ADMIN');

        await expect(
            createEntraGroupMapping(adminCtx, { aadGroupId: AI_ADMIN_GROUP, role: AI_ADMIN }),
        ).rejects.toThrow(/Only an OWNER can assign or remove the AI_ADMIN role/);
        expect(await prisma.tenantEntraGroupMapping.count({ where: { tenantId: a.tenantId } })).toBe(0);
    });

    it('no custom role on an AI_ADMIN membership, in either order', async () => {
        const a = await tenant('a3');
        const custom = await createCustomRole(a.ownerCtx, {
            name: `Reviewers ${stamp}`,
            baseRole: 'READER',
            permissionsJson: getPermissionsForRole('READER'),
        });
        const withCustom = await member(a.tenantId, (await user('custom-3')).id, 'EDITOR');
        await assignCustomRole(a.ownerCtx, withCustom.id, custom.id);

        await expect(
            updateTenantMemberRole(a.ownerCtx, { membershipId: withCustom.id, role: AI_ADMIN }),
        ).rejects.toMatchObject({ status: 409, details: { reason: BUILT_IN_SCOPE_REFUSAL } });
        expect(await roleOf(withCustom.id)).toEqual({ role: 'EDITOR', customRoleId: custom.id });

        const aiAdmin = await member(a.tenantId, (await user('ai-3')).id, AI_ADMIN);
        await expect(assignCustomRole(a.ownerCtx, aiAdmin.id, custom.id)).rejects.toMatchObject({
            status: 409,
            details: { reason: BUILT_IN_SCOPE_REFUSAL },
        });
        expect(await roleOf(aiAdmin.id)).toEqual({ role: 'AI_ADMIN', customRoleId: null });

        // The way through: remove the custom role, then promote.
        await assignCustomRole(a.ownerCtx, withCustom.id, null);
        await updateTenantMemberRole(a.ownerCtx, { membershipId: withCustom.id, role: AI_ADMIN });
        expect(await roleOf(withCustom.id)).toEqual({ role: 'AI_ADMIN', customRoleId: null });
    });

    it.each([
        ['at sign-in', undefined],
        ['on a SCIM Groups push', SCIM_GROUP_ASSIGNABLE_ROLES],
    ] as const)('an Entra mapping in tenant A promotes the member %s — and nobody in tenant B', async (label, ceiling) => {
        const tag = label === 'at sign-in' ? 'a4' : 'a5';
        const a = await tenant(tag);
        const b = await tenant(`b-${tag}`);
        const person = await user(`person-${tag}`);
        const inA = await member(a.tenantId, person.id, 'READER');
        const inB = await member(b.tenantId, person.id, 'READER');
        const carriesCustom = await member(a.tenantId, (await user(`custom-${tag}`)).id, 'READER');
        const custom = await createCustomRole(a.ownerCtx, {
            name: `Mapped ${tag} ${stamp}`,
            baseRole: 'READER',
            permissionsJson: getPermissionsForRole('READER'),
        });
        await assignCustomRole(a.ownerCtx, carriesCustom.id, custom.id);

        await createEntraGroupMapping(a.ownerCtx, { aadGroupId: AI_ADMIN_GROUP, role: AI_ADMIN });

        const inTenantA = await syncEntraMembershipRole({
            userId: person.id,
            tenantId: a.tenantId,
            aadGroups: [AI_ADMIN_GROUP],
            assignableRoles: ceiling,
        });
        expect(inTenantA).toEqual({ effectiveRole: 'AI_ADMIN', changed: true, gateDenied: false });
        expect((await roleOf(inA.id)).role).toBe('AI_ADMIN');

        // Same person, same group claim, other tenant: B mapped nothing.
        const inTenantB = await syncEntraMembershipRole({
            userId: person.id,
            tenantId: b.tenantId,
            aadGroups: [AI_ADMIN_GROUP],
            assignableRoles: ceiling,
        });
        expect(inTenantB.changed).toBe(false);
        expect((await roleOf(inB.id)).role).toBe('READER');

        // A member carrying a custom role is held where they are.
        const held = await syncEntraMembershipRole({
            userId: (await prisma.tenantMembership.findUniqueOrThrow({
                where: { id: carriesCustom.id },
                select: { userId: true },
            })).userId,
            tenantId: a.tenantId,
            aadGroups: [AI_ADMIN_GROUP],
            assignableRoles: ceiling,
        });
        expect(held.changed).toBe(false);
        expect(await roleOf(carriesCustom.id)).toEqual({ role: 'READER', customRoleId: custom.id });
    });
});
