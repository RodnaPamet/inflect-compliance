/**
 * The turn-caps migration clears every stored workspace delegation cap of 3 —
 * and nothing else — in the same migration that relaxes the column (#4594).
 *
 * `TenantSecuritySettings.agentMaxSubagentsPerTurn` had no writer from #3473
 * until this change, so every stored 3 is the 20261015060000 default, not a
 * workspace's choice. Left in place, it would sit under every organization
 * ceiling, and raising the org's delegation ceiling would reach no workspace.
 * Cleared later, by a second deploy, it could no longer be told from a
 * workspace that saved 3 on purpose. So the clearing is HERE, and this test
 * runs that statement from the migration file against real rows: a 3 becomes
 * NULL ("follow the organization"), every other value is untouched, and a
 * second run changes nothing.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const MIGRATION = path.resolve(
    __dirname,
    '../../prisma/migrations/20261113120000_org_agent_turn_caps/migration.sql',
);

/** The migration's one UPDATE, comments stripped. Asserted to be exactly one. */
function clearingStatement(): string {
    const updates = readFileSync(MIGRATION, 'utf8')
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => /^UPDATE\b/i.test(s));
    expect(updates).toHaveLength(1);
    return updates[0];
}

describeFn('org turn caps migration: the stored default 3s are cleared (real DB)', () => {
    let prisma: PrismaClient;
    const suite = `otcm-${randomUUID().slice(0, 8)}`;
    const tenants = { three: `${suite}-three`, zero: `${suite}-zero`, five: `${suite}-five`, unset: `${suite}-unset` };

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        const seed: Array<[string, number | null]> = [
            [tenants.three, 3],
            [tenants.zero, 0],
            [tenants.five, 5],
            [tenants.unset, null],
        ];
        for (const [id, value] of seed) {
            await prisma.tenant.create({ data: { id, name: id, slug: id } });
            await prisma.tenantSecuritySettings.create({ data: { tenantId: id } });
            await prisma.$executeRaw`
                UPDATE "TenantSecuritySettings" SET "agentMaxSubagentsPerTurn" = ${value} WHERE "tenantId" = ${id}`;
        }
    });

    afterAll(async () => {
        const ids = Object.values(tenants);
        await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: { in: ids } } });
        await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
        await prisma.$disconnect();
    });

    async function stored(): Promise<Record<string, number | null>> {
        const rows = await prisma.tenantSecuritySettings.findMany({
            where: { tenantId: { in: Object.values(tenants) } },
            select: { tenantId: true, agentMaxSubagentsPerTurn: true },
        });
        return Object.fromEntries(rows.map((r) => [r.tenantId, r.agentMaxSubagentsPerTurn]));
    }

    it('turns a 3 into NULL and leaves 0, 5 and NULL alone; a second run changes nothing', async () => {
        const statement = clearingStatement();
        await prisma.$executeRawUnsafe(statement);
        const after = await stored();
        expect(after).toEqual({
            [tenants.three]: null,
            [tenants.zero]: 0,
            [tenants.five]: 5,
            [tenants.unset]: null,
        });

        const again = await prisma.$executeRawUnsafe(statement);
        expect(again).toBe(0);
        expect(await stored()).toEqual(after);
    });

    it('leaves the column nullable with no default, so a new row follows the organization', async () => {
        const id = `${suite}-new`;
        await prisma.tenant.create({ data: { id, name: id, slug: id } });
        try {
            const row = await prisma.tenantSecuritySettings.create({ data: { tenantId: id } });
            expect(row.agentMaxSubagentsPerTurn).toBeNull();
        } finally {
            await prisma.tenantSecuritySettings.deleteMany({ where: { tenantId: id } });
            await prisma.tenant.deleteMany({ where: { id } });
        }
    });
});
