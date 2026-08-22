/**
 * The fence that keeps `disconnectSharePoint` away from identity
 * connections — behaviour, against a live Postgres.
 *
 * WHAT IS AT STAKE
 * ----------------
 * `ConnectedIdentityAccount.connectionId` is required with
 * `onDelete: Cascade` (#2089), so deleting an `IntegrationConnection`
 * deletes the roster that connection's sync observed. Account rows are
 * re-derivable — the next sync rebuilds them. The operator-entered
 * never-offboard flags on those rows are NOT: `isProtected`,
 * `protectionReason`, `protectedAt`, `protectedByUserId` exist nowhere
 * else in the product, and are deliberately omitted from the sync
 * upsert's `update` block, so a resync restores the account WITHOUT its
 * protection. The next automatic leaver pass then offboards an account an
 * operator had marked break-glass, and nothing in the system reads as
 * broken.
 *
 * WHY THIS TEST EXISTS EVEN THOUGH NOTHING IS BROKEN TODAY
 * --------------------------------------------------------
 * There is no reachable path to that outcome right now.
 * `removeIntegrationConnection` — what the admin UI's DELETE calls — sets
 * `isEnabled: false` and deletes nothing. The only real row delete in the
 * product is `disconnectSharePoint`, and SharePoint connections can never
 * hold identity accounts (`identity-sync` is their sole creator and it
 * gates on okta / google-workspace / entra-id / active-directory).
 *
 * So this is a loaded gun with no trigger, and the job is to fence the one
 * trigger that exists.
 *
 * WHAT THIS SUITE DOES NOT COVER — say it here, not in a postmortem
 * -----------------------------------------------------------------
 * Every assertion below reaches the database through `disconnectSharePoint`,
 * so this suite detects exactly ONE regression: `loadConnection` losing its
 * provider filter. It does NOT detect the other way the trigger appears — a
 * SECOND `integrationConnection.delete(...)` call site added elsewhere (a
 * `disconnectGoogleWorkspace` modelled on this one, a tenant-cleanup path, a
 * migration script). Such a call site would leave all five assertions green.
 *
 * That gap is stated rather than closed because closing it needs a different
 * instrument — an enumeration of delete call sites, which is a source scan,
 * and a source scan cannot answer whether a path is reachable. Claiming the
 * broad property here would be the more comfortable sentence and the false
 * one.
 *
 * WHERE THE SAFETY PROPERTY ACTUALLY LIVES
 * ----------------------------------------
 * On the LOOKUP, not on the delete. `disconnectSharePoint` deletes
 * whatever `loadConnection` hands it and performs no provider check of
 * its own — it is safe purely because `loadConnection` filters
 * `provider: SHAREPOINT_PROVIDER`. That is one clause in a private helper
 * shared with the browse / client / sync paths, none of which would
 * visibly misbehave if it were widened. Widening it is an
 * ordinary-looking edit.
 *
 * Hence the negative below: it drives the real function against a real
 * identity connection and asserts the row SURVIVES. It is the assertion
 * that goes red the day that where-clause loses its provider filter, and
 * it says so in the failure.
 *
 * The positive control is not optional. Without it the negative would
 * pass just as happily if `disconnectSharePoint` were broken outright, or
 * if the fixture had never been created.
 */
import { PrismaClient, Role, MembershipStatus } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { randomUUID } from 'crypto';
import { DB_URL, DB_AVAILABLE } from './db-helper';
import { hashForLookup } from '@/lib/security/encryption';
import { NotFoundError } from '@/lib/errors/types';
import { makeRequestContext } from '../helpers/make-context';
import {
    disconnectSharePoint,
    SHAREPOINT_PROVIDER,
} from '@/app-layer/integrations/providers/sharepoint/service';

const globalPrisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: DB_URL }),
});
const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const SUITE_TAG = `spfence-${randomUUID().slice(0, 8)}`;
const TENANT_ID = `t-${SUITE_TAG}`;

