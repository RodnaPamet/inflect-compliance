/**
 * SCIM PATCH with Microsoft Entra's exact payload shapes, against a real
 * database (#5370).
 *
 * RFC 7644 §3.5.2 makes the PatchOp `op` case-insensitive, and Entra sends
 * `"Add"` / `"Remove"` / `"Replace"`, removes a group member by filter
 * (`members[value eq "<id>"]`), and sends booleans as the strings `"True"` /
 * `"False"`. Both patch usecases compared `op` with `===` against the
 * lower-case literals, so every one of these was silently dropped: a person
 * removed from a role-mapped group kept the role, and a user disabled in Entra
 * stayed ACTIVE. `"True"` was worse than dropped — it DEACTIVATED.
 *
 * Each assertion reads the membership row back after the patch, because the
 * defect returned 200 with nothing changed: only the stored state shows it.
 */
import { randomUUID } from 'crypto';
import { NextRequest } from 'next/server';
import { PrismaClient, type Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { hashToken } from '@/lib/scim/auth';
import { TENANT_TX_OPTIONS } from '@/lib/db/concurrency-limits';
import { scimCreateGroup, scimPatchGroup } from '@/app-layer/usecases/scim-groups';
import { scimPatchUser } from '@/app-layer/usecases/scim-users';
import { PATCH as UserPatchRoute } from '@/app/api/scim/v2/Users/[id]/route';
import { PATCH as GroupPatchRoute } from '@/app/api/scim/v2/Groups/[id]/route';

const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
    transactionOptions: TENANT_TX_OPTIONS,
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const TAG = `scim-entra-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${TAG}`;
const RAW_TOKEN = `scim-token-${TAG}`;
const BASE_URL = 'http://localhost:3000';
const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

let providerId: string;
let tokenId: string;
const scimCtx = () => ({ tenantId: TENANT_ID, tokenId, tokenLabel: 'Entra' });

// No teardown deletes: every row is keyed by a per-run tag or a fresh UUID, so
// a later run cannot collide with it, and deleting the tenant would first need
// its audit rows cleared (tests/guards/integration-suite-audit-teardown.test.ts).
afterAll(async () => {
    await db.$disconnect();
});

describeFn('SCIM PATCH — Entra payload shapes (real DB)', () => {
    beforeAll(async () => {
        await db.tenant.create({ data: { id: TENANT_ID, name: `t ${TAG}`, slug: TAG } });
        const provider = await db.tenantIdentityProvider.create({
            data: { tenantId: TENANT_ID, type: 'ENTRA_ID', name: 'Entra', isEnabled: true },
        });
        providerId = provider.id;
        const token = await db.tenantScimToken.create({
            data: { tenantId: TENANT_ID, label: 'Entra', tokenHash: hashToken(RAW_TOKEN) },
        });
        tokenId = token.id;
    });

    /** A person with an ACTIVE membership and an Entra identity link. */
    async function person(label: string, role: Role = 'READER') {
        const email = `${TAG}-${label}@example.com`;
        const user = await db.user.create({ data: { email, emailHash: hashForLookup(email), name: label } });
        const membership = await db.tenantMembership.create({
            data: { tenantId: TENANT_ID, userId: user.id, role, status: 'ACTIVE' },
        });
        const oid = randomUUID();
        await db.userIdentityLink.create({
            data: {
                userId: user.id,
                tenantId: TENANT_ID,
                providerId,
                externalSubject: oid,
                emailAtLinkTime: email,
                emailAtLinkTimeHash: hashForLookup(email),
            },
        });
        return { userId: user.id, membershipId: membership.id, oid };
    }

    const membershipOf = (id: string) =>
        db.tenantMembership.findUniqueOrThrow({ where: { id }, select: { role: true, status: true } });

    /**
     * Two mapped groups, pushed with the person in both: EDITOR outranks
     * READER. Fresh ids per test — a group's externalId is unique per tenant.
     */
    async function inBothGroups(oid: string) {
        const editorGroup = randomUUID();
        const readerGroup = randomUUID();
        await db.tenantEntraGroupMapping.createMany({
            data: [
                { tenantId: TENANT_ID, aadGroupId: editorGroup, role: 'EDITOR', priority: 10 },
                { tenantId: TENANT_ID, aadGroupId: readerGroup, role: 'READER', priority: 1 },
            ],
        });
        const editor = await scimCreateGroup(
            { tenantId: TENANT_ID },
            { externalId: editorGroup, displayName: 'Editors', members: [{ value: oid }] },
        );
        await scimCreateGroup(
            { tenantId: TENANT_ID },
            { externalId: readerGroup, displayName: 'Readers', members: [{ value: oid }] },
        );
        return editor.id;
    }

    function patchRequest(path: string, operations: unknown[]): NextRequest {
        return new NextRequest(`${BASE_URL}${path}`, {
            method: 'PATCH',
            headers: { authorization: `Bearer ${RAW_TOKEN}`, 'content-type': 'application/scim+json' },
            body: JSON.stringify({ schemas: [PATCH_OP], Operations: operations }),
        });
    }

    // ── Groups ──────────────────────────────────────────────────────────

    it('a capitalised "Remove" takes the person out of the group and drops the role it mapped', async () => {
        const p = await person('remove-cap');
        const groupId = await inBothGroups(p.oid);
        expect((await membershipOf(p.membershipId)).role).toBe('EDITOR');

        await scimPatchGroup(scimCtx(), groupId, [
            { op: 'Remove', path: 'members', value: [{ value: p.oid }] },
        ]);

        const group = await db.scimGroup.findUniqueOrThrow({ where: { id: groupId } });
        expect(group.memberIds).not.toContain(p.userId);
        expect(await membershipOf(p.membershipId)).toEqual({ role: 'READER', status: 'ACTIVE' });
    });

    it('a filter-form remove (members[value eq "<oid>"], no value) removes the member', async () => {
        const p = await person('remove-filter');
        const groupId = await inBothGroups(p.oid);

        await scimPatchGroup(scimCtx(), groupId, [
            { op: 'Remove', path: `members[value eq "${p.oid}"]` },
        ]);

        const group = await db.scimGroup.findUniqueOrThrow({ where: { id: groupId } });
        expect(group.memberIds).not.toContain(p.userId);
        expect((await membershipOf(p.membershipId)).role).toBe('READER');
    });

    it('a capitalised "Add" puts the person back and restores the mapped role', async () => {
        const p = await person('add-cap');
        const groupId = await inBothGroups(p.oid);
        await scimPatchGroup(scimCtx(), groupId, [{ op: 'Remove', path: 'members', value: [{ value: p.oid }] }]);
        expect((await membershipOf(p.membershipId)).role).toBe('READER');

        await scimPatchGroup(scimCtx(), groupId, [{ op: 'Add', path: 'members', value: [{ value: p.oid }] }]);

        expect((await membershipOf(p.membershipId)).role).toBe('EDITOR');
    });

    it('an unknown op on a group is a SCIM 400 and changes nothing', async () => {
        const p = await person('group-unknown-op');
        const groupId = await inBothGroups(p.oid);

        const res = await GroupPatchRoute(
            patchRequest(`/api/scim/v2/Groups/${groupId}`, [
                { op: 'Remove', path: 'members', value: [{ value: p.oid }] },
                { op: 'Frobnicate', path: 'members', value: [{ value: p.oid }] },
            ]),
            { params: Promise.resolve({ id: groupId }) },
        );

        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '400',
            scimType: 'invalidSyntax',
            detail: expect.stringMatching(/op must be one of/),
        });
        // The valid op before it was not applied either: a PatchOp is atomic.
        const group = await db.scimGroup.findUniqueOrThrow({ where: { id: groupId } });
        expect(group.memberIds).toContain(p.userId);
        expect((await membershipOf(p.membershipId)).role).toBe('EDITOR');
    });

    // ── Users ───────────────────────────────────────────────────────────

    it('Replace active "False" deactivates', async () => {
        const p = await person('active-false');
        await scimPatchUser(scimCtx(), p.userId, [{ op: 'Replace', path: 'active', value: 'False' }], BASE_URL);
        expect((await membershipOf(p.membershipId)).status).toBe('DEACTIVATED');
    });

    it('Replace active "True" keeps an active user active', async () => {
        const p = await person('active-true');
        await scimPatchUser(scimCtx(), p.userId, [{ op: 'Replace', path: 'active', value: 'True' }], BASE_URL);
        expect((await membershipOf(p.membershipId)).status).toBe('ACTIVE');
    });

    it('"True" is true under a lower-case op too — it used to DEACTIVATE', async () => {
        // Before #5370 a lower-case `replace` did reach the `active` branch,
        // which read only `true`/`'true'` as true: "True" disabled the user.
        const p = await person('active-true-lower-op');
        await scimPatchUser(scimCtx(), p.userId, [{ op: 'replace', path: 'active', value: 'True' }], BASE_URL);
        expect((await membershipOf(p.membershipId)).status).toBe('ACTIVE');
    });

    it('Replace active "True" reactivates a deactivated user', async () => {
        const p = await person('active-true-reactivate');
        await db.tenantMembership.update({
            where: { id: p.membershipId },
            data: { status: 'DEACTIVATED', deactivatedAt: new Date() },
        });
        await scimPatchUser(scimCtx(), p.userId, [{ op: 'Replace', path: 'active', value: 'True' }], BASE_URL);
        expect((await membershipOf(p.membershipId)).status).toBe('ACTIVE');
    });

    it('a no-path "Replace" with { active: false } deactivates (Entra disable)', async () => {
        const p = await person('nopath-replace');
        await scimPatchUser(scimCtx(), p.userId, [{ op: 'Replace', value: { active: false } }], BASE_URL);
        expect((await membershipOf(p.membershipId)).status).toBe('DEACTIVATED');
    });

    it('an active value that is not a boolean is a SCIM 400 and the status is unchanged', async () => {
        const p = await person('active-garbage');
        const res = await UserPatchRoute(
            patchRequest(`/api/scim/v2/Users/${p.userId}`, [{ op: 'Replace', path: 'active', value: 'Yes' }]),
            { params: Promise.resolve({ id: p.userId }) },
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ status: '400', scimType: 'invalidValue' });
        expect((await membershipOf(p.membershipId)).status).toBe('ACTIVE');
    });

    it('an unknown op on a user is a SCIM 400, not a silent 200', async () => {
        const p = await person('user-unknown-op');
        const res = await UserPatchRoute(
            patchRequest(`/api/scim/v2/Users/${p.userId}`, [
                { op: 'Replace', path: 'active', value: false },
                { op: 'Frobnicate', path: 'active', value: false },
            ]),
            { params: Promise.resolve({ id: p.userId }) },
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            status: '400',
            scimType: 'invalidSyntax',
            detail: expect.stringMatching(/op must be one of/),
        });
        expect((await membershipOf(p.membershipId)).status).toBe('ACTIVE');
    });
});
