/**
 * AN EDIT THAT DOES NOT TOUCH THE SECRET MUST NOT WIPE IT (#3867).
 *
 * The contract spans two halves that have to agree, and neither was tested:
 *
 *   CLIENT  `admin/integrations/page.tsx:197` — "Only send secrets if any field
 *           has a value". An untouched secret field means the POST body carries
 *           no `secrets` key at all.
 *   SERVER  `usecases/integrations.ts:355` — `secretEncrypted` is preserved when
 *           the caller sends no secrets.
 *
 * If either half breaks, renaming a connection silently destroys its credential
 * and nothing says so until the next sync fails with an auth error that points
 * at the far end rather than at us. This file holds the SERVER half.
 *
 * The assertion is byte-identity of the stored ciphertext, not just "it still
 * decrypts". Field encryption is randomised per write, so a re-encrypt of the
 * same plaintext produces different bytes while decrypting identically — that
 * would pass a decrypt-only check and would mean the row had been rewritten,
 * which is the thing being ruled out.
 */
import { randomUUID } from 'node:crypto';

import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { decryptField } from '@/lib/security/encryption';
import { generateAndWrapDek } from '@/lib/security/tenant-keys';
import { upsertIntegrationConnection } from '@/app-layer/usecases/integrations';
import type { RequestContext } from '@/app-layer/types';

const prisma = prismaTestClient();
const SUITE = `secret-keep-${randomUUID().slice(0, 8)}`;
const TENANT = `${SUITE}-tenant`;
const USER = `${SUITE}-user`;
const SECRET = 'Bearer keep-me-across-edits-7b21'; // pragma: allowlist secret — a fixture; the point is that it SURVIVES

const ctx = (): RequestContext =>
    ({
        requestId: randomUUID(),
        userId: USER,
        tenantId: TENANT,
        role: 'ADMIN',
        permissions: { canRead: true, canWrite: true, canAdmin: true, canAudit: true },
        appPermissions: {},
    }) as unknown as RequestContext;

beforeAll(async () => {
    await prisma.user.create({ data: { id: USER, email: `${USER}@example.test`, name: USER } });
    const { wrapped } = generateAndWrapDek();
    await prisma.tenant.create({
        data: { id: TENANT, name: TENANT, slug: TENANT, encryptedDek: wrapped },
    });
    // ADMIN, not OWNER: the last-OWNER trigger refuses the teardown delete of a
    // tenant's only OWNER, and the FK from TenantMembership is not a cascade.
    await prisma.tenantMembership.create({
        data: { tenantId: TENANT, userId: USER, role: 'ADMIN', status: 'ACTIVE' },
    });
});

afterAll(async () => {
    await deleteAuditRowsForTenants(prisma, [TENANT]);
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.deleteMany({ where: { id: TENANT } });
    await prisma.user.deleteMany({ where: { id: USER } });
});

describe('an edit with no secrets preserves the stored one', () => {
    it('keeps the ciphertext BYTE-IDENTICAL when the edit omits secrets', async () => {
        const created = await upsertIntegrationConnection(ctx(), {
            provider: 'mcp-server',
            name: 'before rename',
            configJson: { url: 'https://stub.example.test/mcp' },
            secrets: { authorization: SECRET },
        });
        const before = await prisma.integrationConnection.findUniqueOrThrow({
            where: { id: created.id },
        });
        expect(before.secretEncrypted).toBeTruthy();

        // The shape the form sends for a rename: id, provider, name, configJson —
        // and NO `secrets` key, because no secret field was touched.
        await upsertIntegrationConnection(ctx(), {
            id: created.id,
            provider: 'mcp-server',
            name: 'after rename',
            configJson: { url: 'https://stub.example.test/mcp' },
        });

        const after = await prisma.integrationConnection.findUniqueOrThrow({
            where: { id: created.id },
        });
        expect(after.name).toBe('after rename');
        // BYTE-IDENTICAL, not merely still-decryptable: encryption is randomised,
        // so a re-encrypt of the same plaintext would decrypt correctly and still
        // mean the row was rewritten.
        expect(after.secretEncrypted).toBe(before.secretEncrypted);
        expect(JSON.parse(decryptField(after.secretEncrypted!))).toEqual({
            authorization: SECRET,
        });
    });

    it('REPLACES the secret when the edit does send one', async () => {
        // The discriminating control. Without it, a usecase that ignored
        // `secrets` entirely on update would pass the test above.
        const created = await upsertIntegrationConnection(ctx(), {
            provider: 'mcp-server',
            name: 'rotating',
            configJson: { url: 'https://stub.example.test/mcp' },
            secrets: { authorization: SECRET },
        });
        const before = await prisma.integrationConnection.findUniqueOrThrow({
            where: { id: created.id },
        });

        const rotated = 'Bearer rotated-value-3c9f'; // pragma: allowlist secret — a fixture
        await upsertIntegrationConnection(ctx(), {
            id: created.id,
            provider: 'mcp-server',
            name: 'rotating',
            configJson: { url: 'https://stub.example.test/mcp' },
            secrets: { authorization: rotated },
        });

        const after = await prisma.integrationConnection.findUniqueOrThrow({
            where: { id: created.id },
        });
        expect(after.secretEncrypted).not.toBe(before.secretEncrypted);
        expect(JSON.parse(decryptField(after.secretEncrypted!))).toEqual({
            authorization: rotated,
        });
    });

    it('OVERWRITES with an empty string when sent one — which is why the client guard matters', async () => {
        /**
         * The behaviour, asserted rather than hedged.
         *
         * The first version of this test asserted
         * `stored.authorization === SECRET || stored.authorization === ''`,
         * which passes whichever happens and therefore says nothing — the same
         * inexpressive-assertion defect this suite's siblings exist to catch.
         *
         * What actually happens: `integrations.ts:308` gates on
         * `Object.keys(input.secrets).length > 0`, and `{ authorization: '' }`
         * HAS a key. So it validates, encrypts and overwrites. A usable
         * credential becomes an empty string, which is the same outage as
         * deleting it.
         *
         * That is not a defect in the usecase — it cannot distinguish "the
         * operator cleared this field" from "the form sent its empty default".
         * It is why the CLIENT guard is load-bearing: `page.tsx:197` builds
         * `formSecrets` from every declared field, so an untouched form is
         * `{ authorization: '' }`, and its `hasSecrets` check is the only thing
         * standing between renaming a connection and destroying its
         * credential. Pinned here so that if the server ever starts ignoring
         * empty strings, whoever changes it sees that the client relies on the
         * current behaviour.
         */
        const created = await upsertIntegrationConnection(ctx(), {
            provider: 'mcp-server',
            name: 'empty-strings',
            configJson: { url: 'https://stub.example.test/mcp' },
            secrets: { authorization: SECRET },
        });
        const before = await prisma.integrationConnection.findUniqueOrThrow({
            where: { id: created.id },
        });

        await upsertIntegrationConnection(ctx(), {
            id: created.id,
            provider: 'mcp-server',
            name: 'empty-strings',
            configJson: { url: 'https://stub.example.test/mcp' },
            secrets: { authorization: '' },
        });

        const after = await prisma.integrationConnection.findUniqueOrThrow({
            where: { id: created.id },
        });
        expect(after.secretEncrypted).not.toBe(before.secretEncrypted);
        expect(JSON.parse(decryptField(after.secretEncrypted!))).toEqual({ authorization: '' });
    });
});