/**
 * The providers `identity-sync` writes accounts for, and therefore the
 * providers whose connections can be carrying protection flags. Every one
 * of them has to be unreachable from the SharePoint disconnect — not just
 * the first one someone thought of.
 *
 * ALL FOUR, deliberately. An earlier draft listed two and kept this comment,
 * which made the comment false by exactly the argument it was making. The
 * omission that would have mattered is `active-directory`: with `entra-id` it
 * is one of the two WRITABLE_IDENTITY_PROVIDERS, so it is among the likeliest
 * to grow a `disconnectX` of its own modelled on the SharePoint one.
 *
 * Keep this in step with IDENTITY_PROVIDERS in `usecases/identity-sync.ts`. It
 * is a fourth copy of a closed vocabulary that already exists three times in
 * src/ — the duplication is a known cost, taken because a test that imported
 * the list would pass automatically when someone shortened it.
 */
const IDENTITY_PROVIDERS = ['okta', 'entra-id', 'google-workspace', 'active-directory'] as const;
type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

const PROTECTION_REASON = 'Break-glass credential — never offboard automatically';

let ownerUserId: string;
let ctx: ReturnType<typeof makeRequestContext>;
let sharePointConnId: string;
/** provider → the seeded connection + its protected account. */
const identity: Record<string, { connectionId: string; accountId: string }> = {};

/** Seed one identity connection carrying one operator-protected account. */
async function seedIdentityConnection(provider: IdentityProvider): Promise<void> {
    const conn = await globalPrisma.integrationConnection.create({
        data: {
            tenantId: TENANT_ID,
            provider,
            name: `${provider}-${SUITE_TAG}`,
            configJson: {},
            isEnabled: true,
        },
    });
    const account = await globalPrisma.connectedIdentityAccount.create({
        data: {
            tenantId: TENANT_ID,
            provider,
            connectionId: conn.id,
            externalUserId: `ext-${provider}-${SUITE_TAG}`,
            email: `breakglass-${provider}@${SUITE_TAG}.test`,
            syncedAt: new Date(),
            isProtected: true,
            protectedAt: new Date(),
            protectedByUserId: ownerUserId,
            protectionReason: PROTECTION_REASON,
        },
    });
    identity[provider] = { connectionId: conn.id, accountId: account.id };
}

