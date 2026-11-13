/**
 * The container-start recompute moves every stored email hash onto the
 * dedicated LOOKUP_HASH_KEY (#5071), against a real database.
 *
 * Rows are written under the master-derived key first, as every existing row
 * was. Once LOOKUP_HASH_KEY is set, a lookup by email misses them until the
 * recompute runs; after it, the lookup finds them, a second run rewrites
 * nothing, and a tenant system user's fixed `system:` hash is left alone.
 */
import { randomUUID } from 'crypto';
import { DB_AVAILABLE } from './db-helper';
import appPrisma from '@/lib/prisma';
import { _resetKeyCache, hashForLookup } from '@/lib/security/encryption';
import { recomputeLookupHashes } from '@/lib/security/lookup-hash-recompute';
import { ensureTenantSystemUser } from '@/app-layer/context-system';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
const db = appPrisma as unknown as Parameters<typeof recomputeLookupHashes>[0];

const suffix = randomUUID().slice(0, 8);
const EMAIL = `lookup-${suffix}@example.com`;
let tenantId = '';
let userId = '';
let systemUserId = '';
const savedLookup = process.env.LOOKUP_HASH_KEY;

describeFn('recomputing lookup hashes under LOOKUP_HASH_KEY (#5071)', () => {
    beforeAll(async () => {
        delete process.env.LOOKUP_HASH_KEY;
        _resetKeyCache();
        const tenant = await appPrisma.tenant.create({ data: { name: `LH ${suffix}`, slug: `lh-${suffix}` } });
        tenantId = tenant.id;
        const user = await appPrisma.user.create({ data: { email: EMAIL, name: 'Lookup Person' } });
        userId = user.id;
        systemUserId = await ensureTenantSystemUser(tenantId);
    });

    afterAll(async () => {
        if (savedLookup === undefined) delete process.env.LOOKUP_HASH_KEY;
        else process.env.LOOKUP_HASH_KEY = savedLookup;
        _resetKeyCache();
        // The recompute rewrote EVERY row in this worker's database, and later
        // files reuse it: put every hash back under the restored key.
        await recomputeLookupHashes(db);
        if (userId) await appPrisma.user.deleteMany({ where: { id: userId } });
        if (systemUserId) await appPrisma.$executeRaw`DELETE FROM "User" WHERE "id" = ${systemUserId}`;
        if (tenantId) await appPrisma.tenant.deleteMany({ where: { id: tenantId } });
    });

    it('a lookup by email misses until the recompute runs, then finds the account', async () => {
        const legacyHash = hashForLookup(EMAIL);
        const systemBefore = await appPrisma.$queryRaw<{ emailHash: string }[]>`
            SELECT "emailHash" FROM "User" WHERE "id" = ${systemUserId}`;

        process.env.LOOKUP_HASH_KEY = 'k'.repeat(48);
        _resetKeyCache();
        const dedicatedHash = hashForLookup(EMAIL);
        expect(dedicatedHash).not.toBe(legacyHash);
        expect(await appPrisma.user.findUnique({ where: { emailHash: dedicatedHash } })).toBeNull();

        const first = await recomputeLookupHashes(db);
        expect(first.rewritten['User.emailHash']).toBeGreaterThanOrEqual(1);

        const found = await appPrisma.user.findUnique({ where: { emailHash: dedicatedHash }, select: { id: true } });
        expect(found?.id).toBe(userId);

        // The system user's fixed value is not a lookup hash and is left alone.
        const systemAfter = await appPrisma.$queryRaw<{ emailHash: string }[]>`
            SELECT "emailHash" FROM "User" WHERE "id" = ${systemUserId}`;
        expect(systemAfter[0].emailHash).toBe(systemBefore[0].emailHash);
        expect(systemAfter[0].emailHash.startsWith('system:')).toBe(true);
    });

    it('a second run rewrites nothing', async () => {
        const second = await recomputeLookupHashes(db);
        expect(Object.values(second.rewritten).every((n) => n === 0)).toBe(true);
        expect(second.scanned['User.emailHash']).toBeGreaterThanOrEqual(2);
    });
});
