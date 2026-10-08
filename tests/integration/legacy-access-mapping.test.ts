/**
 * Saving a legacy access mapping: validated, versioned, audited.
 *
 * The denylist assertions here are the load-bearing ones. Refusing a denied
 * column at SAVE is what keeps it from ever being REQUESTED — the `?fields=`
 * projection is derived from the mapping — so this is the boundary, and the
 * ingestion check is the backstop for a server that volunteers one anyway.
 */
import { PrismaClient } from '@prisma/client';

import { prismaTestClient, resetDatabase } from '../helpers/db';
import { makeRequestContext } from '../helpers/make-context';
import {
    getLegacyAccessMapping,
    readStoredMapping,
    saveLegacyAccessMapping,
} from '@/app-layer/usecases/legacy-access-mapping';
import { adoptUsernameConvention } from '@/app-layer/usecases/legacy-username-convention';
import { computeColumnSetFingerprint } from '@/lib/legacy-access/canonical';

const prisma: PrismaClient = prismaTestClient();
const TENANT = 'lgm-tenant';
const COLUMNS = ['LOGIN', 'EMAIL_ADDR', 'DISPLAY_NAME', 'STATUS', 'ROLE_1'];
const FP = computeColumnSetFingerprint(COLUMNS);

const ctx = () => makeRequestContext('OWNER', { tenantId: TENANT });

let connectionId: string;

const input = (over: Record<string, unknown> = {}) => ({
    connectionId,
    fields: { accountKey: 'LOGIN', email: 'EMAIL_ADDR' },
    entitlements: { kind: 'wide' as const, columns: ['ROLE_1'] },
    columnSetFingerprint: FP,
    ...over,
});

beforeAll(async () => {
    await resetDatabase(prisma);
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
    await prisma.tenant.upsert({
        where: { id: TENANT },
        update: {},
        create: { id: TENANT, name: 'Mapping Tenant', slug: TENANT },
    });
    // The audit writer inserts `userId` with an FK to `User`, so a context with a
    // userId that has no row fails the write — not the usecase's fault, and the
    // reason the pull test did not hit it: a job context carries no user.
    // `makeRequestContext` defaults to 'user-1'.
    await prisma.user.upsert({
        where: { id: 'user-1' },
        update: {},
        create: { id: 'user-1', email: 'mapper@lgm.test', name: 'Mapper' },
    });
});

beforeEach(async () => {
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
    const conn = await prisma.integrationConnection.create({
        data: { tenantId: TENANT, provider: 'legacy-mcp', name: 'legacy', configJson: {} },
    });
    connectionId = conn.id;
});

afterAll(async () => {
    await prisma.integrationConnection.deleteMany({ where: { tenantId: TENANT } });
    await prisma.$disconnect();
});

describe('saving a mapping', () => {
    it('stores version 1 with the fingerprint it was confirmed against', async () => {
        const saved = await saveLegacyAccessMapping(ctx(), input());
        expect(saved.version).toBe(1);
        expect(saved.columnSetFingerprint).toBe(FP);
        const read = await getLegacyAccessMapping(ctx(), connectionId);
        expect(read?.version).toBe(1);
    });

    it('increments the version on a real change', async () => {
        await saveLegacyAccessMapping(ctx(), input());
        const second = await saveLegacyAccessMapping(ctx(), input({
            fields: { accountKey: 'LOGIN', email: 'EMAIL_ADDR', displayName: 'DISPLAY_NAME' },
        }));
        expect(second.version).toBe(2);
    });

    it('is a NO-OP on an identical re-save — no version bump, no audit row', async () => {
        // Version numbers that advance without a change make the history harder to
        // read, and an audit trail of non-events trains people to skip it.
        await saveLegacyAccessMapping(ctx(), input());
        const before = await prisma.auditLog.count({
            where: { tenantId: TENANT, action: 'LEGACY_ACCESS_MAPPING_SAVED' },
        });
        const again = await saveLegacyAccessMapping(ctx(), input());
        expect(again.version).toBe(1);
        const after = await prisma.auditLog.count({
            where: { tenantId: TENANT, action: 'LEGACY_ACCESS_MAPPING_SAVED' },
        });
        expect(after).toBe(before);
    });

    it('writes an audit row naming the columns, the version and the projection', async () => {
        await saveLegacyAccessMapping(ctx(), input());
        const row = await prisma.auditLog.findFirstOrThrow({
            where: { tenantId: TENANT, action: 'LEGACY_ACCESS_MAPPING_SAVED' },
            orderBy: { createdAt: 'desc' },
        });
        const details = row.detailsJson as Record<string, unknown>;
        expect(details.version).toBe(1);
        expect(details.columnSetFingerprint).toBe(FP);
        // Column NAMES are schema metadata an administrator typed. No cell value
        // can appear — this usecase never reads a row.
        expect(details.fields).toEqual({ accountKey: 'LOGIN', email: 'EMAIL_ADDR' });
        expect(details.projection).toEqual(['EMAIL_ADDR', 'LOGIN', 'ROLE_1']);
    });
});

