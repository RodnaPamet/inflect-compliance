/**
 * The migration that gives every live key holding `audits:read` (or `audits:*`)
 * the `findings:read` scope, run from the migration file itself against a real
 * database (#5409, step 1).
 *
 * `list_findings` and `propose_finding` still check the AUDITS domain on
 * `/api/mcp`: a resource scope of `audits:read`, and for `list_findings` the
 * key's own `audits.view`. Step 2 moves both to the findings domain. #4535's
 * one-time migration gave `findings:read` to every key that existed then, but an
 * agent key minted since for these tools holds `audits:read` and not
 * `findings:read`, so step 2 alone would refuse it the tools it was minted for.
 *
 * The property pinned here is the one step 2 needs, read through the real auth
 * code: every live key that passes today's findings-tool checks
 * (`enforceApiKeyScope(…, 'audits', 'read')` and `audits.view` from its scopes)
 * passes the findings ones after the migration (`'findings', 'read'` and
 * `findings.view`). Also pinned: nothing else about a key's findings access
 * moves (no `findings:write`); a `*` key, a revoked key, a non-array blob, a key
 * with no audits read, and a key that already reaches findings are not touched;
 * the scope is appended once and is one `validateScopes` accepts; and a second
 * run changes nothing anywhere in the table.
 *
 * Step 2 runs the same statement again (`…_again`), because the connect wizard
 * went on minting `audits:read` keys for these tools until step 2's code
 * deployed. Pinned for it: the statement is step 1's exactly, it migrates a key
 * minted after step 1 ran, and it moves nothing step 1 already migrated.
 */
import { readFileSync } from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

import { DB_AVAILABLE } from './db-helper';
import { prismaTestClient } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import { hashForLookup } from '@/lib/security/encryption';
import { enforceApiKeyScope, scopesToPermissions, validateScopes } from '@/lib/auth/api-key-auth';

const describeFn = DB_AVAILABLE ? describe : describe.skip;
jest.setTimeout(30_000);

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const MIGRATION = path.join(MIGRATIONS, '20261112180000_findings_read_for_audits_read_api_keys/migration.sql');
/** Step 2's re-run, in the deploy that moves the tools (#5409). */
const MIGRATION_AGAIN = path.join(
    MIGRATIONS,
    '20261112230000_findings_read_for_audits_read_api_keys_again/migration.sql',
);

/** A migration's statements, comments stripped. Asserted to be exactly one. */
function migrationStatements(file: string = MIGRATION): string[] {
    const statements = readFileSync(file, 'utf8')
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    expect(statements).toHaveLength(1);
    return statements;
}

/** Whether a key with these scopes passes the scope check for `<resource>:read`. */
function passesScope(scopes: string[], resource: string): boolean {
    try {
        enforceApiKeyScope(makeRequestContext('READER', { apiKeyId: 'k', apiKeyScopes: scopes }), resource, 'read');
        return true;
    } catch {
        return false;
    }
}

/** Whether a key reaches the findings tools under today's (audits) checks. */
function reachesFindingsToolsToday(scopes: string[]): boolean {
    return passesScope(scopes, 'audits') && scopesToPermissions(scopes).audits.view;
}

/** Whether a key reaches them under step 2's (findings) checks. */
function reachesFindingsToolsAfterStep2(scopes: string[]): boolean {
    return passesScope(scopes, 'findings') && scopesToPermissions(scopes).findings.view;
}