describeFn('identity connections are unreachable from the SharePoint disconnect', () => {
    beforeAll(async () => {
        await globalPrisma.tenant.upsert({
            where: { id: TENANT_ID },
            update: {},
            create: { id: TENANT_ID, name: `t ${SUITE_TAG}`, slug: SUITE_TAG },
        });
        const email = `${SUITE_TAG}-owner@example.test`;
        const owner = await globalPrisma.user.create({
            data: { email, emailHash: hashForLookup(email) },
        });
        ownerUserId = owner.id;
        await globalPrisma.tenantMembership.create({
            data: {
                tenantId: TENANT_ID,
                userId: ownerUserId,
                role: Role.OWNER,
                status: MembershipStatus.ACTIVE,
            },
        });
        ctx = makeRequestContext('OWNER', {
            tenantId: TENANT_ID,
            tenantSlug: SUITE_TAG,
            userId: ownerUserId,
        });

        for (const provider of IDENTITY_PROVIDERS) await seedIdentityConnection(provider);

        const sp = await globalPrisma.integrationConnection.create({
            data: {
                tenantId: TENANT_ID,
                provider: SHAREPOINT_PROVIDER,
                name: `sharepoint-${SUITE_TAG}`,
                configJson: { aadTenantId: '', allowedSiteIds: [] },
                isEnabled: true,
            },
        });
        sharePointConnId = sp.id;
    });

    afterAll(async () => {
        await globalPrisma.connectedIdentityAccount.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.integrationConnection.deleteMany({ where: { tenantId: TENANT_ID } });
        await globalPrisma.$transaction(async (tx) => {
            // AuditLog is append-only at the DB level and the disconnect below
            // writes to it, so cleanup has to step around the trigger.
            await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
            await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, TENANT_ID);
            await tx.$executeRawUnsafe(
                `DELETE FROM "TenantMembership" WHERE "tenantId" = $1`,
                TENANT_ID,
            );
        });
        // GUARDED, and this is not defensive padding. `afterAll` runs even when
        // `beforeAll` threw, and Prisma treats `where: { id: undefined }` as an
        // ABSENT filter rather than an error — so an early failure here would
        // issue an unfiltered deleteMany against a Postgres this machine shares
        // with other sessions. The bare `let` is what makes it reachable.
        if (ownerUserId) {
            await globalPrisma.user.deleteMany({ where: { id: ownerUserId } });
        }
        await globalPrisma.tenant.deleteMany({ where: { id: TENANT_ID } });
        await globalPrisma.$disconnect();
    });

    it('the fixtures really exist — otherwise every assertion below is vacuous', async () => {
        // Read as superuser, no tenant bound: a "still there" assertion proves
        // nothing if the row was never written in the first place.
        const conns = await globalPrisma.integrationConnection.findMany({
            where: { tenantId: TENANT_ID },
            select: { provider: true },
        });
        expect(conns.map((c: { provider: string }) => c.provider).sort()).toEqual(
            [...IDENTITY_PROVIDERS, SHAREPOINT_PROVIDER].sort(),
        );

        const accounts = await globalPrisma.connectedIdentityAccount.findMany({
            where: { tenantId: TENANT_ID },
        });
        expect(accounts).toHaveLength(IDENTITY_PROVIDERS.length);
        expect(accounts.every((a: { isProtected: boolean }) => a.isProtected)).toBe(true);
    });

    it.each(IDENTITY_PROVIDERS)(
        'refuses a %s connection, and the connection is still there afterwards',
        async (provider) => {
            const { connectionId, accountId } = identity[provider];

            await expect(disconnectSharePoint(ctx, connectionId)).rejects.toBeInstanceOf(
                NotFoundError,
            );

            // The rejection alone is not the property — a function that threw
            // AFTER deleting would satisfy it. The surviving row is the property.
            const conn = await globalPrisma.integrationConnection.findUnique({
                where: { id: connectionId },
            });
            expect(conn).not.toBeNull();
            expect(conn?.provider).toBe(provider);

            // And the thing that row was standing in front of: the flags that
            // exist nowhere else and that no resync would put back.
            const account = await globalPrisma.connectedIdentityAccount.findUnique({
                where: { id: accountId },
            });
            expect(account).not.toBeNull();
            expect(account?.isProtected).toBe(true);
            expect(account?.protectionReason).toBe(PROTECTION_REASON);
            expect(account?.protectedByUserId).toBe(ownerUserId);
        },
    );

    it('POSITIVE CONTROL — a real SharePoint connection does disconnect', async () => {
        // Without this, the negative above passes just as well when
        // disconnectSharePoint is broken, mis-imported, or never reaches a
        // delete at all.
        await expect(disconnectSharePoint(ctx, sharePointConnId)).resolves.toBeUndefined();

        const gone = await globalPrisma.integrationConnection.findUnique({
            where: { id: sharePointConnId },
        });
        expect(gone).toBeNull();
    });

    it('the stake is real: deleting an identity connection DOES take its protection flags', async () => {
        // Not a wish — a statement of what the cascade does, and the whole
        // reason the lookup has to keep refusing. If this ever stops being
        // true (onDelete changed to Restrict / SetNull) the fence is guarding
        // something different and this file should be re-read.
        const conn = await globalPrisma.integrationConnection.create({
            data: {
                tenantId: TENANT_ID,
                provider: 'okta',
                name: `throwaway-${SUITE_TAG}`,
                configJson: {},
            },
        });
        const account = await globalPrisma.connectedIdentityAccount.create({
            data: {
                tenantId: TENANT_ID,
                provider: 'okta',
                connectionId: conn.id,
                externalUserId: `ext-throwaway-${SUITE_TAG}`,
                email: `throwaway@${SUITE_TAG}.test`,
                syncedAt: new Date(),
                isProtected: true,
                protectionReason: PROTECTION_REASON,
            },
        });

        await globalPrisma.integrationConnection.delete({ where: { id: conn.id } });

        const orphan = await globalPrisma.connectedIdentityAccount.findUnique({
            where: { id: account.id },
        });
        expect(orphan).toBeNull();
    });
});
