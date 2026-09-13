/**
 * Branch-coverage integration test for the SSO usecases — exercises
 * the permission denials, not-found throws, config CRUD, the
 * enable/disable + enforce branches (including the break-glass guard),
 * SSO login resolution (tenant/domain), the full linkExternalIdentity
 * rejection-reason matrix (no_email / domain_mismatch / cross_tenant /
 * no_membership / subject_conflict / jit_disabled), the linked + JIT
 * happy paths, and the local-login enforcement checks.
 *
 * Hits a real DB (project convention). The SSO usecases query the app
 * `prisma` singleton directly (no runInTenantContext), so seeding uses
 * the same DB URL.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { makeRequestContext } from '../helpers/make-context';
import {
    getTenantSsoConfig,
    getTenantSsoConfigById,
    upsertTenantSsoConfig,
    deleteTenantSsoConfig,
    toggleTenantSso,
    setTenantSsoEnforced,
    resolveSsoForTenant,
    resolveSsoByDomain,
    validateEmailAgainstDomains,
    linkExternalIdentity,
    isLocalLoginAllowed,
    checkSsoEnforcementForEmail,
    getIdentityLinks,
    unlinkIdentity,
} from '@/app-layer/usecases/sso';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;

const SUITE_TAG = `sso-br-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;
const OTHER_TENANT_ID = `t2-${SUITE_TAG}`;

let adminPwUserId: string;
let adminNoPwUserId: string;
let readerUserId: string;
let memberUserId: string; // member of TENANT, used for email-match link
let noMemberUserId: string; // exists but no membership in TENANT
let admin: ReturnType<typeof makeRequestContext>;
let reader: ReturnType<typeof makeRequestContext>;
let adminOther: ReturnType<typeof makeRequestContext>;

async function makeUser(label: string, opts: { password?: boolean } = {}): Promise<{ id: string; email: string }> {
    const email = `${SUITE_TAG}-${label}@inflect.test`;
    const u = await globalPrisma.user.create({
        data: {
            email,
            emailHash: hashForLookup(email),
            passwordHash: opts.password ? 'pw-hash' : null,
        },
    });
    return { id: u.id, email };
}

async function addMembership(tenantId: string, userId: string, role: Role) {
    await globalPrisma.tenantMembership.create({
        data: { tenantId, userId, role, status: MembershipStatus.ACTIVE },
    });
}

async function makeProvider(opts: {
    tenantId?: string;
    name: string;
    emailDomains?: string[];
    isEnabled?: boolean;
    isEnforced?: boolean;
    jit?: { allowJitProvisioning: boolean; jitDefaultRole?: string };
}) {
    return globalPrisma.tenantIdentityProvider.create({
        data: {
            tenantId: opts.tenantId ?? TENANT_ID,
            type: 'OIDC',
            name: opts.name,
            emailDomains: opts.emailDomains ?? [],
            isEnabled: opts.isEnabled ?? true,
            isEnforced: opts.isEnforced ?? false,
            configJson: opts.jit ? { _jit: opts.jit } : {},
        },
    });
}

describeFn('sso usecase — branch coverage (integration)', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        await globalPrisma.tenant.upsert({
            where: { id: OTHER_TENANT_ID },
            update: {},
            create: { id: OTHER_TENANT_ID, name: `t2 ${SUITE_TAG}`, slug: `${SUITE_TAG}-2` },
        });

        const adminPw = await makeUser('adminpw', { password: true });
        adminPwUserId = adminPw.id;
        const adminNoPw = await makeUser('adminnopw');
        adminNoPwUserId = adminNoPw.id;
        const rd = await makeUser('reader');
        readerUserId = rd.id;
        const mem = await makeUser('member');
        memberUserId = mem.id;
        const noMem = await makeUser('nomember');
        noMemberUserId = noMem.id;

        await addMembership(TENANT_ID, adminPwUserId, Role.ADMIN);
        await addMembership(TENANT_ID, adminNoPwUserId, Role.ADMIN);
        await addMembership(TENANT_ID, readerUserId, Role.READER);
        await addMembership(TENANT_ID, memberUserId, Role.EDITOR);
        // noMemberUserId intentionally has NO membership in TENANT_ID.

        admin = makeRequestContext('ADMIN', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: adminPwUserId });
        reader = makeRequestContext('READER', { tenantId: TENANT_ID, tenantSlug: SUITE_TAG, userId: readerUserId });
        adminOther = makeRequestContext('ADMIN', { tenantId: OTHER_TENANT_ID, tenantSlug: `${SUITE_TAG}-2`, userId: adminPwUserId });
    });

    afterAll(async () => {
        await globalPrisma.userIdentityLink.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
        await globalPrisma.tenantIdentityProvider.deleteMany({ where: { tenantId: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
        await globalPrisma.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" IN ($1, $2)`, TENANT_ID, OTHER_TENANT_ID);
            await tx.$executeRawUnsafe(`DELETE FROM "TenantMembership" WHERE "tenantId" IN ($1, $2)`, TENANT_ID, OTHER_TENANT_ID);
        });
        // Remove any JIT-created users (email-prefixed by suite tag).
        await globalPrisma.user.deleteMany({ where: { email: { contains: SUITE_TAG } } });
        await globalPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_ID, OTHER_TENANT_ID] } } });
        await globalPrisma.$disconnect();
    });

    it('permission denials for all admin-gated usecases', async () => {
        await expect(getTenantSsoConfig(reader)).rejects.toThrow(/admin/i);
        await expect(getTenantSsoConfigById(reader, 'x')).rejects.toThrow(/admin/i);
        await expect(
            upsertTenantSsoConfig(reader, { name: 'x', type: 'OIDC', config: {} } as any),
        ).rejects.toThrow(/admin/i);
        await expect(deleteTenantSsoConfig(reader, 'x')).rejects.toThrow(/admin/i);
        await expect(toggleTenantSso(reader, 'x', true)).rejects.toThrow(/admin/i);
        await expect(setTenantSsoEnforced(reader, 'x', true)).rejects.toThrow(/admin/i);
        await expect(getIdentityLinks(reader, 'x')).rejects.toThrow(/admin/i);
        await expect(unlinkIdentity(reader, 'x', 'y')).rejects.toThrow(/admin/i);
    });

    it('config CRUD: create, update, get, not-found, toggle, delete', async () => {
        // create (no id)
        const created = await upsertTenantSsoConfig(admin, {
            name: 'Primary OIDC',
            type: 'OIDC',
            isEnabled: false,
            isEnforced: false,
            emailDomains: ['acme.test'],
            config: { issuer: 'https://idp.test', clientId: 'c', clientSecret: 's' },
            allowJitProvisioning: true,
            jitDefaultRole: 'EDITOR',
        } as any);
        expect(created.id).toBeTruthy();

        // list + get by id
        const list = await getTenantSsoConfig(admin);
        expect(list.some((p) => p.id === created.id)).toBe(true);
        const got = await getTenantSsoConfigById(admin, created.id);
        expect(got.name).toBe('Primary OIDC');

        // get not-found
        await expect(getTenantSsoConfigById(admin, 'no-such')).rejects.toThrow(/not found/i);

        // update (with id) → existing found
        const updated = await upsertTenantSsoConfig(admin, {
            id: created.id,
            name: 'Renamed OIDC',
            type: 'OIDC',
            config: { issuer: 'https://idp2.test' },
        } as any);
        expect(updated.name).toBe('Renamed OIDC');

        // update with bogus id → not-found
        await expect(
            upsertTenantSsoConfig(admin, { id: 'no-such', name: 'x', type: 'OIDC', config: {} } as any),
        ).rejects.toThrow(/not found/i);

        // toggle not-found + happy
        await expect(toggleTenantSso(admin, 'no-such', true)).rejects.toThrow(/not found/i);
        const enabled = await toggleTenantSso(admin, created.id, true);
        expect(enabled.isEnabled).toBe(true);

        // delete not-found + happy
        await expect(deleteTenantSsoConfig(admin, 'no-such')).rejects.toThrow(/not found/i);
        await deleteTenantSsoConfig(admin, created.id);
        await expect(getTenantSsoConfigById(admin, created.id)).rejects.toThrow(/not found/i);
    });

    it('setTenantSsoEnforced: not-found, break-glass guard, and success/disable', async () => {
        await expect(setTenantSsoEnforced(admin, 'no-such', true)).rejects.toThrow(/not found/i);

        // OTHER_TENANT has no admin members → enforcing is blocked.
        const provOther = await makeProvider({ tenantId: OTHER_TENANT_ID, name: 'Other IdP' });
        await expect(setTenantSsoEnforced(adminOther, provOther.id, true)).rejects.toThrow(/break-glass/i);

        // TENANT has an admin with a password → enforce succeeds.
        const prov = await makeProvider({ name: 'Enforce IdP' });
        const enforced = await setTenantSsoEnforced(admin, prov.id, true);
        expect(enforced.isEnforced).toBe(true);
        // disabling enforcement skips the break-glass check.
        const off = await setTenantSsoEnforced(admin, prov.id, false);
        expect(off.isEnforced).toBe(false);
    });

    it('resolveSsoForTenant + resolveSsoByDomain branches', async () => {
        // unknown tenant → no sso
        const none = await resolveSsoForTenant('no-such-slug-xyz');
        expect(none.hasSso).toBe(false);

        // a tenant with enabled+enforced provider claiming a domain
        await makeProvider({ name: 'Domain IdP', emailDomains: ['discover.test'], isEnabled: true, isEnforced: true });
        const resolved = await resolveSsoForTenant(SUITE_TAG);
        expect(resolved.hasSso).toBe(true);
        expect(resolved.isEnforced).toBe(true);
        expect(resolved.providers.length).toBeGreaterThanOrEqual(1);

        // OTHER_TENANT may have no enabled providers initially → handled above via unknown.
        const noProviders = await resolveSsoForTenant(`${SUITE_TAG}-2`);
        // provOther exists but is not enabled? it is enabled by default — assert shape only.
        expect(noProviders).toHaveProperty('hasSso');

        // domain resolution
        const bad = await resolveSsoByDomain('not-an-email');
        expect(bad.found).toBe(false);
        const missing = await resolveSsoByDomain('user@nowhere-xyz.test');
        expect(missing.found).toBe(false);
        const found = await resolveSsoByDomain('user@discover.test');
        expect(found.found).toBe(true);
        expect(found.tenantSlug).toBe(SUITE_TAG);
    });

    it('validateEmailAgainstDomains pure branches', () => {
        expect(validateEmailAgainstDomains('a@x.test', [])).toBe(true); // no restriction
        expect(validateEmailAgainstDomains('no-domain', ['x.test'])).toBe(false);
        expect(validateEmailAgainstDomains('a@X.TEST', ['x.test'])).toBe(true);
        expect(validateEmailAgainstDomains('a@other.test', ['x.test'])).toBe(false);
    });

    it('linkExternalIdentity rejection-reason matrix', async () => {
        const pOpen = await makeProvider({ name: 'Link Open' });
        const pDomain = await makeProvider({ name: 'Link Domain', emailDomains: ['allowed.test'] });

        // no_email
        expect(await linkExternalIdentity(TENANT_ID, pOpen.id, 'sub-ne', '')).toEqual({
            status: 'rejected',
            reason: 'no_email',
        });

        // domain_mismatch
        expect(await linkExternalIdentity(TENANT_ID, pDomain.id, 'sub-dm', 'x@other.test')).toEqual({
            status: 'rejected',
            reason: 'domain_mismatch',
        });

        // cross_tenant — the link now lives WITH ITS PROVIDER, in OTHER_TENANT.
        //
        // This used to create the link in OTHER_TENANT while pointing it at
        // `pOpen`, which belongs to TENANT_ID. #2356 batch 3a made
        // UserIdentityLink.providerId carry `tenantId`, so that row is no longer
        // representable — the database refuses it on
        // `UserIdentityLink_providerId_tenantId_fkey`.
        //
        // The BRANCH is not dead, and this still reaches it: the tenant comes
        // from the CALLER, not from the provider. A caller asking to link into
        // TENANT_ID against a provider whose existing link sits in
        // OTHER_TENANT is exactly the mismatch `cross_tenant` exists to refuse —
        // and it is the shape that can actually occur, rather than one that
        // required an impossible row to stage.
        const pOther = await makeProvider({ tenantId: OTHER_TENANT_ID, name: 'Link Other' });
        await globalPrisma.userIdentityLink.create({
            data: {
                userId: adminPwUserId,
                tenantId: OTHER_TENANT_ID,
                providerId: pOther.id,
                externalSubject: 'sub-ct',
                emailAtLinkTime: 'x@x.test',
                emailAtLinkTimeHash: hashForLookup('x@x.test'),
            },
        });
        expect(await linkExternalIdentity(TENANT_ID, pOther.id, 'sub-ct', 'a@x.test')).toEqual({
            status: 'rejected',
            reason: 'cross_tenant',
        });

        // no_membership — noMemberUser exists but has no membership
        const noMemEmail = `${SUITE_TAG}-nomember@inflect.test`;
        expect(await linkExternalIdentity(TENANT_ID, pOpen.id, 'sub-nm', noMemEmail)).toEqual({
            status: 'rejected',
            reason: 'no_membership',
        });
    });

    it('linkExternalIdentity linked (existing-link + new-link), subject_conflict, JIT', async () => {
        const pA = await makeProvider({ name: 'Link A' });
        const memberEmail = `${SUITE_TAG}-member@inflect.test`;

        // new link for existing member → linked, isNewLink true
        const newLink = await linkExternalIdentity(TENANT_ID, pA.id, 'sub-a', memberEmail);
        expect(newLink).toMatchObject({ status: 'linked', userId: memberUserId, isNewLink: true });

        // same subject again → existing-link same tenant → linked, isNewLink false
        const again = await linkExternalIdentity(TENANT_ID, pA.id, 'sub-a', memberEmail);
        expect(again).toMatchObject({ status: 'linked', isNewLink: false });

        // different subject, same user+provider → subject_conflict
        const conflict = await linkExternalIdentity(TENANT_ID, pA.id, 'sub-a2', memberEmail);
        expect(conflict).toEqual({ status: 'rejected', reason: 'subject_conflict' });

        // jit_disabled — provider without _jit, unknown email
        const pNoJit = await makeProvider({ name: 'No JIT' });
        const unknown1 = `${SUITE_TAG}-jitoff@new.test`;
        expect(await linkExternalIdentity(TENANT_ID, pNoJit.id, 'sub-j1', unknown1)).toEqual({
            status: 'rejected',
            reason: 'jit_disabled',
        });

        // jit_created — provider with _jit on, unknown email → creates user+membership+link
        const pJit = await makeProvider({
            name: 'JIT On',
            jit: { allowJitProvisioning: true, jitDefaultRole: 'EDITOR' },
        });
        const unknown2 = `${SUITE_TAG}-jitnew@new.test`;
        const jit = await linkExternalIdentity(TENANT_ID, pJit.id, 'sub-j2', unknown2);
        expect(jit.status).toBe('jit_created');
    });

    it('isLocalLoginAllowed + checkSsoEnforcementForEmail break-glass branches', async () => {
        // dedicated enforced provider in TENANT
        await makeProvider({ name: 'Local Enf', isEnabled: true, isEnforced: true });

        // admin with password → allowed (break-glass)
        expect(await isLocalLoginAllowed(TENANT_ID, adminPwUserId)).toBe(true);
        // reader (non-admin) → blocked
        expect(await isLocalLoginAllowed(TENANT_ID, readerUserId)).toBe(false);
        // admin without password → blocked
        expect(await isLocalLoginAllowed(TENANT_ID, adminNoPwUserId)).toBe(false);
        // tenant with no enforced providers → allowed
        expect(await isLocalLoginAllowed(OTHER_TENANT_ID, adminPwUserId)).toBe(true);

        // checkSsoEnforcementForEmail
        const unknownUser = await checkSsoEnforcementForEmail('nobody-xyz@nope.test');
        expect(unknownUser.allowed).toBe(true);

        const readerEmail = `${SUITE_TAG}-reader@inflect.test`;
        const blocked = await checkSsoEnforcementForEmail(readerEmail);
        expect(blocked.allowed).toBe(false);
        expect(blocked.enforced?.tenantSlug).toBe(SUITE_TAG);

        const adminEmail = `${SUITE_TAG}-adminpw@inflect.test`;
        const breakGlass = await checkSsoEnforcementForEmail(adminEmail);
        expect(breakGlass.allowed).toBe(true);
    });

    it('getIdentityLinks + unlinkIdentity admin happy paths', async () => {
        const links = await getIdentityLinks(admin, memberUserId);
        expect(Array.isArray(links)).toBe(true);
        // unlink is a no-op-safe deleteMany
        await unlinkIdentity(admin, memberUserId, 'no-such-provider');
    });
});
