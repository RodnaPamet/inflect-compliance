/**
 * An integration's credentials survive a master-key rotation (#5942).
 *
 * `IntegrationConnection.secretEncrypted` is sealed with `encryptField` (the
 * master key, `v1:`) outside the encryption manifest. Before #5942 the
 * rotation walked only the manifest and the PII columns, so it never moved
 * these rows, its "zero v1 rows left" report said nothing about them, and the
 * runbook's last step (retiring `DATA_ENCRYPTION_KEY_PREVIOUS`) made every
 * integration's credentials unreadable.
 *
 * This runs the real rotation across a real key swap: seal under key A, make B
 * the primary with A as the previous key, rotate, then retire A. The rotated
 * tenant's secret still reads; a second tenant's, which was NOT rotated, does
 * not, which proves the swap in this test is real rather than a no-op.
 */
import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { createTenantWithDek, _resetTenantDekCache } from '@/lib/security/tenant-key-manager';
import { decryptField, encryptField, hashForLookup, _resetKeyCache } from '@/lib/security/encryption';
import { runKeyRotation } from '@/app-layer/jobs/key-rotation';

const d = DB_AVAILABLE ? describe : describe.skip;

// Throwaway key material for a test database; never a real key.
const KEY_A = 'integration-secret-rotation-test-key-a-000000000000'; // pragma: allowlist secret
const KEY_B = 'integration-secret-rotation-test-key-b-111111111111'; // pragma: allowlist secret
const SECRET = { apiKey: 'fixture-api-key', clientSecret: 'fixture-client-secret' }; // pragma: allowlist secret

d('IntegrationConnection.secretEncrypted — master-key rotation', () => {
    const prisma = prismaTestClient();
    const saved = {
        primary: process.env.DATA_ENCRYPTION_KEY,
        previous: process.env.DATA_ENCRYPTION_KEY_PREVIOUS,
        lookup: process.env.LOOKUP_HASH_KEY,
    };
    const tenantIds: string[] = [];

    function useKeys(primary: string, previous?: string) {
        process.env.DATA_ENCRYPTION_KEY = primary;
        if (previous) process.env.DATA_ENCRYPTION_KEY_PREVIOUS = previous;
        else delete process.env.DATA_ENCRYPTION_KEY_PREVIOUS;
        _resetKeyCache();
        _resetTenantDekCache();
    }

    function restore(name: 'DATA_ENCRYPTION_KEY' | 'DATA_ENCRYPTION_KEY_PREVIOUS' | 'LOOKUP_HASH_KEY', value: string | undefined) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }

    async function workspaceWithSecret(label: string) {
        const slug = `kek-int-${label}-${Date.now()}`;
        const tenant = await createTenantWithDek({ name: slug, slug });
        tenantIds.push(tenant.id);
        const email = `${slug}@example.test`;
        const user = await prisma.user.create({ data: { email, emailHash: hashForLookup(email), name: label } });
        // What every writer of the column wrote before #5969, and what
        // `sealTenantSecret` still writes while its brake is off.
        const connection = await prisma.integrationConnection.create({
            data: {
                tenantId: tenant.id,
                provider: 'okta',
                name: label,
                secretEncrypted: encryptField(JSON.stringify(SECRET)),
            },
        });
        return { tenant, user, connection };
    }

    async function storedSecret(connectionId: string): Promise<string> {
        const rows = (await prisma.$queryRawUnsafe(
            `SELECT "secretEncrypted" FROM "IntegrationConnection" WHERE id = $1`,
            connectionId,
        )) as Array<{ secretEncrypted: string }>;
        return rows[0].secretEncrypted;
    }

    beforeAll(() => {
        // Pin the lookup hashes to their own key, as the runbook's first step
        // does, so swapping the master key does not move them mid-test.
        process.env.LOOKUP_HASH_KEY = KEY_A;
    });

    afterAll(async () => {
        await prisma.integrationConnection.deleteMany({ where: { tenantId: { in: tenantIds } } });
        restore('DATA_ENCRYPTION_KEY', saved.primary);
        restore('DATA_ENCRYPTION_KEY_PREVIOUS', saved.previous);
        restore('LOOKUP_HASH_KEY', saved.lookup);
        _resetKeyCache();
        _resetTenantDekCache();
        await prisma.$disconnect();
    });

    it('rotates the secret, which still reads once the old key is retired', async () => {
        useKeys(KEY_A);
        const rotated = await workspaceWithSecret('rotated');
        const untouched = await workspaceWithSecret('untouched');
        const before = await storedSecret(rotated.connection.id);

        // The operator's rotation: B is primary, A the previous key.
        useKeys(KEY_B, KEY_A);
        const result = await runKeyRotation({ tenantId: rotated.tenant.id, initiatedByUserId: rotated.user.id });

        const field = result.perField.find((f) => f.model === 'IntegrationConnection' && f.field === 'secretEncrypted');
        expect(field).toEqual(expect.objectContaining({ scanned: 1, rewritten: 1, errors: 0 }));
        expect(result.totalErrors).toBe(0);
        const after = await storedSecret(rotated.connection.id);
        expect(after).not.toBe(before);

        // The runbook's last step: retire the previous key.
        useKeys(KEY_B);
        expect(JSON.parse(decryptField(after))).toEqual(SECRET);

        // The control: a workspace the rotation did not visit can no longer
        // read its secret, so the swap above is real.
        const stranded = await storedSecret(untouched.connection.id);
        expect(() => decryptField(stranded)).toThrow();
    }, 60_000);
});
