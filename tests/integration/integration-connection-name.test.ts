/**
 * Saving an integration connection refuses a name with a control character or
 * a lone surrogate, and leaves a stored label alone (#5317; owner decision
 * 2026-11-15).
 *
 * The usecase is called directly, against a real database, because two of its
 * callers never pass through the route's schema (the A2A peer flow, and the
 * SharePoint consent callback). So the refusal has to hold here too, and what
 * is asserted is the ROW: a refused create stores nothing, a refused update
 * leaves the row as it was, and a row whose name predates the rule can still
 * be read and have its other fields changed.
 */
import { randomUUID } from 'node:crypto';

import { prismaTestClient } from '../helpers/db';
import { deleteAuditRowsForTenants } from '../helpers/audit-cleanup';
import { generateAndWrapDek } from '@/lib/security/tenant-keys';
import {
    listIntegrationConnections,
    upsertIntegrationConnection,
} from '@/app-layer/usecases/integrations';
import type { RequestContext } from '@/app-layer/types';

const prisma = prismaTestClient();
const SUITE = `conn-name-${randomUUID().slice(0, 8)}`;
const TENANT = `${SUITE}-tenant`;
const USER = `${SUITE}-user`;

/**
 * A label stored before the rule: a C0 control and a C1 control. (Not a lone
 * surrogate: UTF-8 cannot carry one, so it never reached a stored row intact.)
 */
const LEGACY_NAME = 'legacy\u0007label\u0085';

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

const rowsInTenant = () => prisma.integrationConnection.findMany({ where: { tenantId: TENANT } });

describe('a refused name stores nothing', () => {
    it.each([
        ['a C0 control', 'Acme\u0000GitHub'],
        ['DEL', 'Acme\u007F'],
        ['a C1 control', 'Acme\u009C'],
        ['a lone high surrogate', 'Acme \uD83D'],
        ['a lone low surrogate', 'Acme \uDE00'],
    ])('a create whose name holds %s is a 400 and writes no row', async (_label, name) => {
        const before = await rowsInTenant();
        await expect(
            upsertIntegrationConnection(ctx(), { provider: 'github', name, configJson: {} }),
        ).rejects.toMatchObject({
            status: 400,
            details: { reason: 'CONNECTION_NAME_INVALID_CHARACTERS' },
        });
        expect(await rowsInTenant()).toHaveLength(before.length);
    });

    it('an update whose name holds one is a 400 and leaves the row as it was', async () => {
        const created = await upsertIntegrationConnection(ctx(), {
            provider: 'github',
            name: 'clean name',
            configJson: {},
            isEnabled: false,
        });
        const before = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: created.id } });

        await expect(
            upsertIntegrationConnection(ctx(), {
                id: created.id,
                provider: 'github',
                name: 'renamed\u001B[31m',
                isEnabled: true,
            }),
        ).rejects.toMatchObject({ status: 400, details: { reason: 'CONNECTION_NAME_INVALID_CHARACTERS' } });

        const after = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: created.id } });
        expect(after.name).toBe('clean name');
        expect(after.isEnabled).toBe(false);
        expect(after.updatedAt).toEqual(before.updatedAt);
    });

    it('takes an emoji, Cyrillic and accented name — the positive control', async () => {
        const name = 'Société Връзка 😀';
        const created = await upsertIntegrationConnection(ctx(), { provider: 'github', name, configJson: {} });
        const row = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: created.id } });
        expect(row.name).toBe(name);
    });
});

describe('a label stored before the rule is left alone', () => {
    async function legacyRow() {
        // Written directly, as a row saved before #5317 would have been.
        return prisma.integrationConnection.create({
            data: {
                tenantId: TENANT,
                provider: 'github',
                name: `${LEGACY_NAME} ${randomUUID().slice(0, 6)}`,
                configJson: {},
                isEnabled: false,
            },
        });
    }

    it('can still be read', async () => {
        const row = await legacyRow();
        const listed = (await listIntegrationConnections(ctx())) as Array<{ id: string; name: string }>;
        expect(listed.find((c) => c.id === row.id)?.name).toBe(row.name);
    });

    it('an update that does not send the name changes the other fields and keeps the name', async () => {
        const row = await legacyRow();
        await upsertIntegrationConnection(ctx(), {
            id: row.id,
            provider: 'github',
            configJson: {},
            isEnabled: true,
        });
        const after = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.isEnabled).toBe(true);
        expect(after.name).toBe(row.name);
    });

    it('an update that renames it to a clean name is taken', async () => {
        const row = await legacyRow();
        await upsertIntegrationConnection(ctx(), {
            id: row.id,
            provider: 'github',
            name: `fixed ${row.id}`,
            isEnabled: false,
        });
        const after = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.name).toBe(`fixed ${row.id}`);
    });

    it('a create still needs a name', async () => {
        await expect(
            upsertIntegrationConnection(ctx(), { provider: 'github', configJson: {} }),
        ).rejects.toMatchObject({ status: 400 });
    });
});
