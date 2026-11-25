/**
 * An integration's credentials under the workspace's own key, and both rotations
 * reach them (#5969, #5942 phase 2).
 *
 * `IntegrationConnection.secretEncrypted` is sealed by `sealTenantSecret`
 * outside the encryption manifest. With the brake on it writes a `v2:` value
 * under the workspace's key; the per-workspace key rotation must rewrite that
 * value, and the master-key rotation must move a workspace's remaining `v1:`
 * values onto its key. With the brake off it still writes `v1:`.
 *
 * The brake is replaced through its leaf module. Everything else is real: a
 * real per-workspace key, the real helpers and both real sweeps against a real
 * database.
 */
let underTenantKey = true;
jest.mock('@/lib/security/tenant-sealed-activation', () => ({
    get TENANT_SEALED_UNDER_TENANT_KEY() {
        return underTenantKey;
    },
}));

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import {
    createTenantWithDek,
    getTenantDek,
    _resetTenantDekCache,
} from '@/lib/security/tenant-key-manager';
import { generateDek, wrapDek } from '@/lib/security/tenant-keys';
import { decryptField, decryptWithKey, encryptField, hashForLookup } from '@/lib/security/encryption';
import { openTenantSecret, sealTenantSecret } from '@/lib/security/tenant-sealed';
import { runKeyRotation } from '@/app-layer/jobs/key-rotation';
import { runTenantDekRotation } from '@/app-layer/jobs/tenant-dek-rotation';

const d = DB_AVAILABLE ? describe : describe.skip;

// Throwaway fixture values written to a temporary workspace; never real credentials.
const SECRET = { apiKey: 'fixture-api-key', clientSecret: 'fixture-client-secret' }; // pragma: allowlist secret

d('IntegrationConnection.secretEncrypted — the workspace key, and both rotations', () => {
    const prisma = prismaTestClient();
    const tenantIds: string[] = [];

    async function workspace(label: string) {
        const slug = `intsec-${label}-${Date.now()}`;
        const tenant = await createTenantWithDek({ name: slug, slug });
        tenantIds.push(tenant.id);
        const email = `${slug}@example.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email), name: label } });
        return { tenant, user };
    }

    async function connectionWith(tenantId: string, secretEncrypted: string) {
        return prisma.integrationConnection.create({
            data: { tenantId, provider: 'okta', name: `conn-${Date.now()}-${Math.random()}`, secretEncrypted },
        });
    }

    async function stored(connectionId: string): Promise<string> {
        const rows = (await prisma.$queryRawUnsafe(
            `SELECT "secretEncrypted" FROM "IntegrationConnection" WHERE id = $1`,
            connectionId,
        )) as Array<{ secretEncrypted: string }>;
        return rows[0].secretEncrypted;
    }

    beforeEach(() => {
        underTenantKey = true;
        _resetTenantDekCache();
    });

    afterAll(async () => {
        // Only the connections: each run's slugs are unique, and
        // `resetDatabase` truncates the tenants and users for the next shard.
        await prisma.integrationConnection.deleteMany({ where: { tenantId: { in: tenantIds } } });
        await prisma.$disconnect();
    });

    it('seals under the workspace key, opens for that workspace only, and still opens a v1 value', async () => {
        const { tenant } = await workspace('seal');
        const other = await workspace('other');

        const sealed = await sealTenantSecret(tenant.id, JSON.stringify(SECRET));
        expect(sealed.startsWith('v2:')).toBe(true);
        expect(JSON.parse(decryptWithKey(await getTenantDek(tenant.id), sealed))).toEqual(SECRET);
        expect(JSON.parse(await openTenantSecret(tenant.id, sealed))).toEqual(SECRET);
        // Another workspace's key does not open it: it fails, it never misreads.
        await expect(openTenantSecret(other.tenant.id, sealed)).rejects.toThrow();

        // A value written before the move, under the master key.
        const legacy = encryptField(JSON.stringify(SECRET));
        expect(JSON.parse(await openTenantSecret(tenant.id, legacy))).toEqual(SECRET);
    }, 30_000);

    it('with the brake off, seals under the master key as before', async () => {
        underTenantKey = false;
        const { tenant } = await workspace('brake');
        const sealed = await sealTenantSecret(tenant.id, JSON.stringify(SECRET));
        expect(sealed.startsWith('v1:')).toBe(true);
        expect(JSON.parse(decryptField(sealed))).toEqual(SECRET);
    }, 30_000);

    it('the per-workspace key rotation rewrites the secret under the new key', async () => {
        const { tenant, user } = await workspace('dek');
        const oldDek = await getTenantDek(tenant.id);
        const connection = await connectionWith(tenant.id, await sealTenantSecret(tenant.id, JSON.stringify(SECRET)));

        // The state `rotateTenantDek` leaves for the sweep.
        const newDek = generateDek();
        await prisma.tenant.update({
            where: { id: tenant.id },
            data: { encryptedDek: wrapDek(newDek), previousEncryptedDek: wrapDek(oldDek) },
        });
        _resetTenantDekCache();

        // Mid-rotation, before the sweep, the secret still opens: the helper
        // falls back to the previous key.
        expect(JSON.parse(await openTenantSecret(tenant.id, await stored(connection.id)))).toEqual(SECRET);

        const result = await runTenantDekRotation({ tenantId: tenant.id, initiatedByUserId: user.id });

        expect(result.totalErrors).toBe(0);
        const field = result.perField.find((f) => f.model === 'IntegrationConnection' && f.field === 'secretEncrypted');
        expect(field).toEqual(expect.objectContaining({ rewritten: 1, errors: 0 }));
        const raw = await stored(connection.id);
        expect(() => decryptWithKey(oldDek, raw)).toThrow();
        expect(JSON.parse(decryptWithKey(newDek, raw))).toEqual(SECRET);
        _resetTenantDekCache();
        expect(JSON.parse(await openTenantSecret(tenant.id, raw))).toEqual(SECRET);
    }, 60_000);

    it('the master-key rotation moves a v1 secret onto the workspace key', async () => {
        const { tenant, user } = await workspace('kek');
        const v1 = encryptField(JSON.stringify(SECRET));
        const connection = await connectionWith(tenant.id, v1);

        const result = await runKeyRotation({ tenantId: tenant.id, initiatedByUserId: user.id });

        const field = result.perField.find((f) => f.model === 'IntegrationConnection' && f.field === 'secretEncrypted');
        expect(field).toEqual(expect.objectContaining({ scanned: 1, rewritten: 1, errors: 0 }));
        const raw = await stored(connection.id);
        expect(raw.startsWith('v2:')).toBe(true);
        expect(JSON.parse(decryptWithKey(await getTenantDek(tenant.id), raw))).toEqual(SECRET);
    }, 60_000);
});
