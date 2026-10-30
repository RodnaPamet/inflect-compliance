/**
 * The migration that gives existing API keys the findings scopes, run from the
 * migration file itself against a real database (#4535).
 *
 * Owner decision, 2026-10-30: findings gain their own keys, and every API key
 * that exists keeps EXACTLY the findings access it had. Until now the findings
 * routes checked only the coarse tier a key's scopes imply, so the property
 * pinned here is that one, read through the real auth code: after the
 * migration, `scopesToPermissions(scopes).findings` grants what
 * `keyAuthorityFromScopes(scopesBefore).permissions` granted — read for every
 * key, create and edit for one whose scopes made it a writer.
 *
 * Also pinned: a `*` key, a revoked key and a non-array blob are not touched;
 * no scope is added twice; every scope the migration writes is one
 * `validateScopes` accepts; and a second run changes nothing in the table.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { hashForLookup } from '@/lib/security/encryption';
import { keyAuthorityFromScopes, scopesToPermissions, validateScopes } from '@/lib/auth/api-key-auth';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const MIGRATION = path.resolve(
    __dirname,
    '../../prisma/migrations/20261030120000_findings_scopes_for_existing_api_keys/migration.sql',
);

/** The migration's statements, comments stripped, in order. Asserted to be two. */
function migrationStatements(): string[] {
    const statements = readFileSync(MIGRATION, 'utf8')
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    expect(statements).toHaveLength(2);
    return statements;
}

describeFn('findings scopes for existing API keys (migration, real DB)', () => {
    let prisma: PrismaClient;
    const tag = `fkmig-${randomUUID().slice(0, 8)}`;
    const tenantId = `${tag}-t`;
    let userId: string;

    type Seed = { scopes: unknown; revoked?: boolean };
    const SEEDS: Record<string, Seed> = {
        'controls-read': { scopes: ['controls:read'] },
        'controls-write': { scopes: ['controls:read', 'controls:write'] },
        'resource-star': { scopes: ['vendors:*'] },
        'admin-group-only': { scopes: ['incidents:admin'] },
        'mcp-only': { scopes: ['mcp:read'] },
        'already-read': { scopes: ['findings:read', 'controls:write'] },
        star: { scopes: ['*'] },
        revoked: { scopes: ['controls:write'], revoked: true },
        'not-an-array': { scopes: { controls: 'read' } },
    };
    const MIGRATED = ['controls-read', 'controls-write', 'resource-star', 'admin-group-only', 'mcp-only', 'already-read'];
    const UNTOUCHED = ['star', 'revoked', 'not-an-array'];
    const ids: Record<string, string> = {};

    async function scopesOf(key: string): Promise<unknown> {
        const row = await prisma.tenantApiKey.findUniqueOrThrow({ where: { id: ids[key] }, select: { scopes: true } });
        return row.scopes;
    }

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        const email = `${tag}@findings-key-migration.test`;
        userId = (await prisma.user.create({ data: { email, emailHash: hashForLookup(email) } })).id;
        for (const [key, s] of Object.entries(SEEDS)) {
            const row = await prisma.tenantApiKey.create({
                data: {
                    tenantId,
                    name: `${tag} ${key}`,
                    keyPrefix: key.slice(0, 8),
                    keyHash: `${tag}-${key}`,
                    scopes: s.scopes as never,
                    createdById: userId,
                    revokedAt: s.revoked ? new Date() : null,
                },
            });
            ids[key] = row.id;
        }
    });

    afterAll(async () => {
        await prisma.tenantApiKey.deleteMany({ where: { tenantId } });
        if (userId) await prisma.user.deleteMany({ where: { id: userId } });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
        await prisma.$disconnect();
    });

    it('each live key keeps exactly the findings access its coarse tier gave, and a second run changes nothing', async () => {
        const statements = migrationStatements();
        const before: Record<string, unknown> = {};
        for (const key of Object.keys(SEEDS)) before[key] = await scopesOf(key);

        for (const statement of statements) await prisma.$executeRawUnsafe(statement);

        for (const key of MIGRATED) {
            const was = before[key] as string[];
            const now = (await scopesOf(key)) as string[];
            // What the routes used to check: the coarse tier the old scopes implied.
            const coarse = keyAuthorityFromScopes(was).permissions;
            expect({ key, findings: scopesToPermissions(now).findings }).toEqual({
                key,
                findings: { view: coarse.canRead, create: coarse.canWrite, edit: coarse.canWrite },
            });
            // Additive only, nothing twice, and nothing the key cannot carry.
            expect(now.slice(0, was.length)).toEqual(was);
            expect(new Set(now).size).toBe(now.length);
            expect({ key, errors: validateScopes(now) }).toEqual({ key, errors: [] });
        }

        for (const key of UNTOUCHED) {
            expect({ key, scopes: await scopesOf(key) }).toEqual({ key, scopes: before[key] });
        }

        // A second run is a no-op across the whole table, not just these rows.
        for (const statement of statements) {
            expect(await prisma.$executeRawUnsafe(statement)).toBe(0);
        }
    });

    it('a `*` key needs no scope: it already holds every findings key', () => {
        expect(scopesToPermissions(SEEDS.star.scopes as string[]).findings).toEqual({ view: true, create: true, edit: true });
    });
});
