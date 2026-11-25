/**
 * A personal calendar's OAuth token is sealed under the TENANT's key, and both
 * key-rotation sweeps reach it.
 *
 * Until #5937 the usecase sealed the token itself with `encryptField` — the
 * GLOBAL key, `v1:` — and the model was absent from `ENCRYPTED_FIELDS`, which
 * is the list both sweeps iterate. So a master-KEK rotation followed by
 * retiring `DATA_ENCRYPTION_KEY_PREVIOUS` would have stranded every stored
 * token, and a tenant-DEK rotation never touched one.
 *
 * Integration, not unit: what is proved here is the interaction of the real
 * usecase, the real encryption extension, a real per-tenant DEK and the real
 * sweeps. A mocked Prisma client can prove none of it.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import {
    createTenantWithDek,
    getTenantDek,
    _resetTenantDekCache,
} from '@/lib/security/tenant-key-manager';
import { generateDek, wrapDek } from '@/lib/security/tenant-keys';
import { decryptField, decryptWithKey, encryptField, encryptWithKey, hashForLookup } from '@/lib/security/encryption';
import {
    readCalendarToken,
    saveCalendarConnection,
    updateCalendarToken,
} from '@/app-layer/usecases/user-calendar-connection';
import { runKeyRotation } from '@/app-layer/jobs/key-rotation';
import { runTenantDekRotation } from '@/app-layer/jobs/tenant-dek-rotation';

const d = DB_AVAILABLE ? describe : describe.skip;

d('UserCalendarConnection.tokenEncrypted — tenant key, rotation coverage', () => {
    // Throwaway fixture values written to a temporary tenant; never real tokens.
    const TOKEN = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh', expiresAt: 2_000_000_000 }; // pragma: allowlist secret
    const ROTATED = { ...TOKEN, accessToken: 'fixture-access-2', expiresAt: 2_000_003_600 }; // pragma: allowlist secret
    const prisma = prismaTestClient();
    const tenantIds: string[] = [];

    async function fixture(label: string) {
        const slug = `caltok-${label}-${Date.now()}`;
        const tenant = await createTenantWithDek({ name: slug, slug });
        const email = `${slug}@example.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email), name: label } });
        tenantIds.push(tenant.id);
        const ctx = makeRequestContext('EDITOR', { tenantId: tenant.id, userId: user.id, tenantSlug: slug });
        return { tenant, user, ctx };
    }

    async function stored(tenantId: string, userId: string): Promise<string> {
        // `prismaTestClient()` is typed `any`, so the row type is asserted.
        const rows = (await prisma.$queryRawUnsafe(
            `SELECT "tokenEncrypted" FROM "UserCalendarConnection" WHERE "tenantId" = $1 AND "userId" = $2`,
            tenantId,
            userId,
        )) as Array<{ tokenEncrypted: string }>;
        return rows[0].tokenEncrypted;
    }

    beforeEach(() => _resetTenantDekCache());

    afterAll(async () => {
        // Only the connections. The tenants and users are left in place: each
        // run's slugs are unique, and `resetDatabase` truncates them for the
        // next shard — deleting an audit parent here would need its audit rows
        // cleared first, for no benefit (#3343).
        await prisma.userCalendarConnection.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.$disconnect();
    });

    it('a saved token is a v2 ciphertext under the tenant DEK, and reads back', async () => {
        const { tenant, user, ctx } = await fixture('save');
        await saveCalendarConnection(ctx, { provider: 'google-calendar', token: TOKEN, scopesGranted: ['x'] });

        const raw = await stored(tenant.id, user.id);
        expect(raw.startsWith('v2:')).toBe(true);
        expect(raw).not.toContain('fixture-refresh');
        const dek = await getTenantDek(tenant.id);
        expect(JSON.parse(decryptWithKey(dek, raw))).toEqual(TOKEN);

        expect((await readCalendarToken(ctx, 'google-calendar'))?.token).toEqual(TOKEN);
    }, 30_000);

    it('a pre-move v1 row still reads, and its next write moves it onto the tenant key', async () => {
        const { tenant, user, ctx } = await fixture('legacy');
        await saveCalendarConnection(ctx, { provider: 'outlook-calendar', token: TOKEN, scopesGranted: [] });
        // What the usecase wrote before #5937: the global key.
        await prisma.$executeRawUnsafe(
            `UPDATE "UserCalendarConnection" SET "tokenEncrypted" = $1 WHERE "tenantId" = $2`,
            encryptField(JSON.stringify(TOKEN)),
            tenant.id,
        );
        expect((await stored(tenant.id, user.id)).startsWith('v1:')).toBe(true);

        expect((await readCalendarToken(ctx, 'outlook-calendar'))?.token).toEqual(TOKEN);

        await updateCalendarToken(ctx, 'outlook-calendar', ROTATED);
        const raw = await stored(tenant.id, user.id);
        expect(raw.startsWith('v2:')).toBe(true);
        expect(JSON.parse(decryptWithKey(await getTenantDek(tenant.id), raw))).toEqual(ROTATED);
    }, 30_000);

    it('the master-KEK sweep re-encrypts a v1 token', async () => {
        const { tenant, user, ctx } = await fixture('kek');
        await saveCalendarConnection(ctx, { provider: 'google-calendar', token: TOKEN, scopesGranted: [] });
        const v1 = encryptField(JSON.stringify(TOKEN));
        await prisma.$executeRawUnsafe(
            `UPDATE "UserCalendarConnection" SET "tokenEncrypted" = $1 WHERE "tenantId" = $2`,
            v1,
            tenant.id,
        );

        const result = await runKeyRotation({ tenantId: tenant.id, initiatedByUserId: user.id });

        const field = result.perField.find((f) => f.model === 'UserCalendarConnection' && f.field === 'tokenEncrypted');
        expect(field).toEqual(expect.objectContaining({ scanned: 1, rewritten: 1, errors: 0 }));
        const raw = await stored(tenant.id, user.id);
        // Rewritten (a fresh IV), still under the primary KEK, same payload.
        expect(raw).not.toBe(v1);
        expect(JSON.parse(decryptField(raw))).toEqual(TOKEN);
    }, 60_000);

    it('the tenant-DEK sweep re-encrypts a v2 token under the new DEK', async () => {
        const { tenant, user } = await fixture('dek');
        const oldDek = await getTenantDek(tenant.id);
        // A row written under the tenant's CURRENT key, then the DEK swapped —
        // the state `rotateTenantDek` leaves for the sweep.
        await prisma.userCalendarConnection.create({
            data: {
                tenantId: tenant.id,
                userId: user.id,
                provider: 'google-calendar',
                tokenEncrypted: encryptWithKey(oldDek, JSON.stringify(TOKEN)),
                scopesGranted: [],
            },
        });
        const newDek = generateDek();
        await prisma.tenant.update({
            where: { id: tenant.id },
            data: { encryptedDek: wrapDek(newDek), previousEncryptedDek: wrapDek(oldDek) },
        });

        const result = await runTenantDekRotation({ tenantId: tenant.id, initiatedByUserId: user.id });

        expect(result.totalErrors).toBe(0);
        const raw = await stored(tenant.id, user.id);
        expect(() => decryptWithKey(oldDek, raw)).toThrow();
        expect(JSON.parse(decryptWithKey(newDek, raw))).toEqual(TOKEN);
    }, 60_000);
});