describe('refusals at save time', () => {
    it('refuses a mapping with no accountKey', async () => {
        await expect(saveLegacyAccessMapping(ctx(), input({ fields: { email: 'EMAIL_ADDR' } })))
            .rejects.toThrow(/accountKey is not mapped/);
    });

    it('refuses a key-only mapping', async () => {
        await expect(saveLegacyAccessMapping(ctx(), input({ fields: { accountKey: 'LOGIN' } })))
            .rejects.toThrow(/no identity-bearing field/);
    });

    it('refuses a DENYLISTED column, so it is never requested', async () => {
        await expect(
            saveLegacyAccessMapping(ctx(), input({
                fields: { accountKey: 'LOGIN', email: 'EMAIL_ADDR', title: 'PASSWORD_HASH' },
            }))
        ).rejects.toThrow(/never-request denylist/);
    });

    it('refuses a denylisted ENTITLEMENT column too', async () => {
        await expect(
            saveLegacyAccessMapping(ctx(), input({
                entitlements: { kind: 'long' as const, column: 'API_TOKEN' },
            }))
        ).rejects.toThrow(/never-request denylist/);
    });

    it('refuses one column mapped to two canonical fields', async () => {
        await expect(
            saveLegacyAccessMapping(ctx(), input({
                fields: { accountKey: 'LOGIN', email: 'ID', employeeNumber: 'ID' },
            }))
        ).rejects.toThrow(/more than one canonical field/);
    });

    it('stores NOTHING when it refuses', async () => {
        await expect(saveLegacyAccessMapping(ctx(), input({ fields: { email: 'E' } })))
            .rejects.toThrow();
        const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        expect(readStoredMapping(conn.configJson)).toBeNull();
    });

    it('reports EVERY problem at once', async () => {
        // An administrator fixing a form one error at a time is being made to
        // rediscover the requirement list by trial.
        // Three separate assertions rather than one regex with an any-char span
        // between the pieces: a span re-forms across whatever happens to sit
        // between them, so deleting one of the three problems would leave the
        // assertion satisfied by its neighbours.
        let message = '';
        try {
            await saveLegacyAccessMapping(ctx(), input({ fields: { department: 'PASSWORD' } }));
        } catch (e) {
            message = e instanceof Error ? e.message : String(e);
        }
        expect(message).toContain('accountKey is not mapped');
        expect(message).toContain('no identity-bearing field is mapped');
        expect(message).toContain('never-request denylist');
    });
});

describe('coexistence with the username convention (#3315)', () => {
    it('a mapping save preserves a convention already in configJson', async () => {
        // Both live under the same `configJson`, so a bare write would delete the
        // other. And both keys must be declared in CONFIG_FIELD_RULES or the
        // validator throws — which is the regression Step 1c shipped.
        await adoptUsernameConvention(ctx(), { connectionId, template: '{first}{last}' });
        await saveLegacyAccessMapping(ctx(), input());
        const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        const cfg = conn.configJson as Record<string, unknown>;
        expect(cfg.legacyUsernameConvention).toBeTruthy();
        expect(cfg.legacyAccessMapping).toBeTruthy();
    });

    it('a convention adoption preserves an existing mapping', async () => {
        await saveLegacyAccessMapping(ctx(), input());
        await adoptUsernameConvention(ctx(), { connectionId, template: '{f}.{last}' });
        const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } });
        const cfg = conn.configJson as Record<string, unknown>;
        expect(cfg.legacyAccessMapping).toBeTruthy();
        expect(readStoredMapping(conn.configJson)?.version).toBe(1);
    });

    it('adopting a convention on a legacy-mcp connection does not 400 — the regression itself', async () => {
        // Before the CONFIG_FIELD_RULES declaration landed, this threw
        // "Unknown configuration field for legacy-mcp: legacyUsernameConvention".
        await expect(
            adoptUsernameConvention(ctx(), { connectionId, template: '{first}_{last}' })
        ).resolves.toMatchObject({ version: 1, template: '{first}_{last}' });
    });
});

describe('readStoredMapping', () => {
    it('reads a malformed stored value as ABSENT rather than throwing', async () => {
        // The pull turns an absent mapping into a named MAPPING_MISSING refusal on
        // a row an operator can see; a throw would surface as an unhandled job
        // error with no snapshot to look at.
        expect(readStoredMapping({ legacyAccessMapping: { version: 'not a number' } })).toBeNull();
        expect(readStoredMapping({})).toBeNull();
        expect(readStoredMapping(null)).toBeNull();
    });
});
