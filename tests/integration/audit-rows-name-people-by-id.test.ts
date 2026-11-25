/**
 * New audit rows name a person by id only (#5950, owner decision 2026-11-25),
 * over a real database and the real writers.
 *
 * An audit row is immutable and hash-chained, so a DSAR erasure cannot remove
 * what it says, and its `detailsJson` streams to the tenant's SIEM. Each
 * writer below used to put the person's e-mail address or name in `details`
 * or `detailsJson`. Each now names them by user id (`targetUserId`, or the
 * row's own `entityId` when that is the person's record), or by the record
 * that holds the address when the person has no account yet (an invite).
 *
 * For each writer: the row it writes carries no address and no name, and
 * carries the id. And the reader: the Audit log page's read resolves the id
 * to the person while they exist.
 */
import { randomBytes } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { __resetAuditStreamForTests } from '@/app-layer/events/audit-stream';
import { getPermissionsForRole } from '@/lib/permissions';
import { hashForLookup } from '@/lib/security/encryption';
import { createTenantWithOwner } from '@/app-layer/usecases/tenant-lifecycle';
import {
    deactivateTenantMember,
    removeTenantMember,
    updateTenantMemberRole,
} from '@/app-layer/usecases/tenant-admin';
import { assignCustomRole, createCustomRole } from '@/app-layer/usecases/custom-roles';
import { createInviteToken, revokeInvite } from '@/app-layer/usecases/tenant-invites';
import {
    grantAuditorAccess,
    inviteAuditor,
    revokeAuditorAccount,
} from '@/app-layer/usecases/audit-readiness/sharing';
import { scimCreateUser, scimDeleteUser, scimPatchUser } from '@/app-layer/usecases/scim-users';
import { listAuditLogPage } from '@/app-layer/usecases/auditLog';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(120_000);

const stamp = randomBytes(4).toString('hex');
const SLUG = `ids-only-${stamp}`;
const OWNER_EMAIL = `ids-only-owner-${stamp}@example.test`;