describeFn('findings:read for keys holding audits:read (migration, real DB)', () => {
    let prisma: PrismaClient;
    const tag = `frmig-${randomUUID().slice(0, 8)}`;
    const tenantId = `${tag}-t`;
    let userId: string;

    type Seed = { scopes: unknown; revoked?: boolean };
    const SEEDS: Record<string, Seed> = {
        // Minted by the connect wizard for list_findings / propose_finding since #4535.
        'agent-audits-read': { scopes: ['mcp:read', 'audits:read'] },
        'agent-propose': { scopes: ['mcp:read', 'mcp:propose', 'audits:read', 'risks:read'] },
        'audits-star': { scopes: ['mcp:read', 'audits:*'] },
        'audits-read-and-write': { scopes: ['audits:read', 'audits:write', 'controls:write'] },
        // Untouched.
        'already-read': { scopes: ['audits:read', 'findings:read'] },
        'findings-star': { scopes: ['audits:read', 'findings:*'] },
        'audits-write-only': { scopes: ['audits:write'] },
        'workpaper-only': { scopes: ['mcp:read', 'audits:workpaper_view'] },
        'no-audits': { scopes: ['controls:read', 'mcp:read'] },
        star: { scopes: ['*'] },
        'star-and-audits': { scopes: ['*', 'audits:read'] },
        revoked: { scopes: ['mcp:read', 'audits:read'], revoked: true },
        'not-an-array': { scopes: { audits: 'read' } },
    };
    const MIGRATED = ['agent-audits-read', 'agent-propose', 'audits-star', 'audits-read-and-write'];
    const UNTOUCHED = Object.keys(SEEDS).filter((k) => !MIGRATED.includes(k));
    const ids: Record<string, string> = {};

    async function scopesOf(key: string): Promise<unknown> {
        const row = await prisma.tenantApiKey.findUniqueOrThrow({ where: { id: ids[key] }, select: { scopes: true } });
        return row.scopes;
    }

    beforeAll(async () => {
        prisma = prismaTestClient();
        await prisma.$connect();
        await prisma.tenant.create({ data: { id: tenantId, name: tenantId, slug: tenantId } });
        const email = `${tag}@findings-read-migration.test`;
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

    it('every live key that reaches the findings tools today still reaches them under step 2, and nothing else moves', async () => {
        const statements = migrationStatements();
        const before: Record<string, unknown> = {};
        for (const key of Object.keys(SEEDS)) before[key] = await scopesOf(key);

        // The seeds are the population the step exists for: without the
        // migration, these keys would be refused once step 2 lands.
        for (const key of MIGRATED) {
            const was = before[key] as string[];
            expect({ key, today: reachesFindingsToolsToday(was), step2: reachesFindingsToolsAfterStep2(was) })
                .toEqual({ key, today: true, step2: false });
        }

        for (const statement of statements) await prisma.$executeRawUnsafe(statement);

        for (const key of MIGRATED) {
            const was = before[key] as string[];
            const now = (await scopesOf(key)) as string[];
            expect({ key, step2: reachesFindingsToolsAfterStep2(now) }).toEqual({ key, step2: true });
            // Exactly `findings:read` appended: no write, nothing twice, nothing invalid.
            expect(now).toEqual([...was, 'findings:read']);
            expect(scopesToPermissions(now).findings).toEqual({
                ...scopesToPermissions(was).findings,
                view: true,
            });
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

    it('step 2 runs the same statement again: it migrates a key minted after step 1, and moves nothing else', async () => {
        const again = migrationStatements(MIGRATION_AGAIN);
        expect(again).toEqual(migrationStatements());

        // Runs after the case above, so step 1 has already run over the seeds.
        // A key the connect wizard minted for the findings tools between the
        // two deploys holds `audits:read` and not `findings:read`.
        const between = await prisma.tenantApiKey.create({
            data: {
                tenantId,
                name: `${tag} minted-between`,
                keyPrefix: 'between',
                keyHash: `${tag}-minted-between`,
                scopes: ['mcp:read', 'mcp:propose', 'audits:read'],
                createdById: userId,
            },
        });
        const tenantScopes = async () =>
            Object.fromEntries(
                (await prisma.tenantApiKey.findMany({ where: { tenantId }, select: { id: true, scopes: true } }))
                    .map((r) => [r.id, r.scopes]),
            );
        const before = await tenantScopes();
        expect(reachesFindingsToolsAfterStep2(before[between.id] as string[])).toBe(false);

        for (const statement of again) await prisma.$executeRawUnsafe(statement);

        const after = await tenantScopes();
        expect(after[between.id]).toEqual(['mcp:read', 'mcp:propose', 'audits:read', 'findings:read']);
        expect(reachesFindingsToolsAfterStep2(after[between.id] as string[])).toBe(true);
        // Every other key, step 1's migrated ones included, is as step 1 left it.
        expect({ ...after, [between.id]: null }).toEqual({ ...before, [between.id]: null });

        // And a second run moves nothing here either.
        for (const statement of again) await prisma.$executeRawUnsafe(statement);
        expect(await tenantScopes()).toEqual(after);
    });

    it('the untouched live keys need nothing: each already reaches findings, or never reached the findings tools', () => {
        for (const key of UNTOUCHED) {
            const s = SEEDS[key];
            if (s.revoked || !Array.isArray(s.scopes)) continue;
            const scopes = s.scopes as string[];
            expect({ key, ok: !reachesFindingsToolsToday(scopes) || reachesFindingsToolsAfterStep2(scopes) })
                .toEqual({ key, ok: true });
        }
    });
});