describeFn('audit rows name a person by id only (#5950)', () => {
    let prisma: PrismaClient;
    let tenantId: string;
    let ownerCtx: ReturnType<typeof makeRequestContext>;

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        const created = await createTenantWithOwner({
            name: `Ids only ${stamp}`,
            slug: SLUG,
            ownerEmail: OWNER_EMAIL,
            requestId: `req-${stamp}`,
        });
        tenantId = created.tenant.id;
        ownerCtx = makeRequestContext('OWNER', {
            userId: created.ownerUserId,
            tenantId,
            tenantSlug: SLUG,
            appPermissions: getPermissionsForRole('OWNER'),
        });
    });

    afterAll(async () => {
        if (tenantId) await deleteAuditRowsForTenants(prisma, tenantId);
        await prisma.$disconnect();
        __resetAuditStreamForTests();
    });

    /** A person with an address and a name, and an EDITOR membership in the tenant. */
    async function member(label: string) {
        const email = `ids-only-${label}-${stamp}@example.test`;
        const name = `Person ${label} ${stamp}`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email), name } });
        const membership = await prisma.tenantMembership.create({
            data: { tenantId, userId: user.id, role: 'EDITOR', status: 'ACTIVE' },
        });
        return { userId: user.id, membershipId: membership.id, email, name };
    }

    /** The newest row of an action in the tenant. */
    async function rowOf(action: string) {
        return prisma.auditLog.findFirstOrThrow({
            where: { tenantId, action },
            orderBy: { createdAt: 'desc' },
        });
    }

    /** What the row stores about anybody: its text and its structured payload. */
    function stored(row: { details: string | null; detailsJson: unknown; metadataJson?: unknown }): string {
        return JSON.stringify({ details: row.details, detailsJson: row.detailsJson, metadataJson: row.metadataJson ?? null });
    }

    function expectIdsOnly(
        row: { details: string | null; detailsJson: unknown; metadataJson?: unknown },
        person: { email: string; name?: string },
    ) {
        const text = stored(row);
        expect(text).not.toContain(person.email);
        if (person.name) expect(text).not.toContain(person.name);
    }

    it('TENANT_CREATED names the owner by ownerUserId, never by address', async () => {
        const row = await rowOf('TENANT_CREATED');
        expect((row.detailsJson as { ownerUserId?: string }).ownerUserId).toBe(ownerCtx.userId);
        expectIdsOnly(row, { email: OWNER_EMAIL });
    });

    it('MEMBER_ROLE_CHANGED and MEMBER_CUSTOM_ROLE_CHANGED name the member by targetUserId', async () => {
        const m = await member('role');
        await updateTenantMemberRole(ownerCtx, { membershipId: m.membershipId, role: 'READER' });
        const roleRow = await rowOf('MEMBER_ROLE_CHANGED');
        expect((roleRow.detailsJson as { targetUserId?: string }).targetUserId).toBe(m.userId);
        expectIdsOnly(roleRow, m);

        const customRole = await createCustomRole(ownerCtx, {
            name: `Readers ${stamp}`,
            baseRole: 'READER',
            permissionsJson: getPermissionsForRole('READER'),
        });
        await assignCustomRole(ownerCtx, m.membershipId, customRole.id);
        const customRow = await rowOf('MEMBER_CUSTOM_ROLE_CHANGED');
        expect((customRow.detailsJson as { targetUserId?: string }).targetUserId).toBe(m.userId);
        expectIdsOnly(customRow, m);
    });

    it('MEMBER_DEACTIVATED and MEMBER_REMOVED name the member by targetUserId, no address in details', async () => {
        const a = await member('deact');
        await deactivateTenantMember(ownerCtx, { membershipId: a.membershipId });
        const deactivated = await rowOf('MEMBER_DEACTIVATED');
        expect((deactivated.detailsJson as { targetUserId?: string }).targetUserId).toBe(a.userId);
        expectIdsOnly(deactivated, a);

        const b = await member('remove');
        await removeTenantMember(ownerCtx, { membershipId: b.membershipId });
        const removed = await rowOf('MEMBER_REMOVED');
        expect((removed.detailsJson as { targetUserId?: string }).targetUserId).toBe(b.userId);
        expectIdsOnly(removed, b);
    });

    it('MEMBER_INVITED and MEMBER_INVITE_REVOKED name the INVITE, never the invitee\'s address', async () => {
        const email = `ids-only-invitee-${stamp}@example.test`;
        const { invite } = await createInviteToken(ownerCtx, { email, role: 'READER' });
        const invited = await rowOf('MEMBER_INVITED');
        expect(invited.entityId).toBe(invite.id);
        expectIdsOnly(invited, { email });

        await revokeInvite(ownerCtx, { inviteId: invite.id });
        const revoked = await rowOf('MEMBER_INVITE_REVOKED');
        expect(revoked.entityId).toBe(invite.id);
        expectIdsOnly(revoked, { email });
    });

    it('the auditor rows name the auditor by account id, never by address or name', async () => {
        const email = `ids-only-auditor-${stamp}@example.test`;
        const name = `Auditor ${stamp}`;
        const auditor = await inviteAuditor(ownerCtx, email, name);
        const invited = await rowOf('AUDITOR_INVITED');
        expect((invited.detailsJson as { targetUserId?: string }).targetUserId).toBe(auditor.id);
        expectIdsOnly(invited, { email, name });

        const cycle = await prisma.auditCycle.create({
            data: { tenantId, frameworkKey: 'ISO27001', frameworkVersion: '2022', name: `Cycle ${stamp}`, createdByUserId: ownerCtx.userId },
        });
        const pack = await prisma.auditPack.create({
            data: { tenantId, auditCycleId: cycle.id, name: `Pack ${stamp}`, status: 'FROZEN', frozenAt: new Date() },
        });
        await grantAuditorAccess(ownerCtx, auditor.id, pack.id);
        const granted = await rowOf('AUDITOR_GRANTED');
        expect((granted.detailsJson as { targetUserId?: string }).targetUserId).toBe(auditor.id);
        expectIdsOnly(granted, { email, name });

        await revokeAuditorAccount(ownerCtx, auditor.id);
        const revoked = await rowOf('AUDITOR_ACCOUNT_REVOKED');
        expect((revoked.detailsJson as { targetUserId?: string }).targetUserId).toBe(auditor.id);
        expectIdsOnly(revoked, { email, name });
    });

    it('the SCIM rows name the person by entityId (their user id): no address, userName or name', async () => {
        const scim = { tenantId, tokenId: `tok-${stamp}`, tokenLabel: 'idp' };
        const email = `ids-only-scim-${stamp}@example.test`;
        const name = `Scim Person ${stamp}`;
        const { user } = await scimCreateUser(scim, { userName: email, displayName: name }, 'https://inflect.example/api/scim/v2');
        const created = await rowOf('SCIM_USER_CREATED');
        expect(created.entityId).toBe(user.id);
        expectIdsOnly(created, { email, name });

        const renamed = `Renamed Person ${stamp}`;
        await scimPatchUser(scim, user.id, [{ op: 'replace', path: 'displayName', value: renamed }], 'https://inflect.example/api/scim/v2');
        const updated = await rowOf('SCIM_USER_UPDATED');
        expect(updated.entityId).toBe(user.id);
        expectIdsOnly(updated, { email, name: renamed });
        // The attribute that changed is still named; its value is not.
        expect((updated.detailsJson as { changes?: string[] }).changes).toContain('displayName');

        await scimDeleteUser(scim, user.id);
        const deactivated = await rowOf('SCIM_USER_DEACTIVATED');
        expect(deactivated.entityId).toBe(user.id);
        expectIdsOnly(deactivated, { email, name: renamed });
    });

    it('the Audit log page resolves the id to the person while they exist', async () => {
        const m = await member('reader');
        await updateTenantMemberRole(ownerCtx, { membershipId: m.membershipId, role: 'READER' });
        const page = await listAuditLogPage(ownerCtx);
        const roleRow = page.rows.find(
            (r) => r.action === 'MEMBER_ROLE_CHANGED' && r.person?.id === m.userId,
        );
        expect(roleRow?.person).toEqual({ id: m.userId, label: m.name });

        // An invite row resolves to the invite's address, from the invite.
        const email = `ids-only-page-invitee-${stamp}@example.test`;
        const { invite } = await createInviteToken(ownerCtx, { email, role: 'READER' });
        const after = await listAuditLogPage(ownerCtx);
        const inviteRow = after.rows.find((r) => r.action === 'MEMBER_INVITED' && r.entityId === invite.id);
        expect(inviteRow?.person).toEqual({ id: invite.id, label: email });
    });
});
